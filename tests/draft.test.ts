import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { freshDb, cleanup, makeProduct, stockOf } from './helpers';
import { initDatabase, closeDatabase, getDb } from '../src/main/services/database/connection';
import { saveDraftCart, getDraftCart, clearDraftCart } from '../src/main/services/database/draftService';
import { completeSale } from '../src/main/services/database/salesService';
import { updateProduct, toggleProductActive } from '../src/main/services/database/productsService';
import { setAppSetting } from '../src/main/services/database/settingsService';

afterAll(cleanup);
let dbPath = '';
beforeEach(() => { dbPath = freshDb().dbPath; });

const rid = 'draft-0000-1111';
const count = (t: string) => (getDb().prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
const line = (productId: number, q: number, direct = false, total = 0) =>
  ({ productId, quantityMinor: q, directFinalPrice: direct, lineTotalMinor: total });

describe('Draft cart recovery', () => {
  it('survives an application restart and books nothing', () => {
    const p = makeProduct({ price: 250, stock: 10 });
    const sales0 = count('sales'), mv0 = count('inventory_movements');
    saveDraftCart({ requestId: rid, lines: [line(p.id, 2)] });
    closeDatabase();
    initDatabase(dbPath); // "restart"
    const d = getDraftCart()!;
    expect(d.items).toHaveLength(1);
    expect(d.items[0].lineTotalMinor).toBe(500);
    expect(d.requestId).toBe(rid);
    expect(count('sales')).toBe(sales0);
    expect(count('inventory_movements')).toBe(mv0);
    expect(stockOf(p.id)).toBe(10);
  });

  it('re-prices from the CURRENT product price and never stores prices, customers or payments', () => {
    const p = makeProduct({ price: 250, stock: 10 });
    saveDraftCart({ requestId: rid, lines: [line(p.id, 2)] });
    updateProduct(p.id, { currentPrice: 300 });
    expect(getDraftCart()!.items[0].lineTotalMinor).toBe(600);
    const raw = (getDb().prepare("SELECT value FROM app_settings WHERE key='draft_cart'").get() as { value: string }).value;
    const stored = JSON.parse(raw);
    expect(Object.keys(stored).sort()).toEqual(['lines', 'requestId', 'savedAt']);
    expect(Object.keys(stored.lines[0]).sort()).toEqual(['directFinalPrice', 'lineTotalMinor', 'productId', 'quantityMinor']);
    expect(stored.lines[0].lineTotalMinor).toBe(0); // normal lines never persist a price
  });

  it('keeps a weight final-price line as entered; rejects it for non-weight products', () => {
    const w = makeProduct({ unit: 'WEIGHT', price: 450, stock: 5000 });
    const pc = makeProduct({ unit: 'PIECE', price: 100, stock: 5 });
    saveDraftCart({ requestId: rid, lines: [line(w.id, 1350, true, 600), line(pc.id, 1, true, 50)] });
    const d = getDraftCart()!;
    expect(d.items).toHaveLength(1);
    expect(d.items[0].lineTotalMinor).toBe(600);
    expect(d.dropped).toEqual([{ productId: pc.id, reason: 'invalid' }]);
  });

  it('restores the selected currency for a direct-price draft', () => {
    const p = makeProduct({ unit: 'WEIGHT', currency: 'USD', price: 450, stock: 5000 });
    saveDraftCart({
      requestId: rid,
      lines: [{ ...line(p.id, 1350, true, 600000), priceCurrency: 'LBP' }],
    });
    const d = getDraftCart()!;
    expect(d.items[0].priceCurrency).toBe('LBP');
    expect(d.items[0].lineTotalMinor).toBe(600000);
  });

  it('drops inactive and missing products; a draft with nothing sellable is discarded', () => {
    const a = makeProduct({ price: 100, stock: 5 });
    const b = makeProduct({ price: 100, stock: 5 });
    saveDraftCart({ requestId: rid, lines: [line(a.id, 1), line(b.id, 1), line(9999, 1)] });
    toggleProductActive(b.id);
    const d = getDraftCart()!;
    expect(d.items.map((i) => i.product.id)).toEqual([a.id]);
    expect(d.dropped.map((x) => x.reason).sort()).toEqual(['inactive', 'missing']);
    toggleProductActive(a.id);
    expect(getDraftCart()).toBeNull();
    expect(getDb().prepare("SELECT 1 FROM app_settings WHERE key='draft_cart'").get()).toBeUndefined();
  });

  it('corrupt or hostile draft data is discarded gracefully', () => {
    for (const bad of ['not json', '{}', '{"requestId":"x","lines":[]}', '{"requestId":"abcdefgh1","lines":[{"productId":"1","quantityMinor":-5}]}', 'null']) {
      setAppSetting('draft_cart', bad);
      expect(getDraftCart()).toBeNull();
    }
    const p = makeProduct({ price: 100, stock: 5 });
    for (const bad of [{ requestId: 'x', lines: [line(p.id, 1)] }, { requestId: rid, lines: [line(p.id, 0)] },
      { requestId: rid, lines: [line(p.id, 1.5)] }, { requestId: rid, lines: 'nope' }, null]) {
      expect(() => saveDraftCart(bad)).toThrow();
    }
  });

  it('cancellation: clearing or saving an empty cart removes the draft', () => {
    const p = makeProduct({ price: 100, stock: 5 });
    saveDraftCart({ requestId: rid, lines: [line(p.id, 1)] });
    clearDraftCart();
    expect(getDraftCart()).toBeNull();
    saveDraftCart({ requestId: rid, lines: [line(p.id, 1)] });
    saveDraftCart({ requestId: rid, lines: [] });
    expect(getDraftCart()).toBeNull();
  });

  it('completing the sale with the draft id removes the draft atomically', () => {
    const p = makeProduct({ price: 100, stock: 5 });
    saveDraftCart({ requestId: rid, lines: [line(p.id, 1)] });
    completeSale({
      lines: [{ productId: p.id, quantityMinor: 1, unitPriceMinor: 100, priceCurrency: 'USD', directFinalPrice: false, lineTotalMinor: 0 }],
      payment: { paidUsdCents: 100, paidLbp: 0, changeCurrency: 'USD' }, clientRequestId: rid,
    });
    expect(getDraftCart()).toBeNull();
  });

  it('a draft whose sale already committed (crash before cleanup) is not offered again', () => {
    const p = makeProduct({ price: 100, stock: 5 });
    completeSale({
      lines: [{ productId: p.id, quantityMinor: 1, unitPriceMinor: 100, priceCurrency: 'USD', directFinalPrice: false, lineTotalMinor: 0 }],
      payment: { paidUsdCents: 100, paidLbp: 0, changeCurrency: 'USD' }, clientRequestId: rid,
    });
    saveDraftCart({ requestId: rid, lines: [line(p.id, 1)] }); // late write after the commit
    expect(getDraftCart()).toBeNull();
    expect(count('sales')).toBe(1);
  });

  it('a recovered draft submitted twice yields one sale and one stock deduction', () => {
    const p = makeProduct({ price: 100, stock: 5 });
    saveDraftCart({ requestId: rid, lines: [line(p.id, 2)] });
    const d = getDraftCart()!;
    const input = {
      lines: d.items.map((i) => ({ productId: i.product.id, quantityMinor: i.quantityMinor, unitPriceMinor: i.unitPriceMinor, priceCurrency: i.priceCurrency, directFinalPrice: false, lineTotalMinor: 0 })),
      payment: { paidUsdCents: 200, paidLbp: 0, changeCurrency: 'USD' as const }, clientRequestId: d.requestId,
    };
    const a = completeSale(input), b = completeSale(input);
    expect(b.id).toBe(a.id);
    expect(count('sales')).toBe(1);
    expect(stockOf(p.id)).toBe(3);
  });
});
