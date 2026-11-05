/**
 * Expenses service. PRD section 39.
 */

import { eq, gte, lte, desc } from 'drizzle-orm';
import { getDb, getDrizzle, rowOf } from './connection';
import { expenses, auditLog } from './schema';
import { getCurrentRate } from './exchangeRate';
import { lbpToUsdCents } from '@shared/money/index';
import type {
  ExpenseDTO,
  ExpenseCategory,
  Currency,
  ExpensePaymentSource,
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
} from '@shared/validation/index';
import { MAX_USD_CENTS, MAX_LBP } from '@shared/money/index';

export function createExpense(rawInput: unknown): ExpenseDTO {
  const input = requireObject(rawInput, 'Expense');
  const description = requireNonEmptyString(input.description, 'Description');
  if (description.length > 300) throw new ValidationError('Description is too long');
  const currency = requireCurrency(input.currency);
  if (input.paymentSource !== 'CASH' && input.paymentSource !== 'OWNER') {
    throw new ValidationError('Choose whether the expense is paid from cash or by the owner');
  }
  const paymentSource: ExpensePaymentSource = input.paymentSource;
  const amountMinor = requireSafeInt(input.amountMinor, 'Amount', 0);
  if (amountMinor === 0) {
    throw new ValidationError('Expense amount must be greater than zero');
  }
  if (amountMinor > (currency === 'USD' ? MAX_USD_CENTS : MAX_LBP)) {
    throw new ValidationError('Expense amount is too large');
  }
  const date = requireSafeInt(input.date, 'Date', 1);
  const category = requireNonEmptyString(input.category, 'Category');
  if (category.length > 50) throw new ValidationError('Category is too long');
  const notes = optionalString(input.notes, 1000, 'Notes')?.trim() || null;

  const drizzle = getDrizzle();
  const result = getDb().transaction(() => {
    const rate = getCurrentRate().currentRate;
    const amountUsdEquivalentCents =
      currency === 'USD' ? amountMinor : lbpToUsdCents(amountMinor, rate);
    const row = drizzle
      .insert(expenses)
      .values({
        date: new Date(date * 1000),
        description,
        amountMinor,
        currency,
        category,
        amountUsdEquivalentCents,
        paymentSource,
        exchangeRateSnapshot: rate,
        notes,
      })
      .returning()
      .get();
    drizzle.insert(auditLog).values({
      action: 'EXPENSE',
      entityId: row.id,
      entityType: 'expense',
      payload: JSON.stringify({ event: 'created', description, amountMinor, currency, category, paymentSource }),
    }).run();
    return row;
  })();
  return loadDTO(result);
}

export function listExpenses(rawOptions: unknown = {}): ExpenseDTO[] {
  const o = rawOptions === undefined || rawOptions === null ? {} : requireObject(rawOptions, 'Options');
  const db = getDb();
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (o.from !== undefined) {
    conditions.push('date >= ?');
    params.push(requireSafeInt(o.from, 'From date'));
  }
  if (o.to !== undefined) {
    conditions.push('date <= ?');
    params.push(requireSafeInt(o.to, 'To date'));
  }
  if (o.category !== undefined) {
    conditions.push('category = ?');
    params.push(requireNonEmptyString(o.category, 'Category'));
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = optionalLimit(o.limit, 500, 2000);
  const rows = db
    .prepare(`SELECT * FROM expenses ${whereClause} ORDER BY date DESC, id DESC LIMIT ?`)
    .all(...params, limit)
    .map((r) => rowOf(expenses, r)!);
  return rows.map(loadDTO);
}

/**
 * Delete an expense (typo correction). The full record is kept in the audit log so the
 * deletion is traceable (PRD 38, 52).
 */
export function deleteExpense(rawId: unknown): void {
  const id = requireId(rawId, 'Expense');
  const drizzle = getDrizzle();
  getDb().transaction(() => {
    const row = rowOf(expenses, getDb().prepare('SELECT * FROM expenses WHERE id = ?').get(id));
    if (!row) throw new ValidationError('Expense not found');
    drizzle.delete(expenses).where(eq(expenses.id, id)).run();
    drizzle.insert(auditLog).values({
      action: 'EXPENSE',
      entityId: id,
      entityType: 'expense',
      payload: JSON.stringify({
        event: 'deleted',
        description: row.description,
        amountMinor: row.amountMinor,
        currency: row.currency,
        category: row.category,
        date: Math.floor(row.date.getTime() / 1000),
        amountUsdEquivalentCents: row.amountUsdEquivalentCents,
        paymentSource: row.paymentSource,
      }),
    }).run();
  })();
}

function loadDTO(row: typeof expenses.$inferSelect): ExpenseDTO {
  return {
    id: row.id,
    date: Math.floor(row.date.getTime() / 1000),
    description: row.description,
    amountMinor: row.amountMinor,
    currency: row.currency as Currency,
    category: row.category,
    amountUsdEquivalentCents: row.amountUsdEquivalentCents,
    paymentSource: row.paymentSource as ExpensePaymentSource | null,
    exchangeRateSnapshot: row.exchangeRateSnapshot,
    notes: row.notes,
  };
}
