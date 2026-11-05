/**
 * Sales service — complete sale, suspend/resume sale, fetch sale, list sales.
 *
 * PRD sections 19-27, 24, 38, 48, 50, 64, 68, 69.
 *
 * Critical correctness:
 *   - All sale writes happen inside ONE immediate SQLite transaction (PRD 48). The rate,
 *     the prices, the stock check and every insert are evaluated inside it, so a sale
 *     is either fully saved or not saved at all.
 *   - Each sale_item stores snapshot values (price, currency, exchange rate, product name,
 *     category, unit cost) so historical rows remain accurate after future edits (PRD 50).
 *   - Every sale attempt may carry a clientRequestId: repeating the same id returns the
 *     already-saved sale, so a double click / retry can never create a duplicate sale.
 *   - Suspended sale: only ONE allowed at a time (PRD 24). It never touches stock.
 *   - The renderer is not trusted: the whole payload is re-validated here.
 */

import { eq } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import { getDb, getDrizzle, generateInvoiceNumber, rowOf } from './connection';
import {
  sales,
  saleItems,
  payments,
  products,
  auditLog,
  customers,
  customerTransactions,
} from './schema';
import { decrementForSale } from './inventoryService';
import { getCurrentRate } from './exchangeRate';
import {
  computeLineTotal,
  computeLineCost,
  computePaymentBreakdown,
  lbpToUsdCents,
  MAX_LBP,
  MAX_USD_CENTS,
  MAX_PIECE_QUANTITY,
  MAX_WEIGHT_GRAMS,
  MAX_UNIT_PRICE_LBP,
  MAX_UNIT_PRICE_USD_CENTS,
} from '@shared/money/index';
import type {
  SaleDTO,
  SaleItemDTO,
  SaleStatus,
  CartLineInput,
  CompleteSaleInput,
  PaymentDTO,
  Currency,
  PaymentType,
  SellingUnit,
} from '@shared/types/index';
import {
  ValidationError,
  requireObject,
  requireId,
  requireCurrency,
  requireSafeInt,
  optionalString,
  optionalLimit,
} from '@shared/validation/index';

const LBP_NOTE = 5_000;

export const SUSPENDED_INVOICE_NUMBER = 'SUSPENDED';

/* ------------------------------------------------------------------ */
/* Input validation                                                   */
/* ------------------------------------------------------------------ */

function parseLines(raw: unknown): CartLineInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ValidationError('Cannot save a sale with no items');
  }
  if (raw.length > 500) {
    throw new ValidationError('Too many items in one sale');
  }
  return raw.map((l, i) => {
    const o = requireObject(l, `Item ${i + 1}`);
    return {
      productId: requireId(o.productId, 'Product'),
      quantityMinor: requireSafeInt(o.quantityMinor, 'Quantity', 1),
      unitPriceMinor: requireSafeInt(o.unitPriceMinor, 'Unit price', 0),
      priceCurrency: requireCurrency(o.priceCurrency),
      directFinalPrice: o.directFinalPrice === true,
      lineTotalMinor: requireSafeInt(o.lineTotalMinor, 'Line total', 0),
    };
  });
}

export function parseCompleteSaleInput(raw: unknown): CompleteSaleInput & {
  lines: CartLineInput[];
} {
  const o = requireObject(raw, 'Sale');
  const pay = requireObject(o.payment, 'Payment');
  const paidUsdCents = requireSafeInt(pay.paidUsdCents, 'USD paid', 0);
  const paidLbp = requireSafeInt(pay.paidLbp, 'LBP paid', 0);
  if (paidUsdCents > MAX_USD_CENTS || paidLbp > MAX_LBP) {
    throw new ValidationError('Payment amount is too large');
  }
  const clientRequestId = optionalString(o.clientRequestId, 100, 'Request id') ?? null;
  return {
    lines: parseLines(o.lines),
    payment: {
      paidUsdCents,
      paidLbp,
      changeCurrency: requireCurrency(pay.changeCurrency),
    },
    customerId:
      o.customerId === undefined || o.customerId === null
        ? null
        : requireId(o.customerId, 'Customer'),
    clientRequestId: clientRequestId && clientRequestId.length > 0 ? clientRequestId : null,
    allowCredit: o.allowCredit === true,
  };
}

/* ------------------------------------------------------------------ */
/* Line preparation (shared by completeSale and suspendSale)          */
/* ------------------------------------------------------------------ */

type ProductRow = typeof products.$inferSelect;

interface PreparedLine {
  line: CartLineInput;
  product: ProductRow;
  lineTotal: number;
  unitPrice: number;
  unitCostMinor: number | null;
  lineCostMinor: number | null;
}

interface PreparedSale {
  lines: PreparedLine[];
  totalUsdCents: number;
  totalLbp: number;
  costUsdCents: number;
  totalUsdEquivalentCents: number;
}

function prepareLines(
  db: Database.Database,
  lines: CartLineInput[],
  rate: number,
): PreparedSale {
  const prepared: PreparedLine[] = [];
  let totalUsdCents = 0;
  let totalLbp = 0;
  let costUsdCents = 0;

  for (const line of lines) {
    // Drizzle maps snake_case columns to the camelCase fields used below.
    const product: ProductRow | undefined = getDrizzle()
      .select()
      .from(products)
      .where(eq(products.id, line.productId))
      .get();
    if (!product) {
      throw new ValidationError('A product in this sale no longer exists');
    }
    if (!product.active) {
      throw new ValidationError(`Product "${product.name}" is inactive and cannot be sold`);
    }
    const unit = product.sellingUnit as SellingUnit;
    // Regular lines use the product currency; scale-entered final prices may use either
    // supported currency because the cashier enters the amount shown by the scale.
    if (!line.directFinalPrice && line.priceCurrency !== product.priceCurrency) {
      throw new ValidationError(
        `The price currency of "${product.name}" does not match the product. Please re-add it.`,
      );
    }
    const maxQty = unit === 'WEIGHT' ? MAX_WEIGHT_GRAMS : MAX_PIECE_QUANTITY;
    if (line.quantityMinor > maxQty) {
      throw new ValidationError(`Quantity for "${product.name}" is too large`);
    }

    let lineTotal: number;
    let unitPrice = line.unitPriceMinor;
    if (line.directFinalPrice) {
      // Workflow B (PRD 12): the cashier types the final price shown by the scale.
      // Only allowed for weight products; the weight is kept on the line.
      if (unit !== 'WEIGHT') {
        throw new ValidationError('A final price can only be entered for weight products');
      }
      lineTotal = line.lineTotalMinor;
      const maxTotal = line.priceCurrency === 'USD' ? MAX_USD_CENTS : MAX_LBP;
      if (lineTotal > maxTotal) {
        throw new ValidationError('Final price is too large');
      }
    } else {
      // Workflow A: recompute from weight x the STORED product price. Neither the client
      // total nor the client unit price is trusted (no price override exists in V1).
      unitPrice = product.currentPrice;
      lineTotal = computeLineTotal(line.quantityMinor, unitPrice, unit, line.priceCurrency);
    }
    if (lineTotal <= 0) {
      throw new ValidationError(
        `The price of "${product.name}" is zero. Enter a price greater than zero.`,
      );
    }

    // Cost snapshot (PRD 31/50): latest purchase cost at the moment of sale,
    // stored in the product's currency.
    const unitCostMinor = product.currentCost ?? null;
    const lineCostMinor =
      unitCostMinor === null ? null : computeLineCost(line.quantityMinor, unitCostMinor, unit);

    prepared.push({ line, product, lineTotal, unitPrice, unitCostMinor, lineCostMinor });

    if (line.priceCurrency === 'USD') {
      totalUsdCents += lineTotal;
    } else {
      totalLbp += lineTotal;
    }
    if (lineCostMinor !== null) {
      costUsdCents += product.priceCurrency === 'USD'
        ? lineCostMinor
        : lbpToUsdCents(lineCostMinor, rate);
    }
  }

  if (totalUsdCents > MAX_USD_CENTS || totalLbp > MAX_LBP) {
    throw new ValidationError('The sale total is too large');
  }

  return {
    lines: prepared,
    totalUsdCents,
    totalLbp,
    costUsdCents,
    totalUsdEquivalentCents: totalUsdCents + lbpToUsdCents(totalLbp, rate),
  };
}

function insertSaleItems(
  saleId: number,
  prepared: PreparedLine[],
  rate: number,
): void {
  const drizzle = getDrizzle();
  for (const p of prepared) {
    drizzle
      .insert(saleItems)
      .values({
        saleId,
        productId: p.product.id,
        productNameSnapshot: p.product.name,
        productNameArSnapshot: p.product.nameAr ?? null,
        categoryIdSnapshot: p.product.categoryId,
        sellingUnitSnapshot: p.product.sellingUnit as SellingUnit,
        quantityMinor: p.line.quantityMinor,
        // Workflow A: price per KG / unit. Workflow B: the final price typed by the cashier.
        unitPriceMinor: p.line.directFinalPrice ? p.lineTotal : p.unitPrice,
        priceCurrencySnapshot: p.line.priceCurrency,
        directFinalPrice: p.line.directFinalPrice,
        lineTotalMinor: p.lineTotal,
        unitCostSnapshot: p.unitCostMinor,
        lineCostMinor: p.lineCostMinor,
        exchangeRateSnapshot: rate,
      })
      .run();
  }
}

/* ------------------------------------------------------------------ */
/* Complete sale                                                      */
/* ------------------------------------------------------------------ */

/**
 * Complete a sale in a single atomic transaction (PRD 48).
 *
 *   1. Re-validate the payload (never trust the renderer).
 *   2. Idempotency check on clientRequestId.
 *   3. Insert sale, sale_items (snapshots), decrement stock, insert payment,
 *      optional customer credit, audit log.
 *
 * Any error rolls everything back — no partial sale is ever left behind.
 */
export function completeSale(rawInput: unknown): SaleDTO {
  const input = parseCompleteSaleInput(rawInput);
  const db = getDb();
  const drizzle = getDrizzle();

  const saleId = db
    .transaction(() => {
      if (input.clientRequestId) {
        const dup = db
          .prepare('SELECT id FROM sales WHERE client_request_id = ?')
          .get(input.clientRequestId) as { id: number } | undefined;
        if (dup) return dup.id;
      }

      const rate = getCurrentRate().currentRate;
      const prepared = prepareLines(db, input.lines, rate);

      const breakdown = computePaymentBreakdown({
        owedUsdCents: prepared.totalUsdCents,
        owedLbp: prepared.totalLbp,
        paidUsdCents: input.payment.paidUsdCents,
        paidLbp: input.payment.paidLbp,
        rate,
        changeCurrency: input.payment.changeCurrency,
      });

      // Lebanese cash has no note below 5,000 LBP, so LBP handed over must be a multiple of
      // 5,000. This closes the gap where e.g. 87,300 of a 90,000 cash due could be settled
      // "on account" with zero debt. (Plain insufficient payments get the clearer message below.)
      if (
        (breakdown.isSufficient || (input.allowCredit && input.customerId)) &&
        input.payment.paidLbp % LBP_NOTE !== 0
      ) {
        throw new ValidationError(
          `LBP cash must be in multiples of ${LBP_NOTE.toLocaleString('en-US')} (smallest note).`,
        );
      }

      let creditUsdCents = 0;
      let customerId: number | null = null;
      if (!breakdown.isSufficient) {
        if (!input.allowCredit || !input.customerId) {
          throw new ValidationError(
            breakdown.lbpOnlyTender
              ? `Payment is not enough. The cash due in LBP is ${breakdown.cashDueLbp.toLocaleString('en-US')}.`
              : `Payment is not enough. Missing about ${(breakdown.shortfallUsdCents / 100).toFixed(2)} USD.`,
          );
        }
        const cust = rowOf(
          customers,
          db.prepare('SELECT * FROM customers WHERE id = ? AND active = 1').get(input.customerId),
        );
        if (!cust) throw new ValidationError('Customer not found or inactive');
        creditUsdCents = breakdown.shortfallUsdCents;
        customerId = cust.id;
      } else if (input.customerId) {
        // A customer may be attached to a fully paid sale (history only).
        customerId = input.customerId;
        const exists = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId);
        if (!exists) throw new ValidationError('Customer not found');
      }

      const paidAnything =
        input.payment.paidUsdCents > 0 || input.payment.paidLbp > 0;
      let paymentType: PaymentType;
      if (creditUsdCents > 0 && !paidAnything) paymentType = 'CREDIT';
      else if (input.payment.paidUsdCents > 0 && input.payment.paidLbp === 0 && creditUsdCents === 0)
        paymentType = 'USD';
      else if (input.payment.paidLbp > 0 && input.payment.paidUsdCents === 0 && creditUsdCents === 0)
        paymentType = 'LBP';
      else paymentType = 'MIXED';

      const invoiceNumber = generateInvoiceNumber(db);
      const now = new Date();

      const saleRow = drizzle
        .insert(sales)
        .values({
          invoiceNumber,
          status: 'COMPLETED',
          customerId,
          totalUsdCents: prepared.totalUsdCents,
          totalLbp: prepared.totalLbp,
          costUsdCents: prepared.costUsdCents,
          exchangeRateSnapshot: rate,
          totalUsdEquivalentCents: prepared.totalUsdEquivalentCents,
          suspendedLabel: null,
          clientRequestId: input.clientRequestId ?? null,
          creditUsdCents,
          createdAt: now,
          completedAt: now,
          updatedAt: now,
        })
        .returning()
        .get();

      insertSaleItems(saleRow.id, prepared.lines, rate);

      // Stock is deducted once per line, inside the same transaction (PRD 29).
      for (const p of prepared.lines) {
        decrementForSale(p.product.id, p.line.quantityMinor, saleRow.id);
      }

      drizzle
        .insert(payments)
        .values({
          saleId: saleRow.id,
          paymentType,
          paidUsdCents: input.payment.paidUsdCents,
          paidLbp: input.payment.paidLbp,
          changeUsdCents: breakdown.changeUsdCents,
          changeLbp: breakdown.changeLbp,
          exchangeRateSnapshot: rate,
        })
        .run();

      if (creditUsdCents > 0 && customerId !== null) {
        drizzle
          .insert(customerTransactions)
          .values({
            customerId,
            transactionType: 'CREDIT',
            amountUsdCents: creditUsdCents,
            saleId: saleRow.id,
            exchangeRateSnapshot: rate,
            notes: invoiceNumber,
          })
          .run();
        db.prepare(
          'UPDATE customers SET balance_usd_cents = balance_usd_cents + ?, updated_at = unixepoch() WHERE id = ?',
        ).run(creditUsdCents, customerId);
      }

      drizzle
        .insert(auditLog)
        .values({
          action: 'SALE',
          entityId: saleRow.id,
          entityType: 'sale',
          payload: JSON.stringify({
            invoiceNumber,
            totalUsdCents: prepared.totalUsdCents,
            totalLbp: prepared.totalLbp,
            totalUsdEquivalentCents: prepared.totalUsdEquivalentCents,
            costUsdCents: prepared.costUsdCents,
            creditUsdCents,
            lineCount: prepared.lines.length,
          }),
        })
        .run();

      // A recovered draft cart for this very sale is obsolete once the sale commits; removing
      // it in the same transaction means it can never be sold a second time.
      if (input.clientRequestId) {
        const d = db.prepare("SELECT value FROM app_settings WHERE key = 'draft_cart'").get() as
          | { value: string }
          | undefined;
        if (d) {
          let same = false;
          try {
            same = (JSON.parse(d.value) as { requestId?: string }).requestId === input.clientRequestId;
          } catch {
            same = true; // corrupt draft: discard
          }
          if (same) db.prepare("DELETE FROM app_settings WHERE key = 'draft_cart'").run();
        }
      }

      return saleRow.id;
    })
    .immediate();

  return getSale(saleId)!;
}

/* ------------------------------------------------------------------ */
/* Suspended sale (exactly one, PRD 24)                               */
/* ------------------------------------------------------------------ */

export function suspendSale(rawLines: unknown, rawLabel?: unknown): SaleDTO {
  const lines = parseLines(rawLines);
  const label = optionalString(rawLabel, 100, 'Label')?.trim() || null;
  const db = getDb();
  const drizzle = getDrizzle();

  const saleId = db
    .transaction(() => {
      const existing = db
        .prepare("SELECT id FROM sales WHERE status = 'SUSPENDED' LIMIT 1")
        .get();
      if (existing) {
        throw new ValidationError(
          'A suspended sale already exists. Resume or cancel it before suspending another.',
        );
      }
      const rate = getCurrentRate().currentRate;
      const prepared = prepareLines(db, lines, rate);
      const now = new Date();
      const saleRow = drizzle
        .insert(sales)
        .values({
          // Suspended sales do not consume a real invoice number (no gaps in invoices).
          invoiceNumber: SUSPENDED_INVOICE_NUMBER,
          status: 'SUSPENDED',
          customerId: null,
          totalUsdCents: prepared.totalUsdCents,
          totalLbp: prepared.totalLbp,
          costUsdCents: prepared.costUsdCents,
          exchangeRateSnapshot: rate,
          totalUsdEquivalentCents: prepared.totalUsdEquivalentCents,
          suspendedLabel: label,
          createdAt: now,
          completedAt: null,
          updatedAt: now,
        })
        .returning()
        .get();
      insertSaleItems(saleRow.id, prepared.lines, rate);
      // NOTE: stock is NOT touched on suspend — only on completion.
      drizzle
        .insert(auditLog)
        .values({
          action: 'SALE',
          entityId: saleRow.id,
          entityType: 'sale',
          payload: JSON.stringify({ event: 'suspended', label }),
        })
        .run();
      return saleRow.id;
    })
    .immediate();

  return getSale(saleId)!;
}

export function getSuspendedSale(): SaleDTO | null {
  const db = getDb();
  const row = rowOf(sales, db.prepare(`SELECT * FROM sales WHERE status = 'SUSPENDED' LIMIT 1`).get());
  if (!row) return null;
  return loadSaleDTO(row);
}

/**
 * Discard the suspended sale (also used after it has been resumed into the cart).
 * A suspended sale is a draft: no stock or money was ever booked for it, so removing
 * it does not alter financial history.
 */
export function cancelSuspendedSale(): void {
  const drizzle = getDrizzle();
  const db = getDb();
  db.transaction(() => {
    const existing = db
      .prepare("SELECT id FROM sales WHERE status = 'SUSPENDED'")
      .get() as { id: number } | undefined;
    if (!existing) return;
    drizzle.delete(saleItems).where(eq(saleItems.saleId, existing.id)).run();
    drizzle.delete(sales).where(eq(sales.id, existing.id)).run();
    drizzle
      .insert(auditLog)
      .values({
        action: 'SALE',
        entityId: existing.id,
        entityType: 'sale',
        payload: JSON.stringify({ event: 'suspended_cleared' }),
      })
      .run();
  })();
}

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

export function getSale(id: number): SaleDTO | null {
  const db = getDb();
  const row = rowOf(sales, db.prepare('SELECT * FROM sales WHERE id = ?').get(requireId(id, 'Sale')));
  if (!row) return null;
  return loadSaleDTO(row);
}

export function getSaleByInvoiceNumber(invoiceNumber: string): SaleDTO | null {
  const db = getDb();
  const row = rowOf(sales, db.prepare('SELECT * FROM sales WHERE invoice_number = ?').get(invoiceNumber));
  if (!row) return null;
  return loadSaleDTO(row);
}

function loadSaleDTO(row: typeof sales.$inferSelect): SaleDTO {
  const db = getDb();
  const items = db
    .prepare(
      `SELECT si.*,
              COALESCE((SELECT SUM(ri.quantity_returned_minor)
                        FROM return_items ri WHERE ri.sale_item_id = si.id), 0) AS returned_qty
       FROM sale_items si WHERE si.sale_id = ? ORDER BY si.id ASC`,
    )
    .all(row.id)
    .map((r) => ({ ...rowOf(saleItems, r)!, returned_qty: (r as { returned_qty: number }).returned_qty }));
  const paymentRow = rowOf(payments, db.prepare('SELECT * FROM payments WHERE sale_id = ? LIMIT 1').get(row.id));

  const itemDTOs: SaleItemDTO[] = items.map((it) => ({
    id: it.id,
    productId: it.productId,
    productNameSnapshot: it.productNameSnapshot,
    productNameArSnapshot: it.productNameArSnapshot,
    categoryIdSnapshot: it.categoryIdSnapshot,
    sellingUnitSnapshot: it.sellingUnitSnapshot as SaleItemDTO['sellingUnitSnapshot'],
    quantityMinor: it.quantityMinor,
    unitPriceMinor: it.unitPriceMinor,
    priceCurrencySnapshot: it.priceCurrencySnapshot as Currency,
    directFinalPrice: Boolean(it.directFinalPrice),
    lineTotalMinor: it.lineTotalMinor,
    unitCostSnapshot: it.unitCostSnapshot,
    lineCostMinor: it.lineCostMinor,
    exchangeRateSnapshot: it.exchangeRateSnapshot,
    returnedQuantityMinor: it.returned_qty,
  }));

  const paymentDTO: PaymentDTO | null = paymentRow
    ? {
        id: paymentRow.id,
        paymentType: paymentRow.paymentType as PaymentType,
        paidUsdCents: paymentRow.paidUsdCents,
        paidLbp: paymentRow.paidLbp,
        changeUsdCents: paymentRow.changeUsdCents,
        changeLbp: paymentRow.changeLbp,
        exchangeRateSnapshot: paymentRow.exchangeRateSnapshot,
      }
    : null;

  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    status: row.status as SaleStatus,
    totalUsdCents: row.totalUsdCents,
    totalLbp: row.totalLbp,
    costUsdCents: row.costUsdCents,
    exchangeRateSnapshot: row.exchangeRateSnapshot,
    totalUsdEquivalentCents: row.totalUsdEquivalentCents,
    customerId: row.customerId,
    creditUsdCents: row.creditUsdCents,
    createdAt: Math.floor(row.createdAt.getTime() / 1000),
    completedAt: row.completedAt ? Math.floor(row.completedAt.getTime() / 1000) : null,
    items: itemDTOs,
    payment: paymentDTO,
  };
}

/**
 * List sales with optional filters. Suspended drafts are excluded unless asked for.
 */
export function listSales(rawOptions: unknown = {}): SaleDTO[] {
  const o = rawOptions === undefined || rawOptions === null ? {} : requireObject(rawOptions, 'Options');
  const db = getDb();
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (o.status !== undefined) {
    if (!['COMPLETED', 'SUSPENDED', 'VOIDED', 'RETURNED'].includes(String(o.status))) {
      throw new ValidationError('Invalid status');
    }
    conditions.push('status = ?');
    params.push(String(o.status));
  } else {
    conditions.push("status <> 'SUSPENDED'");
  }
  if (o.from !== undefined) {
    conditions.push('created_at >= ?');
    params.push(requireSafeInt(o.from, 'From date'));
  }
  if (o.to !== undefined) {
    conditions.push('created_at <= ?');
    params.push(requireSafeInt(o.to, 'To date'));
  }
  const search = optionalString(o.search, 50, 'Search')?.trim();
  if (search) {
    conditions.push("invoice_number LIKE ? ESCAPE '\\'");
    params.push(`%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }
  const limit = optionalLimit(o.limit, 200, 1000);
  const rows = db
    .prepare(
      `SELECT * FROM sales WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...params, limit)
    .map((r) => rowOf(sales, r)!);
  return rows.map(loadSaleDTO);
}
