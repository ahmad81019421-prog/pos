/**
 * Reports service. PRD sections 40, 41, 71.
 *
 * Every figure is computed from stored transaction snapshots, so reports never change
 * when a product price, cost or the exchange rate is edited later (PRD 50).
 *
 * KPI definitions (one definition each, see SalesReport in shared/types):
 *   gross sales   = SUM(total) of COMPLETED + RETURNED invoices created in the range
 *   returns       = SUM(refund at original rate) of returns created in the range
 *   net sales     = gross sales - returns
 *   cost of goods = SUM(cost of sold items) - SUM(cost of returned items)
 *   gross profit  = net sales - cost of goods
 *   expenses      = SUM(expenses) dated in the range
 *   waste         = SUM(cost of wasted stock at the time of waste) in the range
 *   net profit    = gross profit - expenses - waste
 * A return therefore reduces revenue exactly once, and an expense is deducted once.
 * Suspended (unpaid draft) sales are never counted.
 */

import { getDb } from './connection';
import { lbpToUsdCents, usdCentsToLbpExact } from '@shared/money/index';
import { getRange } from '@shared/dates/index';
import { getCurrentRate } from './exchangeRate';
import { ValidationError } from '@shared/validation/index';
import type {
  SalesReport,
  BestSellingProductDTO,
  DateRange,
  SellingUnit,
  CashBalanceDTO,
} from '@shared/types/index';
import { requireDateRange, optionalLimit } from '@shared/validation/index';

const CASH_OPENING_BALANCE_KEY = 'cash_opening_balance_usd_cents';
const CASH_BALANCE_ADJUSTMENT_KEY = 'cash_balance_adjustment_usd_cents';

export function todayRange(): DateRange {
  return getRange('today');
}
export function yesterdayRange(): DateRange {
  return getRange('yesterday');
}
export function thisWeekRange(): DateRange {
  return getRange('week');
}
export function thisMonthRange(): DateRange {
  return getRange('month');
}

export function getSalesReport(rawRange: unknown): SalesReport {
  const range = requireDateRange(rawRange);
  const db = getDb();

  const salesRow = db
    .prepare(
      `SELECT
         COALESCE(SUM(total_usd_equivalent_cents), 0) AS total_usd_eq,
         COALESCE(SUM(total_usd_cents), 0) AS total_usd,
         COALESCE(SUM(total_lbp), 0) AS total_lbp,
         COALESCE(SUM(cost_usd_cents), 0) AS cost_usd,
         COUNT(*) AS invoice_count
       FROM sales
       WHERE status IN ('COMPLETED', 'RETURNED')
         AND created_at >= ? AND created_at <= ?`,
    )
    .get(range.from, range.to) as Record<string, unknown> | undefined;

  const returnsRow = db
    .prepare(
      `SELECT COALESCE(SUM(refund_usd_equivalent_cents), 0) AS refund_eq,
              COALESCE(SUM(cost_usd_cents), 0) AS cost_back
       FROM returns WHERE created_at >= ? AND created_at <= ?`,
    )
    .get(range.from, range.to) as Record<string, unknown> | undefined;

  const expRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount_usd_equivalent_cents), 0) AS total,
              COALESCE(SUM(CASE WHEN payment_source = 'CASH'
                THEN amount_usd_equivalent_cents ELSE 0 END), 0) AS cash_total,
              COALESCE(SUM(CASE WHEN payment_source = 'OWNER'
                THEN amount_usd_equivalent_cents ELSE 0 END), 0) AS owner_total,
              COALESCE(SUM(CASE WHEN payment_source IS NULL
                THEN amount_usd_equivalent_cents ELSE 0 END), 0) AS unclassified_total
       FROM expenses WHERE date >= ? AND date <= ?`,
    )
    .get(range.from, range.to) as Record<string, unknown> | undefined;

  const wasteRow = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd_cents), 0) AS total
       FROM inventory_movements
       WHERE movement_type = 'WASTE' AND created_at >= ? AND created_at <= ?`,
    )
    .get(range.from, range.to) as Record<string, unknown> | undefined;

  if (!salesRow || !returnsRow || !expRow || !wasteRow) {
    throw new Error('The database did not return a complete sales report.');
  }

  const salesUsdEq = readReportInteger(salesRow.total_usd_eq, 'sales total');
  const salesUsd = readReportInteger(salesRow.total_usd, 'USD sales');
  const salesLbp = readReportInteger(salesRow.total_lbp, 'LBP sales');
  const salesCost = readReportInteger(salesRow.cost_usd, 'sales cost');
  const invoiceCount = readReportInteger(salesRow.invoice_count, 'invoice count');
  const returnsUsdEq = readReportInteger(returnsRow.refund_eq, 'returns total');
  const returnsCost = readReportInteger(returnsRow.cost_back, 'returned cost');
  const expensesUsd = readReportInteger(expRow.total, 'expenses total');
  const expensesCashUsd = readReportInteger(expRow.cash_total, 'cash expenses');
  const expensesOwnerUsd = readReportInteger(expRow.owner_total, 'owner-paid expenses');
  const expensesUnclassifiedUsd = readReportInteger(
    expRow.unclassified_total,
    'unclassified legacy expenses',
  );
  const wasteUsd = readReportInteger(wasteRow.total, 'waste total');

  const netSales = salesUsdEq - returnsUsdEq;
  const cogs = salesCost - returnsCost;
  const grossProfit = netSales - cogs;
  const netProfit = grossProfit - expensesUsd - wasteUsd;

  return {
    totalUsdCents: salesUsd,
    totalLbp: salesLbp,
    totalUsdEquivalentCents: salesUsdEq,
    returnsUsdCents: returnsUsdEq,
    netSalesUsdEquivalentCents: netSales,
    costUsdCents: cogs,
    grossProfitUsdCents: grossProfit,
    expensesUsdCents: expensesUsd,
    expensesCashUsdCents: expensesCashUsd,
    expensesOwnerUsdCents: expensesOwnerUsd,
    expensesUnclassifiedUsdCents: expensesUnclassifiedUsd,
    wasteUsdCents: wasteUsd,
    netProfitUsdCents: netProfit,
    invoiceCount,
  };
}

function readReportInteger(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`Invalid numeric value in sales report: ${field}`);
}

export function getCurrentCustomerDebt(): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN balance_usd_cents > 0 THEN balance_usd_cents ELSE 0 END), 0) AS total
       FROM customers`,
    )
    .get() as { total: number };
  return row.total;
}

export function getCashBalance(): CashBalanceDTO {
  const db = getDb();
  const setting = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(CASH_OPENING_BALANCE_KEY) as { value: string } | undefined;
  const openingBalanceUsdCents = setting
    ? readReportInteger(setting.value, 'cash opening balance')
    : 0;
  const adjustmentSetting = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(CASH_BALANCE_ADJUSTMENT_KEY) as { value: string } | undefined;
  const balanceAdjustmentUsdCents = adjustmentSetting
    ? readReportInteger(adjustmentSetting.value, 'cash balance adjustment')
    : 0;

  const paymentRows = db
    .prepare(
      `SELECT p.paid_usd_cents, p.paid_lbp, p.change_usd_cents, p.change_lbp,
              p.exchange_rate_snapshot
       FROM payments p JOIN sales s ON s.id = p.sale_id`,
    )
    .all() as Array<{
    paid_usd_cents: number;
    paid_lbp: number;
    change_usd_cents: number;
    change_lbp: number;
    exchange_rate_snapshot: number;
  }>;
  let currentBalanceUsdCents = openingBalanceUsdCents + balanceAdjustmentUsdCents;
  for (const payment of paymentRows) {
    currentBalanceUsdCents +=
      payment.paid_usd_cents -
      payment.change_usd_cents +
      lbpToUsdCents(
        payment.paid_lbp - payment.change_lbp,
        payment.exchange_rate_snapshot,
      );
  }

  const customerPayments = db
    .prepare(
      `SELECT transaction_type, amount_usd_cents, cash_amount_minor, cash_currency,
              exchange_rate_snapshot
       FROM customer_transactions WHERE transaction_type = 'PAYMENT'`,
    )
    .all() as Array<{
    transaction_type: string;
    amount_usd_cents: number;
    cash_amount_minor: number | null;
    cash_currency: string | null;
    exchange_rate_snapshot: number;
  }>;
  for (const payment of customerPayments) {
    if (payment.cash_amount_minor === null || payment.cash_currency === null) {
      currentBalanceUsdCents -= payment.amount_usd_cents;
    } else {
      currentBalanceUsdCents +=
        payment.cash_currency === 'USD'
          ? payment.cash_amount_minor
          : lbpToUsdCents(payment.cash_amount_minor, payment.exchange_rate_snapshot);
    }
  }

  const expenses = db
    .prepare(
      `SELECT amount_usd_equivalent_cents FROM expenses WHERE payment_source = 'CASH'`,
    )
    .all() as Array<{ amount_usd_equivalent_cents: number }>;
  for (const expense of expenses) {
    currentBalanceUsdCents -= expense.amount_usd_equivalent_cents;
  }

  const returns = db
    .prepare(
      `SELECT r.refund_usd_cents, r.refund_lbp, r.exchange_rate_snapshot,
              COALESCE(SUM(-ct.amount_usd_cents), 0) AS debt_reduction
       FROM returns r
       LEFT JOIN customer_transactions ct
         ON ct.sale_id = r.original_sale_id
        AND ct.transaction_type = 'ADJUSTMENT'
        AND ct.notes = r.return_number
       GROUP BY r.id`,
    )
    .all() as Array<{
    refund_usd_cents: number;
    refund_lbp: number;
    exchange_rate_snapshot: number;
    debt_reduction: number;
  }>;
  for (const refund of returns) {
    const refundUsdEquivalent =
      refund.refund_usd_cents +
      lbpToUsdCents(refund.refund_lbp, refund.exchange_rate_snapshot);
    currentBalanceUsdCents -= Math.max(0, refundUsdEquivalent - refund.debt_reduction);
  }

  if (!Number.isSafeInteger(currentBalanceUsdCents)) {
    throw new Error('Cash balance exceeds the supported safe integer range.');
  }
  const currentRate = getCurrentRate().currentRate;
  return {
    openingBalanceUsdCents,
    currentBalanceUsdCents,
    currentBalanceLbp:
      Math.sign(currentBalanceUsdCents) *
      usdCentsToLbpExact(Math.abs(currentBalanceUsdCents), currentRate),
  };
}

export function zeroCashBalance(): void {
  const db = getDb();
  db.transaction(() => {
    const balance = getCashBalance();
    const adjustmentSetting = db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(CASH_BALANCE_ADJUSTMENT_KEY) as { value: string } | undefined;
    const previousAdjustment = adjustmentSetting
      ? readReportInteger(adjustmentSetting.value, 'cash balance adjustment')
      : 0;
    // Keep pre-reset movements offset while starting the next balance from zero.
    const adjustment =
      BigInt(balance.openingBalanceUsdCents) +
      BigInt(previousAdjustment) -
      BigInt(balance.currentBalanceUsdCents);
    if (
      adjustment < BigInt(Number.MIN_SAFE_INTEGER) ||
      adjustment > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error('Cash balance exceeds the supported safe integer range.');
    }

    const saveSetting = db.prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    saveSetting.run(CASH_OPENING_BALANCE_KEY, '0');
    saveSetting.run(CASH_BALANCE_ADJUSTMENT_KEY, String(adjustment));
  })();
}

export function setCashOpeningBalance(rawAmount: unknown): void {
  if (
    typeof rawAmount !== 'number' ||
    !Number.isSafeInteger(rawAmount) ||
    rawAmount < 0
  ) {
    throw new ValidationError('Opening cash balance must be a non-negative integer number of USD cents.');
  }
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(CASH_OPENING_BALANCE_KEY, String(rawAmount));
}

interface LineRow {
  product_id: number;
  product_name: string;
  selling_unit: string;
  category_id: number;
  qty: number;
  line_total: number;
  currency: string;
  rate: number;
  sale_id: number;
}

/** Sold lines (gross, before returns) in a range, one row per invoice line. */
function soldLines(range: DateRange): LineRow[] {
  return getDb()
    .prepare(
      `SELECT si.product_id AS product_id,
              si.product_name_snapshot AS product_name,
              si.selling_unit_snapshot AS selling_unit,
              si.category_id_snapshot AS category_id,
              si.quantity_minor AS qty,
              si.line_total_minor AS line_total,
              si.price_currency_snapshot AS currency,
              s.exchange_rate_snapshot AS rate,
              si.sale_id AS sale_id
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE s.status IN ('COMPLETED', 'RETURNED')
         AND s.created_at >= ? AND s.created_at <= ?`,
    )
    .all(range.from, range.to) as LineRow[];
}

const usdEq = (r: LineRow): number =>
  r.currency === 'USD' ? r.line_total : lbpToUsdCents(r.line_total, r.rate);

/**
 * Best-selling products (gross sold quantity/value in the range).
 * Aggregation happens in code so LIMIT applies AFTER grouping per product.
 */
export function getBestSellingProducts(
  rawRange: unknown,
  rawLimit?: unknown,
): BestSellingProductDTO[] {
  const range = requireDateRange(rawRange);
  const limit = optionalLimit(rawLimit, 20, 200);
  const byProduct = new Map<number, BestSellingProductDTO & { sales: Set<number> }>();
  for (const r of soldLines(range)) {
    const existing = byProduct.get(r.product_id);
    if (existing) {
      existing.quantitySoldMinor += r.qty;
      existing.lineTotalUsdEquivalentCents += usdEq(r);
      existing.sales.add(r.sale_id);
    } else {
      byProduct.set(r.product_id, {
        productId: r.product_id,
        productName: r.product_name,
        quantitySoldMinor: r.qty,
        sellingUnit: r.selling_unit as SellingUnit,
        lineTotalUsdEquivalentCents: usdEq(r),
        saleCount: 0,
        sales: new Set([r.sale_id]),
      });
    }
  }
  return [...byProduct.values()]
    .map(({ sales, ...rest }) => ({ ...rest, saleCount: sales.size }))
    .sort((a, b) => b.lineTotalUsdEquivalentCents - a.lineTotalUsdEquivalentCents)
    .slice(0, limit);
}

/** Sales by category (gross, USD-equivalent at each invoice's own rate). */
export function getSalesByCategory(rawRange: unknown): Array<{
  categoryId: number;
  categoryName: string;
  totalUsdEquivalentCents: number;
  saleCount: number;
}> {
  const range = requireDateRange(rawRange);
  const names = new Map<number, string>(
    (
      getDb().prepare('SELECT id, name FROM categories').all() as Array<{
        id: number;
        name: string;
      }>
    ).map((c) => [c.id, c.name]),
  );
  const byCat = new Map<number, { total: number; sales: Set<number> }>();
  for (const r of soldLines(range)) {
    const e = byCat.get(r.category_id) ?? { total: 0, sales: new Set<number>() };
    e.total += usdEq(r);
    e.sales.add(r.sale_id);
    byCat.set(r.category_id, e);
  }
  return [...byCat.entries()]
    .map(([categoryId, e]) => ({
      categoryId,
      categoryName: names.get(categoryId) ?? `Category #${categoryId}`,
      totalUsdEquivalentCents: e.total,
      saleCount: e.sales.size,
    }))
    .sort((a, b) => b.totalUsdEquivalentCents - a.totalUsdEquivalentCents);
}

/** Stock additions and waste in a range (PRD 40 "Inventory" reports). */
export function getInventoryMovementsReport(rawRange: unknown): {
  additions: Array<{
    productName: string;
    quantityMinor: number;
    sellingUnit: SellingUnit;
    unitCost: number | null;
    currency: string | null;
    createdAt: number;
  }>;
  waste: Array<{
    productName: string;
    quantityMinor: number;
    sellingUnit: SellingUnit;
    reason: string | null;
    costUsdCents: number;
    /** false when the product had no cost recorded at the time of waste (cost shown as 0). */
    costKnown: boolean;
    createdAt: number;
  }>;
} {
  const range = requireDateRange(rawRange);
  const rows = getDb()
    .prepare(
      `SELECT m.movement_type, m.delta_minor, m.unit_cost, m.currency, m.reason,
              COALESCE(m.cost_usd_cents, 0) AS cost_usd_cents, (m.unit_cost IS NOT NULL) AS cost_known, m.created_at,
              p.name AS product_name, p.selling_unit
       FROM inventory_movements m JOIN products p ON p.id = m.product_id
       WHERE m.movement_type IN ('ADD_STOCK', 'WASTE')
         AND m.created_at >= ? AND m.created_at <= ?
       ORDER BY m.created_at DESC, m.id DESC`,
    )
    .all(range.from, range.to) as Array<{
    movement_type: string;
    delta_minor: number;
    unit_cost: number | null;
    currency: string | null;
    reason: string | null;
    cost_usd_cents: number;
    cost_known: number;
    created_at: number;
    product_name: string;
    selling_unit: string;
  }>;
  const additions: ReturnType<typeof getInventoryMovementsReport>['additions'] = [];
  const waste: ReturnType<typeof getInventoryMovementsReport>['waste'] = [];
  for (const r of rows) {
    if (r.movement_type === 'ADD_STOCK') {
      additions.push({
        productName: r.product_name,
        quantityMinor: r.delta_minor,
        sellingUnit: r.selling_unit as SellingUnit,
        unitCost: r.unit_cost,
        currency: r.currency,
        createdAt: r.created_at,
      });
    } else {
      waste.push({
        productName: r.product_name,
        quantityMinor: Math.abs(r.delta_minor),
        sellingUnit: r.selling_unit as SellingUnit,
        reason: r.reason,
        costUsdCents: r.cost_usd_cents,
        costKnown: r.cost_known === 1,
        createdAt: r.created_at,
      });
    }
  }
  return { additions, waste };
}

/** Dashboard summary (today vs yesterday). PRD section 41. */
export function getDashboard(): { today: SalesReport; yesterday: SalesReport } {
  return {
    today: getSalesReport(todayRange()),
    yesterday: getSalesReport(yesterdayRange()),
  };
}
