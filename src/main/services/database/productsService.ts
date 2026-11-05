/**
 * Products & Categories service.
 * PRD sections 9, 10, 14, 51.
 */

import { eq, and, asc, sql } from 'drizzle-orm';
import { getDb, getDrizzle, rowOf } from './connection';
import { getCurrentRate } from './exchangeRate';
import {
  categories,
  products,
  inventory,
  auditLog,
} from './schema';
import type { CategoryDTO, ProductDTO } from '@shared/types/index';
import type { Currency, SellingUnit } from '@shared/types/index';
import {
  requireNonEmptyString,
  requireCurrency,
  requireSellingUnit,
  requireOptionalImage,
  requireObject,
  requireId,
  requireSafeInt,
  optionalString,
  ValidationError,
} from '@shared/validation/index';
import { MAX_UNIT_PRICE_LBP, MAX_UNIT_PRICE_USD_CENTS, convertMinor } from '@shared/money/index';

function checkPrice(value: unknown, currency: Currency, label: string): number {
  const n = requireSafeInt(value, label, 0);
  if (n <= 0) throw new ValidationError(`${label} must be greater than zero`, label);
  const max = currency === 'USD' ? MAX_UNIT_PRICE_USD_CENTS : MAX_UNIT_PRICE_LBP;
  if (n > max) throw new ValidationError(`${label} is too large`, label);
  return n;
}

function checkCost(value: unknown, currency: Currency): number | null {
  if (value === null || value === undefined) return null;
  const n = requireSafeInt(value, 'Cost', 0);
  const max = currency === 'USD' ? MAX_UNIT_PRICE_USD_CENTS : MAX_UNIT_PRICE_LBP;
  if (n > max) throw new ValidationError('Cost is too large', 'Cost');
  return n;
}

function checkThreshold(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return requireSafeInt(value, 'Low stock threshold', 0);
}

/* ----------------- Categories ----------------- */

export function listCategories(activeOnly = false): CategoryDTO[] {
  const drizzle = getDrizzle();
  const rows = drizzle
    .select()
    .from(categories)
    .where(activeOnly ? eq(categories.active, true) : sql`1=1`)
    .orderBy(asc(categories.sortOrder), asc(categories.name))
    .all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    nameAr: r.nameAr,
    sortOrder: r.sortOrder,
    active: Boolean(r.active),
  }));
}

export function createCategory(rawInput: unknown): CategoryDTO {
  const input = requireObject(rawInput, 'Category');
  const name = requireNonEmptyString(input.name, 'Category name');
  if (name.length > 100) throw new ValidationError('Category name is too long');
  const nameAr = optionalString(input.nameAr, 100, 'Arabic name')?.trim() || null;
  const sortOrder = input.sortOrder === undefined ? 0 : requireSafeInt(input.sortOrder, 'Sort order', 0);
  const drizzle = getDrizzle();
  const result = drizzle
    .insert(categories)
    .values({
      name,
      nameAr,
      sortOrder,
      active: true,
    })
    .returning()
    .get();
  return {
    id: result.id,
    name: result.name,
    nameAr: result.nameAr,
    sortOrder: result.sortOrder,
    active: true,
  };
}

export function updateCategory(rawId: unknown, rawInput: unknown): void {
  const id = requireId(rawId, 'Category');
  const input = requireObject(rawInput, 'Category');
  const drizzle = getDrizzle();
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) {
    updates.name = requireNonEmptyString(input.name, 'Category name');
  }
  if (input.nameAr !== undefined) {
    updates.nameAr = optionalString(input.nameAr, 100, 'Arabic name')?.trim() || null;
  }
  if (input.sortOrder !== undefined) {
    updates.sortOrder = requireSafeInt(input.sortOrder, 'Sort order', 0);
  }
  const db = getDb();
  db.transaction(() => {
    const before = rowOf(categories, db.prepare('SELECT * FROM categories WHERE id = ?').get(id));
    if (!before) throw new ValidationError('Category not found');
    drizzle.update(categories).set(updates).where(eq(categories.id, id)).run();
    const after = rowOf(categories, db.prepare('SELECT * FROM categories WHERE id = ?').get(id));
    drizzle.insert(auditLog).values({
      action: 'CATEGORY_UPDATE', entityId: id, entityType: 'category',
      payload: JSON.stringify({
        before: { name: before.name, nameAr: before.nameAr, sortOrder: before.sortOrder },
        after: { name: after?.name, nameAr: after?.nameAr, sortOrder: after?.sortOrder },
      }),
    }).run();
  }).immediate();
}

export function toggleCategoryActive(rawId: unknown): void {
  const id = requireId(rawId, 'Category');
  const drizzle = getDrizzle();
  const db = getDb();
  db.transaction(() => {
    const before = rowOf(categories, db.prepare('SELECT * FROM categories WHERE id = ?').get(id));
    if (!before) throw new ValidationError('Category not found');
    const active = !Boolean(before.active);
    drizzle.update(categories).set({ active, updatedAt: new Date() }).where(eq(categories.id, id)).run();
    drizzle.insert(auditLog).values({
      action: 'CATEGORY_STATUS', entityId: id, entityType: 'category',
      payload: JSON.stringify({ activeFrom: Boolean(before.active), activeTo: active }),
    }).run();
  }).immediate();
}

/* ----------------- Products ----------------- */

function toProductDTO(raw: unknown): ProductDTO {
  const row = {
    ...rowOf(products, raw)!,
    ...(raw as {
      stock_minor?: number | null;
      category_name?: string | null;
      category_name_ar?: string | null;
    }),
  };
  return {
    id: row.id,
    name: row.name,
    nameAr: row.nameAr,
    categoryId: row.categoryId,
    sellingUnit: row.sellingUnit as SellingUnit,
    currentPrice: row.currentPrice,
    priceCurrency: row.priceCurrency as Currency,
    currentCost: row.currentCost ?? null,
    lowStockThreshold: row.lowStockThreshold ?? null,
    imageDataUrl: row.imageDataUrl,
    notes: row.notes,
    // Drizzle returns integer 0/1 for boolean columns when read via raw SQL.
    active: Boolean(row.active),
    stockMinor: row.stock_minor ?? undefined,
    categoryName: row.category_name ?? undefined,
    categoryNameAr: row.category_name_ar ?? null,
  };
}

export function listProducts(activeOnly = false): ProductDTO[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT p.*, i.quantity_minor AS stock_minor, c.name AS category_name, c.name_ar AS category_name_ar
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id
       LEFT JOIN categories c ON c.id = p.category_id
       ${activeOnly ? 'WHERE p.active = 1' : ''}
       ORDER BY p.name COLLATE NOCASE ASC`,
    )
        .all();
  return rows.map(toProductDTO);
}

export function listActiveProducts(): ProductDTO[] {
  return listProducts(true);
}

export function getProduct(id: number): ProductDTO | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT p.*, i.quantity_minor AS stock_minor, c.name AS category_name, c.name_ar AS category_name_ar
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.id = ?`,
    )
    .get(id);
  return row ? toProductDTO(row) : null;
}

/**
 * Owner policy: money is stored in USD only. When the shop owner enters a price/cost in LBP
 * (`storeAsUsd: true`), convert it ONCE at the current exchange rate and store USD cents.
 * (The flag keeps direct LBP-denominated records valid for old data and tests.)
 */
function normalizeEntry(input: Record<string, unknown>): Record<string, unknown> {
  if (input.storeAsUsd !== true || input.priceCurrency !== 'LBP') return input;
  const rate = getCurrentRate().currentRate;
  const out: Record<string, unknown> = { ...input, priceCurrency: 'USD' };
  const conv = (v: unknown, label: string) => {
    const lbp = checkPrice(v, 'LBP', label);
    return convertMinor(lbp, 'LBP', 'USD', rate);
  };
  if (input.currentPrice !== undefined) {
    out.currentPrice = conv(input.currentPrice, 'Selling price');
    if ((out.currentPrice as number) <= 0) throw new ValidationError('Selling price is too small to store in USD.');
  }
  if (input.currentCost !== undefined && input.currentCost !== null) {
    out.currentCost = conv(input.currentCost, 'Purchase cost');
  }
  return out;
}

export function createProduct(rawInput: unknown): ProductDTO {
  const input = normalizeEntry(requireObject(rawInput, 'Product'));
  const name = requireNonEmptyString(input.name, 'Product name');
  if (name.length > 200) throw new ValidationError('Product name is too long');
  const sellingUnit = requireSellingUnit(input.sellingUnit);
  const currency = requireCurrency(input.priceCurrency);
  const currentPrice = checkPrice(input.currentPrice, currency, 'Selling price');
  const categoryId = requireId(input.categoryId, 'Category');
  const currentCost = checkCost(input.currentCost, currency);
  const lowStockThreshold = checkThreshold(input.lowStockThreshold);
  const imageDataUrl = requireOptionalImage(input.imageDataUrl ?? null);
  const nameAr = optionalString(input.nameAr, 200, 'Arabic name')?.trim() || null;
  const notes = optionalString(input.notes, 1000, 'Notes')?.trim() || null;

  const drizzle = getDrizzle();
  const created = getDb().transaction(() => {
    const cat = getDb().prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
    if (!cat) throw new ValidationError('Valid category is required');
    const result = drizzle
      .insert(products)
      .values({
        name,
        nameAr,
        categoryId,
        sellingUnit,
        currentPrice,
        priceCurrency: currency,
        currentCost,
        lowStockThreshold,
        imageDataUrl,
        notes,
        active: true,
      })
      .returning()
      .get();
    drizzle.insert(inventory).values({ productId: result.id, quantityMinor: 0 }).run();
    drizzle.insert(auditLog).values({
      action: 'PRODUCT_CHANGE',
      entityId: result.id,
      entityType: 'product',
      payload: JSON.stringify({ event: 'create', name, price: currentPrice, currency }),
    }).run();
    return result;
  })();
  return getProduct(created.id)!;
}

export function updateProduct(rawId: unknown, rawInput: unknown): void {
  const id = requireId(rawId, 'Product');
  const input = normalizeEntry(requireObject(rawInput, 'Product'));
  const db = getDb();
  const drizzle = getDrizzle();

  db.transaction(() => {
    const before = rowOf(products, db.prepare('SELECT * FROM products WHERE id = ?').get(id));
    if (!before) throw new ValidationError('Product not found');

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    const currency =
      input.priceCurrency !== undefined
        ? requireCurrency(input.priceCurrency)
        : (before.priceCurrency as Currency);

    if (input.name !== undefined) {
      const n = requireNonEmptyString(input.name, 'Product name');
      if (n.length > 200) throw new ValidationError('Product name is too long');
      updates.name = n;
    }
    if (input.nameAr !== undefined) {
      updates.nameAr = optionalString(input.nameAr, 200, 'Arabic name')?.trim() || null;
    }
    if (input.categoryId !== undefined) {
      const cid = requireId(input.categoryId, 'Category');
      if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(cid)) {
        throw new ValidationError('Valid category is required');
      }
      updates.categoryId = cid;
    }
    if (input.sellingUnit !== undefined) {
      const unit = requireSellingUnit(input.sellingUnit);
      if (unit !== before.sellingUnit) {
        // Stock and history are stored in the unit's minor units (grams vs pieces), so the
        // unit can only change while the product has no stock and no history.
        const used = db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM sale_items WHERE product_id = ?) +
               (SELECT COUNT(*) FROM inventory_movements WHERE product_id = ?) +
               (SELECT quantity_minor FROM inventory WHERE product_id = ?) AS n`,
          )
          .get(id, id, id) as { n: number };
        if (used.n > 0) {
          throw new ValidationError(
            'The selling unit cannot be changed once the product has stock or sales. Create a new product instead.',
          );
        }
      }
      updates.sellingUnit = unit;
    }
    if (input.priceCurrency !== undefined) {
      if (currency !== before.priceCurrency) {
        // Amounts are stored in the product currency; never reinterpret old numbers silently.
        if (input.currentPrice === undefined) {
          throw new ValidationError('Enter a new selling price when changing the product currency.');
        }
        if (input.currentCost === undefined && before.currentCost != null) {
          throw new ValidationError('Enter a new purchase cost (or clear it) when changing the product currency.');
        }
      }
      updates.priceCurrency = currency;
    }
    if (input.currentPrice !== undefined) {
      updates.currentPrice = checkPrice(input.currentPrice, currency, 'Selling price');
    }
    if (input.currentCost !== undefined) updates.currentCost = checkCost(input.currentCost, currency);
    if (input.lowStockThreshold !== undefined) {
      updates.lowStockThreshold = checkThreshold(input.lowStockThreshold);
    }
    if (input.imageDataUrl !== undefined) {
      updates.imageDataUrl = requireOptionalImage(input.imageDataUrl);
    }
    if (input.notes !== undefined) {
      updates.notes = optionalString(input.notes, 1000, 'Notes')?.trim() || null;
    }

    drizzle.update(products).set(updates).where(eq(products.id, id)).run();
    drizzle.insert(auditLog).values({
      action: 'PRODUCT_CHANGE',
      entityId: id,
      entityType: 'product',
      payload: JSON.stringify({
        event: 'update',
        fields: Object.keys(updates).filter((k) => k !== 'updatedAt'),
        oldPrice: before.currentPrice,
        oldCurrency: before.priceCurrency,
        newPrice: updates.currentPrice ?? before.currentPrice,
        newCurrency: currency,
      }),
    }).run();
  })();
}

export function toggleProductActive(rawId: unknown): void {
  const id = requireId(rawId, 'Product');
  const drizzle = getDrizzle();
  getDb().transaction(() => {
    if (!getDb().prepare('SELECT id FROM products WHERE id = ?').get(id)) {
      throw new ValidationError('Product not found');
    }
    drizzle
      .update(products)
      .set({ active: sql`NOT active`, updatedAt: new Date() })
      .where(eq(products.id, id))
      .run();
    drizzle.insert(auditLog).values({
      action: 'PRODUCT_CHANGE',
      entityId: id,
      entityType: 'product',
      payload: JSON.stringify({ event: 'toggle_active' }),
    }).run();
  })();
}

/**
 * Search products by name (Arabic or English).
 */
export function searchProducts(query: string, activeOnly = true): ProductDTO[] {
  const db = getDb();
  const pattern = `%${query.trim()}%`;
  const rows = db
    .prepare(
      `SELECT p.*, i.quantity_minor AS stock_minor, c.name AS category_name, c.name_ar AS category_name_ar
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${activeOnly ? 'p.active = 1 AND' : ''} (p.name LIKE ? OR p.name_ar LIKE ? OR c.name LIKE ? OR c.name_ar LIKE ?)
       ORDER BY p.name COLLATE NOCASE ASC`,
    )
    .all(pattern, pattern, pattern, pattern);
  return rows.map(toProductDTO);
}
