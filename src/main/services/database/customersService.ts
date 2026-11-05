/**
 * Customers service — simple credit/debt tracking. PRD section 28.
 *
 * Customer balance is stored in USD-equivalent cents. Each credit/payment
 * transaction is recorded with the exchange rate snapshot used at the time
 * of the transaction.
 */

import { eq, gte, lte, desc } from 'drizzle-orm';
import { getDb, getDrizzle, rowOf } from './connection';
import { customers, customerTransactions, auditLog } from './schema';
import { getCurrentRate } from './exchangeRate';
import { lbpToUsdCents, roundLbp, usdCentsToLbpExact } from '@shared/money/index';
import type {
  CustomerDTO,
  CustomerTxnType,
  Currency,
} from '@shared/types/index';
import {
  requireNonEmptyString,
  requireCurrency,
  requireObject,
  requireId,
  requireSafeInt,
  optionalString,
  optionalLimit,
  ValidationError,
  optionalBoolean,
} from '@shared/validation/index';
import { MAX_USD_CENTS, MAX_LBP } from '@shared/money/index';

function loadDTO(row: typeof customers.$inferSelect): CustomerDTO {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    balanceUsdCents: row.balanceUsdCents,
    notes: row.notes,
    active: Boolean(row.active),
  };
}

export function listCustomers(activeOnly = false): CustomerDTO[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM customers
       ${activeOnly ? 'WHERE active = 1' : ''}
       ORDER BY name COLLATE NOCASE ASC`,
    )
    .all()
    .map((r) => rowOf(customers, r)!);
  return rows.map(loadDTO);
}

export function getCustomer(rawId: unknown): CustomerDTO | null {
  const id = requireId(rawId, 'Customer');
  const row = rowOf(customers, getDb().prepare('SELECT * FROM customers WHERE id = ?').get(id));
  return row ? loadDTO(row) : null;
}

export function createCustomer(rawInput: unknown): CustomerDTO {
  const input = requireObject(rawInput, 'Customer');
  const name = requireNonEmptyString(input.name, 'Customer name');
  if (name.length > 200) throw new ValidationError('Customer name is too long');
  const result = getDrizzle()
    .insert(customers)
    .values({
      name,
      phone: optionalString(input.phone, 50, 'Phone')?.trim() || null,
      notes: optionalString(input.notes, 1000, 'Notes')?.trim() || null,
      balanceUsdCents: 0,
      active: true,
    })
    .returning()
    .get();
  return loadDTO(result);
}

export function updateCustomer(rawId: unknown, rawInput: unknown): void {
  const id = requireId(rawId, 'Customer');
  const input = requireObject(rawInput, 'Customer');
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = requireNonEmptyString(input.name, 'Customer name');
  if (input.phone !== undefined) updates.phone = optionalString(input.phone, 50, 'Phone')?.trim() || null;
  if (input.notes !== undefined) updates.notes = optionalString(input.notes, 1000, 'Notes')?.trim() || null;
  if (input.active !== undefined) updates.active = input.active === true;
  if (!getDb().prepare('SELECT id FROM customers WHERE id = ?').get(id)) {
    throw new ValidationError('Customer not found');
  }
  const db = getDb();
  db.transaction(() => {
    const before = rowOf(customers, db.prepare('SELECT * FROM customers WHERE id = ?').get(id));
    if (!before) throw new ValidationError('Customer not found');
    getDrizzle().update(customers).set(updates).where(eq(customers.id, id)).run();
    const after = rowOf(customers, db.prepare('SELECT * FROM customers WHERE id = ?').get(id));
    getDrizzle().insert(auditLog).values({
      action: 'CUSTOMER_UPDATE', entityId: id, entityType: 'customer',
      payload: JSON.stringify({
        before: { name: before.name, phone: before.phone, notes: before.notes, active: Boolean(before.active) },
        after: { name: after?.name, phone: after?.phone, notes: after?.notes, active: Boolean(after?.active) },
      }),
    }).run();
  }).immediate();
}

/**
 * Record a customer payment toward their balance (PRD 28).
 * The payment may be in USD or LBP; the balance is kept in USD cents. A payment larger
 * than the outstanding balance is refused (the shop gives no store credit in V1).
 */
export function recordCustomerPayment(rawInput: unknown): CustomerDTO {
  const input = requireObject(rawInput, 'Payment');
  const customerId = requireId(input.customerId, 'Customer');
  const currency = requireCurrency(input.currency);
  const amountMinor = requireSafeInt(input.amountMinor, 'Amount', 0);
  if (amountMinor === 0) {
    throw new ValidationError('Payment amount must be greater than zero');
  }
  if (amountMinor > (currency === 'USD' ? MAX_USD_CENTS : MAX_LBP)) {
    throw new ValidationError('Payment amount is too large');
  }
  const settleRemainder = optionalBoolean(input.settleRemainder);
  if (settleRemainder && currency !== 'LBP') {
    throw new ValidationError('Rounded full debt settlement is only available for LBP payments');
  }
  // Customer balance payments are cash-only in V1; LBP cash uses available 5,000 notes.
  if (currency === 'LBP' && amountMinor % 5000 !== 0) {
    throw new ValidationError('LBP cash payments must be a multiple of 5,000');
  }
  const notes = optionalString(input.notes, 500, 'Notes')?.trim() || null;

  const drizzle = getDrizzle();
  const db = getDb();

  db.transaction(() => {
    const rate = getCurrentRate().currentRate;
    const customer = rowOf(customers, db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId));
    if (!customer) {
      throw new ValidationError('Customer not found');
    }
    if (customer.balanceUsdCents <= 0) {
      throw new ValidationError('The customer has no outstanding balance');
    }
    const exactDebtLbp = usdCentsToLbpExact(customer.balanceUsdCents, rate);
    const exactDebtWholeLbp = Math.ceil(exactDebtLbp);
    const cashDueLbp = roundLbp(exactDebtWholeLbp);
    const roundingDifferenceLbp = settleRemainder
      ? amountMinor - exactDebtWholeLbp
      : 0;
    if (settleRemainder && amountMinor !== cashDueLbp) {
      throw new ValidationError('The payment must equal the rounded amount required to settle the full debt');
    }
    const usdEquivalentCents = settleRemainder
      ? customer.balanceUsdCents
      : currency === 'USD'
        ? amountMinor
        : lbpToUsdCents(amountMinor, rate);
    if (usdEquivalentCents > customer.balanceUsdCents) {
      throw new ValidationError('The payment is more than the amount the customer owes');
    }
    drizzle
      .update(customers)
      .set({ balanceUsdCents: customer.balanceUsdCents - usdEquivalentCents, updatedAt: new Date() })
      .where(eq(customers.id, customerId))
      .run();
    drizzle.insert(customerTransactions).values({
      customerId,
      transactionType: 'PAYMENT',
      amountUsdCents: -usdEquivalentCents,
      cashAmountMinor: amountMinor,
      cashCurrency: currency,
      roundingDifferenceLbp: settleRemainder ? roundingDifferenceLbp : 0,
      exchangeRateSnapshot: rate,
      notes: settleRemainder
        ? [notes, `Rounded debt settlement: received ${amountMinor} LBP; rounding difference ${roundingDifferenceLbp} LBP`]
            .filter(Boolean)
            .join(' | ')
        : notes,
    }).run();
    drizzle.insert(auditLog).values({
      action: 'CUSTOMER_PAYMENT',
      entityId: customerId,
      entityType: 'customer',
      payload: JSON.stringify({
        amountMinor,
        currency,
        usdEquivalentCents,
        settleRemainder,
        roundingDifferenceLbp: settleRemainder ? roundingDifferenceLbp : 0,
      }),
    }).run();
  }).immediate();

  return getCustomer(customerId)!;
}

/**
 * List customer transactions (audit trail of all balance changes).
 */
export function listCustomerTransactions(
  rawCustomerId: unknown,
  rawLimit?: unknown,
): Array<{
  id: number;
  transactionType: CustomerTxnType;
  amountUsdCents: number;
  cashAmountMinor: number | null;
  cashCurrency: Currency | null;
  roundingDifferenceLbp: number;
  saleId: number | null;
  exchangeRateSnapshot: number;
  notes: string | null;
  createdAt: number;
}> {
  const customerId = requireId(rawCustomerId, 'Customer');
  const limit = optionalLimit(rawLimit, 100, 1000);
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM customer_transactions
       WHERE customer_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(customerId, limit)
    .map((r) => rowOf(customerTransactions, r)!);
  return rows.map((r) => ({
    id: r.id,
    transactionType: r.transactionType as CustomerTxnType,
    amountUsdCents: r.amountUsdCents,
    cashAmountMinor: r.cashAmountMinor,
    cashCurrency: r.cashCurrency as Currency | null,
    roundingDifferenceLbp: r.roundingDifferenceLbp,
    saleId: r.saleId,
    exchangeRateSnapshot: r.exchangeRateSnapshot,
    notes: r.notes,
    createdAt: Math.floor(r.createdAt.getTime() / 1000),
  }));
}
