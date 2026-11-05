/**
 * Returns service — full and partial returns.
 * PRD sections 37, 38, 70.
 *
 * Rules
 *   - A return NEVER edits the original sale lines or totals (PRD 38): it is a separate,
 *     auditable record. Only the sale's status flips to RETURNED once every unit has
 *     been given back.
 *   - Eligibility per line = quantity sold - quantity already returned (PRD 37, 64).
 *     "Full return" means "return everything that has not been returned yet", so a
 *     partial return followed by a full return of the remainder works.
 *   - Refund per line uses the ORIGINAL line total (price at the time of sale). It is
 *     computed cumulatively, so several partial returns add up to exactly the line total
 *     (no rounding drift).
 *   - Cost of goods reversed uses the sale-time cost snapshot, so profit reverses
 *     together with revenue.
 *   - Returned goods are put back into stock (PRD 37: "inventory should be updated").
 *     This assumes returned goods are resalable; spoiled returns should additionally be
 *     recorded as waste by the shop. (Documented business assumption.)
 *   - If the sale had part of its total on customer credit, the refund first reduces that
 *     customer debt.
 */

import { eq } from 'drizzle-orm';
import { getDb, getDrizzle, generateReturnNumber, rowOf } from './connection';
import {
  sales,
  saleItems,
  returns,
  returnItems,
  auditLog,
  customerTransactions,
  customers,
} from './schema';
import { incrementForReturn } from './inventoryService';
import { getCurrentRate } from './exchangeRate';
import { lbpToUsdCents, mulDivRound } from '@shared/money/index';
import type { ReturnDTO, ReturnType } from '@shared/types/index';
import {
  ValidationError,
  requireObject,
  requireId,
  requireSafeInt,
  optionalString,
  optionalRange,
  optionalLimit,
} from '@shared/validation/index';

export type { ReturnDTO } from '@shared/types/index';

interface LineState {
  si: typeof saleItems.$inferSelect;
  returnedQty: number;
  refundedSoFar: number;
}

export function createReturn(rawInput: unknown): ReturnDTO {
  const o = requireObject(rawInput, 'Return');
  const originalSaleId = requireId(o.originalSaleId, 'Sale');
  if (o.returnType !== 'FULL' && o.returnType !== 'PARTIAL') {
    throw new ValidationError('Invalid return type');
  }
  const returnType = o.returnType as ReturnType;
  const reason = optionalString(o.reason, 200, 'Reason')?.trim() || null;

  let requested: Array<{ saleItemId: number; quantityReturnedMinor: number }> = [];
  if (returnType === 'PARTIAL') {
    if (!Array.isArray(o.items) || o.items.length === 0) {
      throw new ValidationError('Choose at least one item to return');
    }
    const seen = new Set<number>();
    requested = o.items.map((it, i) => {
      const r = requireObject(it, `Item ${i + 1}`);
      const saleItemId = requireId(r.saleItemId, 'Sale item');
      if (seen.has(saleItemId)) throw new ValidationError('The same item was listed twice');
      seen.add(saleItemId);
      return {
        saleItemId,
        quantityReturnedMinor: requireSafeInt(r.quantityReturnedMinor, 'Return quantity', 1),
      };
    });
  }

  const db = getDb();
  const drizzle = getDrizzle();

  const returnId = db
    .transaction(() => {
      const originalSale = rowOf(sales, db.prepare('SELECT * FROM sales WHERE id = ?').get(originalSaleId));
      if (!originalSale) throw new ValidationError('Original sale not found');
      if (originalSale.status === 'RETURNED') {
        throw new ValidationError('This invoice has already been fully returned');
      }
      if (originalSale.status !== 'COMPLETED') {
        throw new ValidationError(`Cannot return a sale with status ${originalSale.status}`);
      }

      const lineRows = db
        .prepare(
          `SELECT si.*,
                  COALESCE((SELECT SUM(quantity_returned_minor) FROM return_items WHERE sale_item_id = si.id), 0) AS returned_qty,
                  COALESCE((SELECT SUM(refund_line_minor) FROM return_items WHERE sale_item_id = si.id), 0) AS refunded
           FROM sale_items si WHERE si.sale_id = ? ORDER BY si.id`,
        )
        .all(originalSaleId)
        .map((r) => {
          const x = r as { returned_qty: number; refunded: number };
          return { ...rowOf(saleItems, r)!, returned_qty: x.returned_qty, refunded: x.refunded };
        });
      const states = new Map<number, LineState>();
      for (const r of lineRows) {
        states.set(r.id, { si: r, returnedQty: r.returned_qty, refundedSoFar: r.refunded });
      }

      if (returnType === 'FULL') {
        requested = lineRows
          .filter((r) => r.quantityMinor - r.returned_qty > 0)
          .map((r) => ({
            saleItemId: r.id,
            quantityReturnedMinor: r.quantityMinor - r.returned_qty,
          }));
        if (requested.length === 0) {
          throw new ValidationError('Nothing is left to return on this invoice');
        }
      }

      let refundUsdCents = 0;
      let refundLbp = 0;
      let refundUsdEq = 0;
      let costUsd = 0;
      const prepped: Array<{
        saleItemId: number;
        productId: number;
        qty: number;
        refundLine: number;
        currency: string;
      }> = [];

      for (const item of requested) {
        const st = states.get(item.saleItemId);
        if (!st) {
          throw new ValidationError('A selected item does not belong to this invoice');
        }
        const { si } = st;
        const remaining = si.quantityMinor - st.returnedQty;
        if (item.quantityReturnedMinor > remaining) {
          throw new ValidationError(
            `Cannot return more than was sold. Still returnable for "${si.productNameSnapshot}": ${remaining} (in smallest units).`,
          );
        }
        const newReturned = st.returnedQty + item.quantityReturnedMinor;
        const completes = newReturned === si.quantityMinor;

        // Cumulative proportional refund; the last return of a line gets the exact rest.
        const refundAfter = completes
          ? si.lineTotalMinor
          : mulDivRound(newReturned, si.lineTotalMinor, si.quantityMinor);
        const refundLine = Math.max(0, refundAfter - st.refundedSoFar);

        let costLine = 0;
        if (si.lineCostMinor !== null) {
          const before = mulDivRound(st.returnedQty, si.lineCostMinor, si.quantityMinor);
          const after = completes
            ? si.lineCostMinor
            : mulDivRound(newReturned, si.lineCostMinor, si.quantityMinor);
          costLine = Math.max(0, after - before);
        }

        if (si.priceCurrencySnapshot === 'USD') {
          refundUsdCents += refundLine;
          refundUsdEq += refundLine;
          costUsd += costLine;
        } else {
          refundLbp += refundLine;
          // Revenue was booked at the sale's own rate, so reverse it at the same rate.
          refundUsdEq += lbpToUsdCents(refundLine, si.exchangeRateSnapshot);
          costUsd += lbpToUsdCents(costLine, si.exchangeRateSnapshot);
        }

        prepped.push({
          saleItemId: si.id,
          productId: si.productId,
          qty: item.quantityReturnedMinor,
          refundLine,
          currency: si.priceCurrencySnapshot,
        });
        st.returnedQty = newReturned;
        st.refundedSoFar += refundLine;
      }

      const rate = getCurrentRate().currentRate;
      const returnNumber = generateReturnNumber(db);
      const ret = drizzle
        .insert(returns)
        .values({
          returnNumber,
          originalSaleId,
          returnType,
          refundUsdCents,
          refundLbp,
          exchangeRateSnapshot: rate,
          refundUsdEquivalentCents: refundUsdEq,
          costUsdCents: costUsd,
          reason,
        })
        .returning()
        .get();

      for (const p of prepped) {
        drizzle
          .insert(returnItems)
          .values({
            returnId: ret.id,
            saleItemId: p.saleItemId,
            productId: p.productId,
            quantityReturnedMinor: p.qty,
            refundLineMinor: p.refundLine,
            refundCurrency: p.currency,
          })
          .run();
        incrementForReturn(p.productId, p.qty, ret.id);
      }

      const allReturned = [...states.values()].every(
        (st) => st.returnedQty === st.si.quantityMinor,
      );
      if (allReturned) {
        drizzle
          .update(sales)
          .set({ status: 'RETURNED', updatedAt: new Date() })
          .where(eq(sales.id, originalSaleId))
          .run();
      }

      // Refund first cancels any customer debt that came from this sale.
      if (originalSale.creditUsdCents > 0 && originalSale.customerId) {
        const prev = db
          .prepare(
            `SELECT COALESCE(SUM(-amount_usd_cents), 0) AS s FROM customer_transactions
             WHERE sale_id = ? AND transaction_type = 'ADJUSTMENT'`,
          )
          .get(originalSaleId) as { s: number };
        const customer = db
          .prepare('SELECT balance_usd_cents AS balance FROM customers WHERE id = ?')
          .get(originalSale.customerId) as { balance: number } | undefined;
        const reversible = Math.max(0, originalSale.creditUsdCents - prev.s);
        // A refund may only reduce debt that is still outstanding today. The customer
        // may have paid this invoice already (or paid other invoices), so never let a
        // return create a negative balance. Any cash/customer-credit settlement beyond
        // the remaining debt is represented by the return record and must be settled
        // by the shop; V1 does not yet model a separate refund tender.
        const debtReduction = Math.min(reversible, refundUsdEq, Math.max(0, customer?.balance ?? 0));
        if (debtReduction > 0) {
          drizzle
            .insert(customerTransactions)
            .values({
              customerId: originalSale.customerId,
              transactionType: 'ADJUSTMENT',
              amountUsdCents: -debtReduction,
              saleId: originalSaleId,
              exchangeRateSnapshot: rate,
              notes: returnNumber,
            })
            .run();
          db.prepare(
            'UPDATE customers SET balance_usd_cents = balance_usd_cents - ?, updated_at = unixepoch() WHERE id = ? AND balance_usd_cents >= ?',
          ).run(debtReduction, originalSale.customerId, debtReduction);
        }
      }

      drizzle
        .insert(auditLog)
        .values({
          action: 'RETURN',
          entityId: ret.id,
          entityType: 'return',
          payload: JSON.stringify({
            returnNumber,
            originalSaleId,
            returnType,
            refundUsdCents,
            refundLbp,
            refundUsdEq,
            costUsd,
            reason,
          }),
        })
        .run();

      return ret.id;
    })
    .immediate();

  return getReturn(returnId)!;
}

export function getReturn(id: number): ReturnDTO | null {
  const db = getDb();
  const ret = rowOf(returns, db.prepare('SELECT * FROM returns WHERE id = ?').get(requireId(id, 'Return')));
  if (!ret) return null;
  return toDTO(ret);
}

function toDTO(ret: typeof returns.$inferSelect): ReturnDTO {
  const db = getDb();
  const items = db
    .prepare('SELECT * FROM return_items WHERE return_id = ? ORDER BY id ASC')
    .all(ret.id)
    .map((r) => rowOf(returnItems, r)!);
  return {
    id: ret.id,
    returnNumber: ret.returnNumber,
    originalSaleId: ret.originalSaleId,
    returnType: ret.returnType as ReturnType,
    refundUsdCents: ret.refundUsdCents,
    refundLbp: ret.refundLbp,
    exchangeRateSnapshot: ret.exchangeRateSnapshot,
    refundUsdEquivalentCents: ret.refundUsdEquivalentCents,
    costUsdCents: ret.costUsdCents,
    reason: ret.reason,
    createdAt: Math.floor(ret.createdAt.getTime() / 1000),
    items: items.map((it) => ({
      id: it.id,
      saleItemId: it.saleItemId,
      productId: it.productId,
      quantityReturnedMinor: it.quantityReturnedMinor,
      refundLineMinor: it.refundLineMinor,
      refundCurrency: it.refundCurrency,
    })),
  };
}

export function listReturns(rawOptions: unknown = {}): ReturnDTO[] {
  const { from, to } = optionalRange(rawOptions);
  const limit = optionalLimit(
    rawOptions && typeof rawOptions === 'object' ? (rawOptions as { limit?: unknown }).limit : undefined,
    200,
    1000,
  );
  const db = getDb();
  const conditions: string[] = [];
  const params: number[] = [];
  if (from !== undefined) {
    conditions.push('created_at >= ?');
    params.push(from);
  }
  if (to !== undefined) {
    conditions.push('created_at <= ?');
    params.push(to);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM returns ${whereClause} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params, limit)
    .map((r) => rowOf(returns, r)!);
  return rows.map(toDTO);
}
