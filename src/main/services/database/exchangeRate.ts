/**
 * Exchange rate service — manages the USD/LBP exchange rate history.
 *
 * PRD section 16: The exchange rate can be changed by the shop owner.
 * PRD section 50: Historical transactions must retain the rate used at the time
 *                 of the transaction.
 *
 * Implementation: every rate change appends a row to exchange_rate_history.
 * `getCurrentRate()` returns the rate with the most recent effective_from <= now.
 */

import { eq, desc, lte } from 'drizzle-orm';
import { getDb, getDrizzle } from './connection';
import { exchangeRateHistory, auditLog } from './schema';
import { DEFAULT_EXCHANGE_RATE } from '@shared/constants/index';
import type { ExchangeRateInfo } from '@shared/types/index';
import { ValidationError } from '@shared/validation/index';
import { MAX_RATE } from '@shared/money/index';

export function getCurrentRate(): ExchangeRateInfo {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT rate, effective_from FROM exchange_rate_history
       WHERE effective_from <= unixepoch()
       ORDER BY effective_from DESC, id DESC LIMIT 1`,
    )
    .get() as { rate: number; effective_from: number } | undefined;

  if (!row) {
    // No rate set yet — fall back to default (shouldn't happen post first-run)
    return {
      currentRate: DEFAULT_EXCHANGE_RATE,
      updatedAt: Math.floor(Date.now() / 1000),
    };
  }
  return {
    currentRate: row.rate,
    updatedAt: row.effective_from,
  };
}

/**
 * Get the exchange rate that was effective at a given unix timestamp.
 * Used to reconstruct historical transactions (PRD section 50).
 */
export function getRateAt(timestamp: number): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT rate FROM exchange_rate_history
       WHERE effective_from <= ?
       ORDER BY effective_from DESC, id DESC LIMIT 1`,
    )
    .get(timestamp) as { rate: number } | undefined;
  return row?.rate ?? DEFAULT_EXCHANGE_RATE;
}

export function recordExchangeRateChange(
  newRate: number,
  effectiveFrom: number = Math.floor(Date.now() / 1000),
): void {
  if (!Number.isSafeInteger(newRate) || newRate <= 0 || newRate > MAX_RATE) {
    throw new ValidationError('Exchange rate must be a positive whole number (LBP per 1 USD)');
  }
  const drizzle = getDrizzle();
  const previous = getCurrentRate().currentRate;
  getDb().transaction(() => {
    drizzle.insert(exchangeRateHistory).values({
      rate: newRate,
      effectiveFrom: new Date(effectiveFrom * 1000),
    }).run();

    drizzle.insert(auditLog).values({
      action: 'EXCHANGE_RATE_CHANGE',
      entityType: 'exchange_rate',
      payload: JSON.stringify({ previousRate: previous, newRate, effectiveFrom }),
    }).run();
  })();
}

export function listRateHistory(limit = 50): Array<{
  id: number;
  rate: number;
  effectiveFrom: number;
}> {
  const drizzle = getDrizzle();
  const rows = drizzle
    .select()
    .from(exchangeRateHistory)
    .orderBy(desc(exchangeRateHistory.effectiveFrom))
    .limit(limit)
    .all();
  return rows.map((r) => ({
    id: r.id,
    rate: r.rate,
    effectiveFrom: Math.floor(r.effectiveFrom.getTime() / 1000),
  }));
}
