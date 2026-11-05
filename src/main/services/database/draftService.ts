/**
 * Draft cart recovery (crash safety for the POS screen).
 *
 * A draft is NOT a sale: saving one never touches stock, invoice numbers, payments or
 * reports. It holds only product ids, quantities and (for weight "final price" lines) the
 * final price. No customer, payment or personal data is stored.
 *
 * Rules (documented in the PRD addendum, "Draft cart"):
 *  - Prices are NEVER restored from the draft: normal lines are re-priced from the current
 *    product price, and the exchange rate is whatever is current when the sale completes.
 *  - Lines whose product is missing, inactive or invalid are dropped and reported.
 *  - The draft carries a `requestId`. It is the sale's idempotency key, so a draft whose sale
 *    was already committed (crash between commit and cleanup) is detected and discarded
 *    instead of being sold twice.
 *  - Corrupt / unreadable drafts are discarded silently (the cashier just starts a new cart).
 */
import { getDb } from './connection';
import { getProduct } from './productsService';
import { setAppSetting } from './settingsService';
import {
  ValidationError,
  requireObject,
  requireId,
  requireSafeInt,
  requireCurrency,
} from '@shared/validation/index';
import { computeLineTotal, MAX_USD_CENTS, MAX_LBP, MAX_PIECE_QUANTITY, MAX_WEIGHT_GRAMS } from '@shared/money/index';
import type { ProductDTO, Currency } from '@shared/types/index';

const KEY = 'draft_cart';
const MAX_LINES = 500;
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

interface StoredLine {
  productId: number;
  quantityMinor: number;
  directFinalPrice: boolean;
  lineTotalMinor: number;
  priceCurrency?: Currency;
}
interface StoredDraft {
  requestId: string;
  savedAt: number;
  lines: StoredLine[];
}

export interface DraftItem {
  product: ProductDTO;
  quantityMinor: number;
  unitPriceMinor: number;
  priceCurrency: Currency;
  directFinalPrice: boolean;
  lineTotalMinor: number;
  /** True when the product price changed since the draft was saved. */
  repriced: boolean;
}
export interface DraftCart {
  requestId: string;
  savedAt: number;
  items: DraftItem[];
  dropped: Array<{ productId: number; reason: 'missing' | 'inactive' | 'invalid' }>;
}

export function clearDraftCart(): void {
  getDb().prepare('DELETE FROM app_settings WHERE key = ?').run(KEY);
}

export function saveDraftCart(rawInput: unknown): void {
  const o = requireObject(rawInput, 'Draft');
  if (typeof o.requestId !== 'string' || !REQUEST_ID.test(o.requestId)) {
    throw new ValidationError('Invalid draft id');
  }
  if (!Array.isArray(o.lines) || o.lines.length > MAX_LINES) {
    throw new ValidationError('Invalid draft lines');
  }
  if (o.lines.length === 0) {
    clearDraftCart(); // an empty cart is not worth keeping
    return;
  }
  const lines: StoredLine[] = o.lines.map((l, i) => {
    const r = requireObject(l, `Draft line ${i + 1}`);
    return {
      productId: requireId(r.productId, 'Product'),
      quantityMinor: requireSafeInt(r.quantityMinor, 'Quantity', 1),
      directFinalPrice: r.directFinalPrice === true,
      lineTotalMinor: requireSafeInt(r.lineTotalMinor ?? 0, 'Line total', 0),
      ...(r.priceCurrency === undefined
        ? {}
        : { priceCurrency: requireCurrency(r.priceCurrency) }),
    };
  });
  const draft: StoredDraft = { requestId: o.requestId, savedAt: Math.floor(Date.now() / 1000), lines };
  setAppSetting(KEY, JSON.stringify(draft));
}

function parseStored(text: string): StoredDraft | null {
  try {
    const d = JSON.parse(text) as StoredDraft;
    if (!d || typeof d.requestId !== 'string' || !REQUEST_ID.test(d.requestId)) return null;
    if (!Array.isArray(d.lines) || d.lines.length === 0 || d.lines.length > MAX_LINES) return null;
    for (const l of d.lines) {
      if (!Number.isSafeInteger(l.productId) || !Number.isSafeInteger(l.quantityMinor) || l.quantityMinor <= 0) return null;
      if (l.priceCurrency !== undefined && l.priceCurrency !== 'USD' && l.priceCurrency !== 'LBP') return null;
    }
    return { requestId: d.requestId, savedAt: Number(d.savedAt) || 0, lines: d.lines };
  } catch {
    return null;
  }
}

export function getDraftCart(): DraftCart | null {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  const stored = parseStored(row.value);
  if (!stored) {
    clearDraftCart();
    return null;
  }
  // Already sold (committed just before a crash)? Then the draft is obsolete.
  const sold = getDb()
    .prepare('SELECT id FROM sales WHERE client_request_id = ?')
    .get(stored.requestId);
  if (sold) {
    clearDraftCart();
    return null;
  }

  const items: DraftItem[] = [];
  const dropped: DraftCart['dropped'] = [];
  for (const l of stored.lines) {
    const product = getProduct(l.productId);
    if (!product) {
      dropped.push({ productId: l.productId, reason: 'missing' });
      continue;
    }
    if (!product.active) {
      dropped.push({ productId: l.productId, reason: 'inactive' });
      continue;
    }
    const isWeight = product.sellingUnit === 'WEIGHT';
    const priceCurrency = l.directFinalPrice
      ? l.priceCurrency ?? product.priceCurrency
      : product.priceCurrency;
    const maxQty = isWeight ? MAX_WEIGHT_GRAMS : MAX_PIECE_QUANTITY;
    const maxTotal = priceCurrency === 'USD' ? MAX_USD_CENTS : MAX_LBP;
    if (l.quantityMinor > maxQty || (l.directFinalPrice && (!isWeight || l.lineTotalMinor <= 0 || l.lineTotalMinor > maxTotal))) {
      dropped.push({ productId: l.productId, reason: 'invalid' });
      continue;
    }
    if (l.directFinalPrice) {
      items.push({
        product, quantityMinor: l.quantityMinor, unitPriceMinor: l.lineTotalMinor,
        priceCurrency, directFinalPrice: true,
        lineTotalMinor: l.lineTotalMinor, repriced: false,
      });
      continue;
    }
    try {
      const lineTotal = computeLineTotal(l.quantityMinor, product.currentPrice, product.sellingUnit, product.priceCurrency);
      if (lineTotal <= 0) throw new Error('zero');
      items.push({
        product, quantityMinor: l.quantityMinor, unitPriceMinor: product.currentPrice,
        priceCurrency: product.priceCurrency, directFinalPrice: false,
        lineTotalMinor: lineTotal, repriced: false,
      });
    } catch {
      dropped.push({ productId: l.productId, reason: 'invalid' });
    }
  }
  if (items.length === 0) {
    clearDraftCart();
    return null;
  }
  return { requestId: stored.requestId, savedAt: stored.savedAt, items, dropped };
}
