/**
 * Inventory service.
 *
 * PRD sections 29-37, 64.
 *
 * Inventory is stored in integer minor units:
 *   - WEIGHT: grams (1 KG = 1000g → 1.350 KG = 1350g)
 *   - PACKAGE / PIECE: integer count
 *
 * All stock mutations go through inventory_movements for auditability.
 */

import { eq, desc, gte, and, sql, lte } from 'drizzle-orm';
import { getDb, getDrizzle, rowOf } from './connection';
import {
  inventory,
  inventoryMovements,
  products,
  auditLog,
} from './schema';
import type {
  InventoryDTO,
  MovementType,
  AddStockInput,
  WasteInput,
} from '@shared/types/index';
import {
  requirePositiveInteger,
  requireNonNegativeInteger,
  requireCurrency,
  requireObject,
  requireId,
  optionalString,
  optionalLimit,
  ValidationError,
} from '@shared/validation/index';
import {
  lbpToUsdCents,
  convertMinor,
  computeLineCost,
  formatWeightKg,
  MAX_UNIT_PRICE_LBP,
  MAX_UNIT_PRICE_USD_CENTS,
} from '@shared/money/index';
import { getCurrentRate } from './exchangeRate';

/** Largest stock quantity accepted (1,000,000 kg in grams / 1e9 pieces). */
const MAX_STOCK_MINOR = 1_000_000_000;

function formatQty(minor: number, unit: string): string {
  return unit === 'WEIGHT' ? `${formatWeightKg(minor)} KG` : String(minor);
}

type ProductInfo = {
  id: number;
  name: string;
  selling_unit: string;
  price_currency: string;
  current_cost: number | null;
};

function loadProductInfo(productId: number): ProductInfo {
  const p = getDb()
    .prepare(
      'SELECT id, name, selling_unit, price_currency, current_cost FROM products WHERE id = ?',
    )
    .get(productId) as ProductInfo | undefined;
  if (!p) throw new ValidationError('Product not found');
  return p;
}

export function getInventory(productId: number): InventoryDTO | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT i.*, p.name AS product_name, p.name_ar AS product_name_ar,
              p.selling_unit, p.price_currency, p.current_cost, p.low_stock_threshold
       FROM inventory i
       JOIN products p ON p.id = i.product_id
       WHERE i.product_id = ?`,
    )
    .get(productId) as
    | {
        product_id: number;
        quantity_minor: number;
        product_name: string;
        product_name_ar: string | null;
        selling_unit: string;
        price_currency: string;
        current_cost: number | null;
        low_stock_threshold: number | null;
      }
    | undefined;

  if (!row) return null;
  return {
    productId: row.product_id,
    productName: row.product_name,
    productNameAr: row.product_name_ar,
    sellingUnit: row.selling_unit as InventoryDTO['sellingUnit'],
    priceCurrency: row.price_currency as InventoryDTO['priceCurrency'],
    currentCost: row.current_cost,
    quantityMinor: row.quantity_minor,
    lowStockThreshold: row.low_stock_threshold,
  };
}

export function listInventory(): InventoryDTO[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT i.*, p.name AS product_name, p.name_ar AS product_name_ar,
              p.selling_unit, p.price_currency, p.current_cost, p.low_stock_threshold
       FROM inventory i
       JOIN products p ON p.id = i.product_id
       ORDER BY p.name COLLATE NOCASE ASC`,
    )
    .all()
    .map((r) => ({
      ...rowOf(inventory, r)!,
      ...(r as {
        product_name: string;
        product_name_ar: string | null;
        selling_unit: string;
        price_currency: string;
        current_cost: number | null;
        low_stock_threshold: number | null;
      }),
      ...rowOf(inventory, r)!,
    }));
  return rows.map((r) => ({
    productId: r.productId,
    productName: r.product_name,
    productNameAr: r.product_name_ar,
    sellingUnit: r.selling_unit as InventoryDTO['sellingUnit'],
    priceCurrency: r.price_currency as InventoryDTO['priceCurrency'],
    currentCost: r.current_cost,
    quantityMinor: r.quantityMinor,
    lowStockThreshold: r.low_stock_threshold,
  }));
}

export function listLowStock(): InventoryDTO[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT i.*, p.name AS product_name, p.name_ar AS product_name_ar,
              p.selling_unit, p.price_currency, p.current_cost, p.low_stock_threshold
       FROM inventory i
       JOIN products p ON p.id = i.product_id
       WHERE p.low_stock_threshold IS NOT NULL
         AND i.quantity_minor < p.low_stock_threshold
         AND p.active = 1
       ORDER BY p.name COLLATE NOCASE ASC`,
    )
    .all()
    .map((r) => ({
      ...rowOf(inventory, r)!,
      ...(r as {
        product_name: string;
        product_name_ar: string | null;
        selling_unit: string;
        price_currency: string;
        current_cost: number | null;
        low_stock_threshold: number | null;
      }),
      ...rowOf(inventory, r)!,
    }));
  return rows.map((r) => ({
    productId: r.productId,
    productName: r.product_name,
    productNameAr: r.product_name_ar,
    sellingUnit: r.selling_unit as InventoryDTO['sellingUnit'],
    priceCurrency: r.price_currency as InventoryDTO['priceCurrency'],
    currentCost: r.current_cost,
    quantityMinor: r.quantityMinor,
    lowStockThreshold: r.low_stock_threshold,
  }));
}

/**
 * Add stock to a product, optionally recording purchase cost.
 * PRD sections 30, 31: stock additions may include a purchase cost; historical
 * costs are never overwritten — they are preserved in inventory_movements.
 */
export function addStock(rawInput: unknown): InventoryDTO {
  const o = requireObject(rawInput, 'Stock');
  const productId = requireId(o.productId, 'Product');
  const quantity = requirePositiveInteger(o.quantityMinor, 'Quantity');
  if (quantity > MAX_STOCK_MINOR) throw new ValidationError('Quantity is too large');
  const currency = requireCurrency(o.currency);
  let unitCost: number | null = null;
  if (o.unitCostMinor !== null && o.unitCostMinor !== undefined) {
    unitCost = requireNonNegativeInteger(o.unitCostMinor, 'Unit cost');
    const max = currency === 'USD' ? MAX_UNIT_PRICE_USD_CENTS : MAX_UNIT_PRICE_LBP;
    if (unitCost > max) throw new ValidationError('Unit cost is too large');
  }
  const notes = optionalString(o.notes, 500, 'Notes') ?? null;

  const drizzle = getDrizzle();
  const db = getDb();

  db.transaction(() => {
    const product = loadProductInfo(productId);
    const current = db
      .prepare('SELECT quantity_minor FROM inventory WHERE product_id = ?')
      .get(productId) as { quantity_minor: number } | undefined;
    if (!current) {
      throw new ValidationError('Product has no inventory row');
    }
    const newQty = current.quantity_minor + quantity;
    if (newQty > MAX_STOCK_MINOR * 10) throw new ValidationError('Stock quantity is too large');

    // Costing rule (documented in RELEASE docs): the product's "current cost" is the
    // LATEST purchase cost. It is always kept in the product's selling currency, so a
    // cost typed in another currency is converted at today's rate. The original value
    // is preserved untouched in inventory_movements (history is never overwritten).
    if (unitCost !== null) {
      const rate = getCurrentRate().currentRate;
      const converted = convertMinor(
        unitCost,
        currency,
        product.price_currency as 'USD' | 'LBP',
        rate,
      );
      drizzle
        .update(products)
        .set({ currentCost: converted, updatedAt: new Date() })
        .where(eq(products.id, productId))
        .run();
    }

    drizzle
      .update(inventory)
      .set({ quantityMinor: newQty, updatedAt: new Date() })
      .where(eq(inventory.productId, productId))
      .run();

    drizzle.insert(inventoryMovements).values({
      productId,
      movementType: 'ADD_STOCK',
      deltaMinor: quantity,
      resultingQuantityMinor: newQty,
      unitCost,
      currency,
      reason: null,
      notes,
    }).run();

    drizzle.insert(auditLog).values({
      action: 'INVENTORY_ADJUSTMENT',
      entityId: productId,
      entityType: 'product',
      payload: JSON.stringify({ event: 'add_stock', quantity, unitCost, currency }),
    }).run();
  }).immediate();

  return getInventory(productId)!;
}

/**
 * Record damaged/wasted stock. Reduces inventory. Visible in reports.
 * PRD section 36.
 */
export function recordWaste(rawInput: unknown): InventoryDTO {
  const o = requireObject(rawInput, 'Waste');
  const productId = requireId(o.productId, 'Product');
  const quantity = requirePositiveInteger(o.quantityMinor, 'Quantity');
  const reason = optionalString(o.reason, 100, 'Reason')?.trim();
  if (!reason) {
    throw new ValidationError('Reason is required for waste');
  }
  const notes = optionalString(o.notes, 500, 'Notes') ?? null;

  const drizzle = getDrizzle();
  const db = getDb();

  db.transaction(() => {
    const product = loadProductInfo(productId);
    const current = db
      .prepare('SELECT quantity_minor FROM inventory WHERE product_id = ?')
      .get(productId) as { quantity_minor: number } | undefined;
    if (!current) {
      throw new ValidationError('Product has no inventory row');
    }
    if (current.quantity_minor < quantity) {
      throw new ValidationError(
        `Cannot record waste of ${formatQty(quantity, product.selling_unit)}; only ${formatQty(current.quantity_minor, product.selling_unit)} in stock`,
      );
    }
    const newQty = current.quantity_minor - quantity;

    // Cost of the wasted goods at the time of waste (PRD 50): stored once, so reports
    // never change when the product cost or the exchange rate changes later.
    let costUsdCents = 0;
    let unitCost: number | null = null;
    if (product.current_cost !== null) {
      unitCost = product.current_cost;
      const lineCost = computeLineCost(
        quantity,
        product.current_cost,
        product.selling_unit as 'WEIGHT' | 'PACKAGE' | 'PIECE',
      );
      costUsdCents =
        product.price_currency === 'USD'
          ? lineCost
          : lbpToUsdCents(lineCost, getCurrentRate().currentRate);
    }

    drizzle
      .update(inventory)
      .set({ quantityMinor: newQty, updatedAt: new Date() })
      .where(eq(inventory.productId, productId))
      .run();

    drizzle.insert(inventoryMovements).values({
      productId,
      movementType: 'WASTE',
      deltaMinor: -quantity,
      resultingQuantityMinor: newQty,
      unitCost,
      currency: product.price_currency,
      reason,
      notes,
      costUsdCents,
    }).run();

    drizzle.insert(auditLog).values({
      action: 'WASTE',
      entityId: productId,
      entityType: 'product',
      payload: JSON.stringify({ quantity, reason, costUsdCents }),
    }).run();
  }).immediate();

  return getInventory(productId)!;
}

/**
 * Manual adjustment (rare, for correcting discrepancies).
 * PRD section 35: keep simple, not a major workflow.
 */
export function adjustStock(
  productId: number,
  newQuantityMinor: number,
  reason: string,
  notes?: string,
): InventoryDTO {
  requireId(productId, 'Product');
  requireNonNegativeInteger(newQuantityMinor, 'New quantity');
  if (newQuantityMinor > MAX_STOCK_MINOR * 10) throw new ValidationError('Quantity is too large');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 100) {
    throw new ValidationError('Reason is required for adjustment');
  }
  notes = optionalString(notes, 500, 'Notes');

  const drizzle = getDrizzle();
  const db = getDb();

  const tx = db.transaction(() => {
    const current = db
      .prepare('SELECT quantity_minor FROM inventory WHERE product_id = ?')
      .get(productId) as { quantity_minor: number } | undefined;
    if (!current) {
      throw new ValidationError('Product has no inventory row');
    }
    const delta = newQuantityMinor - current.quantity_minor;

    drizzle
      .update(inventory)
      .set({
        quantityMinor: newQuantityMinor,
        updatedAt: new Date(),
      })
      .where(eq(inventory.productId, productId))
      .run();

    drizzle.insert(inventoryMovements).values({
      productId,
      movementType: 'ADJUSTMENT',
      deltaMinor: delta,
      resultingQuantityMinor: newQuantityMinor,
      reason,
      notes: notes ?? null,
    }).run();

    drizzle.insert(auditLog).values({
      action: 'INVENTORY_ADJUSTMENT',
      entityId: productId,
      entityType: 'product',
      payload: JSON.stringify({
        event: 'manual_adjust',
        delta,
        newQuantity: newQuantityMinor,
        reason,
      }),
    }).run();
  });
  tx();

  return getInventory(productId)!;
}

/**
 * Internal helper used by the sales service.
 * Decrements inventory by `quantityMinor` units and writes an inventory_movement row.
 * Throws if insufficient stock.
 */
export function decrementForSale(
  productId: number,
  quantityMinor: number,
  saleId: number,
): number {
  if (!Number.isInteger(quantityMinor) || quantityMinor <= 0) {
    throw new ValidationError('Sale quantity must be positive integer (minor units)');
  }
  const db = getDb();
  const drizzle = getDrizzle();
  const current = db
    .prepare('SELECT quantity_minor FROM inventory WHERE product_id = ?')
    .get(productId) as { quantity_minor: number } | undefined;
  if (!current) {
    throw new ValidationError('Product has no inventory row');
  }
  if (current.quantity_minor < quantityMinor) {
    // PRD 64: selling more than the recorded stock is refused with a clear message
    // (stock never silently goes negative). The shop adds stock first.
    const p = loadProductInfo(productId);
    throw new ValidationError(
      `Not enough stock for "${p.name}": available ${formatQty(current.quantity_minor, p.selling_unit)}, needed ${formatQty(quantityMinor, p.selling_unit)}.`,
    );
  }
  const newQty = current.quantity_minor - quantityMinor;
  drizzle
    .update(inventory)
    .set({ quantityMinor: newQty, updatedAt: new Date() })
    .where(eq(inventory.productId, productId))
    .run();
  drizzle.insert(inventoryMovements).values({
    productId,
    movementType: 'SALE',
    deltaMinor: -quantityMinor,
    resultingQuantityMinor: newQty,
    saleId,
  }).run();
  return newQty;
}

/**
 * Internal helper used by the returns service.
 * Increments inventory back when items are returned.
 */
export function incrementForReturn(
  productId: number,
  quantityMinor: number,
  returnId: number,
): number {
  const db = getDb();
  const drizzle = getDrizzle();
  const current = db
    .prepare('SELECT quantity_minor FROM inventory WHERE product_id = ?')
    .get(productId) as { quantity_minor: number } | undefined;
  if (!current) {
    throw new ValidationError('Product has no inventory row');
  }
  const newQty = current.quantity_minor + quantityMinor;
  drizzle
    .update(inventory)
    .set({ quantityMinor: newQty, updatedAt: new Date() })
    .where(eq(inventory.productId, productId))
    .run();
  drizzle.insert(inventoryMovements).values({
    productId,
    movementType: 'RETURN',
    deltaMinor: quantityMinor,
    resultingQuantityMinor: newQty,
    returnId,
  }).run();
  return newQty;
}

export function listMovements(
  rawProductId?: unknown,
  rawLimit?: unknown,
): Array<{
  id: number;
  productId: number;
  productName: string;
  movementType: MovementType;
  deltaMinor: number;
  resultingQuantityMinor: number;
  unitCost: number | null;
  currency: string | null;
  saleId: number | null;
  returnId: number | null;
  reason: string | null;
  notes: string | null;
  createdAt: number;
}> {
  const productId =
    rawProductId === undefined || rawProductId === null ? undefined : requireId(rawProductId, 'Product');
  const limit = optionalLimit(rawLimit, 200, 1000);
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT m.*, p.name AS product_name
       FROM inventory_movements m
       JOIN products p ON p.id = m.product_id
       ${productId ? 'WHERE m.product_id = ?' : ''}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ?`,
    )
    .all(...(productId ? [productId] : []), limit)
    .map((r) => ({ ...rowOf(inventoryMovements, r)!, product_name: (r as { product_name: string }).product_name }));
  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    productName: r.product_name,
    movementType: r.movementType as MovementType,
    deltaMinor: r.deltaMinor,
    resultingQuantityMinor: r.resultingQuantityMinor,
    unitCost: r.unitCost,
    currency: r.currency,
    saleId: r.saleId,
    returnId: r.returnId,
    reason: r.reason,
    notes: r.notes,
    createdAt: Math.floor(r.createdAt.getTime() / 1000),
  }));
}
