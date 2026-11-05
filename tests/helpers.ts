import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase, closeDatabase, getDb } from '../src/main/services/database/connection';
import { completeFirstRun } from '../src/main/services/database/settingsService';
import { createProduct, listCategories } from '../src/main/services/database/productsService';
import { addStock } from '../src/main/services/database/inventoryService';
import type { ProductDTO } from '../src/shared/types/index';

export const RATE = 89500;
const dirs: string[] = [];

/** Fresh isolated DB in its own temp dir (never touches a production database). */
export function freshDb(opts: { setup?: boolean } = {}): { dir: string; dbPath: string } {
  try { closeDatabase(); } catch { /* none open */ }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-test-'));
  dirs.push(dir);
  const dbPath = path.join(dir, 'test.db');
  initDatabase(dbPath);
  if (opts.setup !== false) {
    completeFirstRun({ shopName: 'Test Shop', defaultCurrency: 'USD', language: 'en', exchangeRate: RATE });
  }
  return { dir, dbPath };
}

export function cleanup(): void {
  try { closeDatabase(); } catch { /* ignore */ }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

export function makeProduct(p: {
  name?: string; unit?: 'WEIGHT' | 'PIECE' | 'PACKAGE'; price: number; currency?: 'USD' | 'LBP';
  cost?: number | null; stock?: number;
}): ProductDTO {
  const cat = listCategories()[0];
  const prod = createProduct({
    name: p.name ?? `P${Math.random().toString(36).slice(2, 7)}`,
    sellingUnit: p.unit ?? 'PIECE',
    priceCurrency: p.currency ?? 'USD',
    currentPrice: p.price,
    currentCost: p.cost ?? null,
    categoryId: cat.id,
  });
  if (p.stock) {
    addStock({ productId: prod.id, quantityMinor: p.stock, currency: p.currency ?? 'USD', unitCostMinor: p.cost ?? null });
  }
  return prod;
}

export function stockOf(productId: number): number {
  const r = getDb().prepare('SELECT quantity_minor q FROM inventory WHERE product_id=?').get(productId) as { q: number } | undefined;
  return r?.q ?? 0;
}
