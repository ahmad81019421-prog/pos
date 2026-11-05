/**
 * SQLite schema for the Local POS application.
 *
 * Design principles (mandated by PRD sections 49, 50, 51, 74):
 *
 * 1. Historical preservation — sale_items / return_items / payments / inventory_movements
 *    store the relevant price, currency, exchange rate, unit cost, product name snapshot,
 *    category snapshot, etc. at the moment of the transaction. Changing current product
 *    price / name / category / cost / exchange rate must never mutate historical rows.
 *
 * 2. Money integrity — LBP stored as integer minor units (piasters→ just integer LBP),
 *    USD stored as integer minor units (cents). No float columns for money.
 *
 * 3. Foreign keys + transactions — Drizzle relational schema; better-sqlite3 will
 *    have PRAGMA foreign_keys = ON.
 *
 * 4. Soft delete for products — products have `active` boolean. We never physically
 *    delete a product that has historical transactions.
 */

import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const shopSettings = sqliteTable('shop_settings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  shopName: text('shop_name').notNull(),
  phone: text('phone'),
  address: text('address'),
  defaultCurrency: text('default_currency').notNull().default('USD'), // 'USD' | 'LBP'
  language: text('language').notNull().default('en'), // 'en' | 'ar'
  receiptFooter: text('receipt_footer'),
  receiptHeader: text('receipt_header'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

/* ------------------------------------------------------------------ */
/* Exchange Rate History (immutable historical records)                */
/* ------------------------------------------------------------------ */

export const exchangeRateHistory = sqliteTable(
  'exchange_rate_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    rate: integer('rate').notNull(),
    effectiveFrom: integer('effective_from', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    rateFromIdx: index('erh_effective_from_idx').on(t.effectiveFrom),
  }),
);

/* ------------------------------------------------------------------ */
/* Categories & Products                                              */
/* ------------------------------------------------------------------ */

export const categories = sqliteTable(
  'categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    nameAr: text('name_ar'),
    sortOrder: integer('sort_order').notNull().default(0),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    nameIdx: uniqueIndex('category_name_idx').on(t.name),
  }),
);

export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;

export const products = sqliteTable(
  'products',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    nameAr: text('name_ar'),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    // 'WEIGHT' | 'PACKAGE' | 'PIECE'
    sellingUnit: text('selling_unit').notNull(),
    // current price in minor units (cents for USD, integer LBP for LBP)
    currentPrice: integer('current_price').notNull(),
    priceCurrency: text('price_currency').notNull().default('USD'), // 'USD' | 'LBP'
    // current purchase cost in minor units (same currency as price_currency)
    currentCost: integer('current_cost'),
    lowStockThreshold: integer('low_stock_threshold'),
    // Stored as a base64 data URL string, null if no image
    imageDataUrl: text('image_data_url'),
    notes: text('notes'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    catIdx: index('product_category_idx').on(t.categoryId),
    activeIdx: index('product_active_idx').on(t.active),
  }),
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;

/* ------------------------------------------------------------------ */
/* Inventory                                                          */
/* ------------------------------------------------------------------ */

export const inventory = sqliteTable(
  'inventory',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' })
      .unique(),
    // Quantity as integer minor units of the unit.
    // WEIGHT: grams (1 KG = 1000g, so 1.350 KG stored as 1350)
    // PACKAGE / PIECE: integer count
    quantityMinor: integer('quantity_minor').notNull().default(0),
    // The cost basis currently tracked for profit on next sale (minor units in price_currency)
    averageCost: integer('average_cost'),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    prodIdx: uniqueIndex('inventory_product_idx').on(t.productId),
  }),
);

export type Inventory = typeof inventory.$inferSelect;

// Immutable audit trail of every stock movement
export const inventoryMovements = sqliteTable(
  'inventory_movements',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    // 'SALE' | 'ADD_STOCK' | 'WASTE' | 'RETURN' | 'ADJUSTMENT'
    movementType: text('movement_type').notNull(),
    // Signed delta in minor units. Positive = in, negative = out.
    deltaMinor: integer('delta_minor').notNull(),
    // Resulting quantity after movement (for audit)
    resultingQuantityMinor: integer('resulting_quantity_minor').notNull(),
    // Cost (minor units, price_currency) — relevant for ADD_STOCK
    unitCost: integer('unit_cost'),
    currency: text('currency'),
    // Reference to the related entity, if any
    saleId: integer('sale_id'),
    returnId: integer('return_id'),
    reason: text('reason'),
    notes: text('notes'),
    // USD-equivalent cost of the movement at the time it happened (WASTE)
    costUsdCents: integer('cost_usd_cents'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    prodIdx: index('inv_movement_product_idx').on(t.productId),
    typeIdx: index('inv_movement_type_idx').on(t.movementType),
    saleIdx: index('inv_movement_sale_idx').on(t.saleId),
    createdIdx: index('inv_movement_created_idx').on(t.createdAt),
  }),
);

/* ------------------------------------------------------------------ */
/* Sales (Invoices)                                                  */
/* ------------------------------------------------------------------ */

export const sales = sqliteTable(
  'sales',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // Human-readable invoice number, e.g. 2026-00001
    invoiceNumber: text('invoice_number').notNull().unique(),
    // Customer reference (optional)
    customerId: integer('customer_id'),
    // Status: 'COMPLETED' | 'SUSPENDED' | 'VOIDED' | 'RETURNED'
    status: text('status').notNull().default('COMPLETED'),
    // Totals stored in TWO currency buckets, both minor units.
    totalUsdCents: integer('total_usd_cents').notNull().default(0),
    totalLbp: integer('total_lbp').notNull().default(0),
    // Total cost of goods sold (in USD cents — converted at sale time using snapshot rate)
    costUsdCents: integer('cost_usd_cents').notNull().default(0),
    // Exchange rate snapshot at the time of sale (LBP per 1 USD)
    exchangeRateSnapshot: integer('exchange_rate_snapshot').notNull(),
    // Computed total in a single currency for reporting (USD cents equivalent at sale-time rate)
    totalUsdEquivalentCents: integer('total_usd_equivalent_cents')
      .notNull()
      .default(0),
    // Suspended sale metadata
    suspendedLabel: text('suspended_label'),
    // Idempotency key supplied by the POS for each sale attempt (prevents duplicates)
    clientRequestId: text('client_request_id'),
    // Part of the total put on the customer's account instead of paid (USD cents)
    creditUsdCents: integer('credit_usd_cents').notNull().default(0),
    // Timestamps
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    statusIdx: index('sale_status_idx').on(t.status),
    createdIdx: index('sale_created_idx').on(t.createdAt),
    customerIdx: index('sale_customer_idx').on(t.customerId),
  }),
);

export type Sale = typeof sales.$inferSelect;

export const saleItems = sqliteTable(
  'sale_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    saleId: integer('sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'restrict' }),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    // Snapshot of product info at time of sale (PRD section 50)
    productNameSnapshot: text('product_name_snapshot').notNull(),
    productNameArSnapshot: text('product_name_ar_snapshot'),
    categoryIdSnapshot: integer('category_id_snapshot').notNull(),
    sellingUnitSnapshot: text('selling_unit_snapshot').notNull(),
    // Quantity in minor units (grams for weight, integer count for piece/package)
    quantityMinor: integer('quantity_minor').notNull(),
    // Unit price snapshot (minor units)
    unitPriceMinor: integer('unit_price_minor').notNull(),
    priceCurrencySnapshot: text('price_currency_snapshot').notNull(),
    // Whether this line was priced via "direct final price" workflow (Workflow B)
    directFinalPrice: integer('direct_final_price', { mode: 'boolean' })
      .notNull()
      .default(false),
    // Line total in the line's currency (minor units)
    lineTotalMinor: integer('line_total_minor').notNull(),
    // Cost of goods for this line at time of sale (in line's currency minor units)
    unitCostSnapshot: integer('unit_cost_snapshot'),
    lineCostMinor: integer('line_cost_minor'),
    // Exchange rate snapshot used for any conversion at sale time
    exchangeRateSnapshot: integer('exchange_rate_snapshot').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    saleIdx: index('sale_item_sale_idx').on(t.saleId),
    prodIdx: index('sale_item_product_idx').on(t.productId),
  }),
);

export type SaleItem = typeof saleItems.$inferSelect;

/* ------------------------------------------------------------------ */
/* Payments                                                           */
/* ------------------------------------------------------------------ */

export const payments = sqliteTable(
  'payments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    saleId: integer('sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'restrict' }),
    // 'USD' | 'LBP' | 'MIXED' | 'CREDIT'
    paymentType: text('payment_type').notNull(),
    paidUsdCents: integer('paid_usd_cents').notNull().default(0),
    paidLbp: integer('paid_lbp').notNull().default(0),
    changeUsdCents: integer('change_usd_cents').notNull().default(0),
    changeLbp: integer('change_lbp').notNull().default(0),
    // Exchange rate snapshot used for change calculation
    exchangeRateSnapshot: integer('exchange_rate_snapshot').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    saleIdx: index('payment_sale_idx').on(t.saleId),
  }),
);

export type Payment = typeof payments.$inferSelect;

/* ------------------------------------------------------------------ */
/* Returns                                                            */
/* ------------------------------------------------------------------ */

export const returns = sqliteTable(
  'returns',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    returnNumber: text('return_number').notNull().unique(),
    originalSaleId: integer('original_sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'restrict' }),
    // 'FULL' | 'PARTIAL'
    returnType: text('return_type').notNull(),
    refundUsdCents: integer('refund_usd_cents').notNull().default(0),
    refundLbp: integer('refund_lbp').notNull().default(0),
    exchangeRateSnapshot: integer('exchange_rate_snapshot').notNull(),
    // Revenue reversed, in USD cents at the ORIGINAL sale rate (so reports reconcile)
    refundUsdEquivalentCents: integer('refund_usd_equivalent_cents').notNull().default(0),
    // Cost of goods reversed, in USD cents (from the sale-time cost snapshot)
    costUsdCents: integer('cost_usd_cents').notNull().default(0),
    reason: text('reason'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    origSaleIdx: index('return_original_sale_idx').on(t.originalSaleId),
  }),
);

export type Return = typeof returns.$inferSelect;

export const returnItems = sqliteTable(
  'return_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    returnId: integer('return_id')
      .notNull()
      .references(() => returns.id, { onDelete: 'cascade' }),
    saleItemId: integer('sale_item_id')
      .notNull()
      .references(() => saleItems.id, { onDelete: 'restrict' }),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    quantityReturnedMinor: integer('quantity_returned_minor').notNull(),
    refundLineMinor: integer('refund_line_minor').notNull(),
    refundCurrency: text('refund_currency').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    retIdx: index('return_item_return_idx').on(t.returnId),
    saleItemIdx: index('return_item_sale_item_idx').on(t.saleItemId),
    prodIdx: index('return_item_product_idx').on(t.productId),
  }),
);

/* ------------------------------------------------------------------ */
/* Expenses                                                           */
/* ------------------------------------------------------------------ */

export const expenses = sqliteTable(
  'expenses',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    date: integer('date', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    description: text('description').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull().default('USD'),
    category: text('category').notNull().default('OTHER'),
    // USD equivalent at expense date (for combined reports)
    amountUsdEquivalentCents: integer('amount_usd_equivalent_cents').notNull(),
    paymentSource: text('payment_source'),
    exchangeRateSnapshot: integer('exchange_rate_snapshot').notNull(),
    notes: text('notes'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    dateIdx: index('expense_date_idx').on(t.date),
    catIdx: index('expense_category_idx').on(t.category),
  }),
);

export type Expense = typeof expenses.$inferSelect;

/* ------------------------------------------------------------------ */
/* Customers (simple credit/debt)                                     */
/* ------------------------------------------------------------------ */

export const customers = sqliteTable(
  'customers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    phone: text('phone'),
    // Balance stored in USD cents equivalent at the time of each transaction.
    balanceUsdCents: integer('balance_usd_cents').notNull().default(0),
    notes: text('notes'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    nameIdx: index('customer_name_idx').on(t.name),
    phoneIdx: index('customer_phone_idx').on(t.phone),
  }),
);

export type Customer = typeof customers.$inferSelect;

export const customerTransactions = sqliteTable(
  'customer_transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    customerId: integer('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    // 'CREDIT' (sale on credit) | 'PAYMENT' (customer paid down balance) | 'ADJUSTMENT'
    transactionType: text('transaction_type').notNull(),
    // Signed amount in USD cents equivalent (positive = customer owes more)
    amountUsdCents: integer('amount_usd_cents').notNull(),
    cashAmountMinor: integer('cash_amount_minor'),
    cashCurrency: text('cash_currency'),
    roundingDifferenceLbp: integer('rounding_difference_lbp').notNull().default(0),
    saleId: integer('sale_id'),
    exchangeRateSnapshot: integer('exchange_rate_snapshot').notNull(),
    notes: text('notes'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    custIdx: index('cust_txn_customer_idx').on(t.customerId),
    saleIdx: index('cust_txn_sale_idx').on(t.saleId),
  }),
);

/* ------------------------------------------------------------------ */
/* Audit Log                                                          */
/* ------------------------------------------------------------------ */

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // 'SALE' | 'RETURN' | 'INVENTORY_ADJUSTMENT' | 'WASTE' | 'EXPENSE'
    // | 'EXCHANGE_RATE_CHANGE' | 'SETTINGS_CHANGE' | 'BACKUP' | 'RESTORE' | 'PRODUCT_CHANGE'
    action: text('action').notNull(),
    // Optional entity id
    entityId: integer('entity_id'),
    entityType: text('entity_type'),
    // JSON snapshot of the change payload
    payload: text('payload'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({
    actionIdx: index('audit_action_idx').on(t.action),
    createdIdx: index('audit_created_idx').on(t.createdAt),
  }),
);

export type AuditLog = typeof auditLog.$inferSelect;
