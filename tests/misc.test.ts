import { describe, it, expect } from 'vitest';
import { toAppError } from '../src/main/ipc/index';
import { buildReceiptHtml } from '../src/main/services/printing/receipt';
import { BackupError } from '../src/main/services/database/backupService';
import { ValidationError } from '../src/shared/validation/index';
import {
  computePaymentBreakdown, parseWeightKg, parseMoney, computeLineTotal, roundLbp, MAX_RATE,
} from '../src/shared/money/index';
import { getRange, getCustomRange } from '../src/shared/dates/index';
import type { SaleDTO } from '../src/shared/types/index';

describe('IPC error mapping never leaks internals', () => {
  it('maps validation / backup / sqlite errors to friendly messages', () => {
    expect(toAppError(new ValidationError('Bad qty')).userMessage).toBe('Bad qty');
    expect(toAppError(new BackupError('nope', 'C:\\secret\\path')).userMessage).toBe('nope');
    expect(toAppError(new Error('UNIQUE constraint failed: products.name')).code).toBe('DUPLICATE');
    const generic = toAppError(new Error('SQLITE_ERROR: at C:\\Users\\x\\file.ts:12 stack...'));
    expect(generic.userMessage).not.toMatch(/SQLITE|C:\\|stack/);
    expect(JSON.stringify(generic)).not.toMatch(/SQLITE|C:\\/);
  });
});

const sale = (name: string): SaleDTO => ({
  id: 1, invoiceNumber: '2026-00001', status: 'COMPLETED', totalUsdCents: 608, totalLbp: 0, costUsdCents: 0,
  exchangeRateSnapshot: 89500, totalUsdEquivalentCents: 608, customerId: null, creditUsdCents: 0, createdAt: 1700000000,
  completedAt: 1700000000,
  items: [{ id: 1, productId: 1, productNameSnapshot: name, productNameArSnapshot: 'دجاج', categoryIdSnapshot: 1,
    sellingUnitSnapshot: 'WEIGHT', quantityMinor: 1350, unitPriceMinor: 450, priceCurrencySnapshot: 'USD',
    directFinalPrice: false, lineTotalMinor: 608, unitCostSnapshot: null, lineCostMinor: null,
    exchangeRateSnapshot: 89500, returnedQuantityMinor: 0 }],
  payment: { id: 1, paymentType: 'USD', paidUsdCents: 1000, paidLbp: 0, changeUsdCents: 392, changeLbp: 0, exchangeRateSnapshot: 89500 },
});
const shop = { shopName: 'Shop <b>', phone: '1', address: 'A', defaultCurrency: 'USD' as const, language: 'en' as const };

describe('Receipt HTML', () => {
  it('escapes HTML in names and shop fields', () => {
    const html = buildReceiptHtml(sale('<script>alert(1)</script>'), shop, { paperWidth: 80, language: 'en' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('Shop <b>');
  });
  it('Arabic receipts are RTL and use Arabic names; English are LTR', () => {
    const ar = buildReceiptHtml(sale('Chicken'), shop, { paperWidth: 58, language: 'ar' });
    expect(ar).toMatch(/dir="rtl"/);
    expect(ar).toContain('دجاج');
    expect(buildReceiptHtml(sale('Chicken'), shop, { paperWidth: 80, language: 'en' })).toMatch(/dir="ltr"/);
  });
  it('shows invoice number, total, paid and change', () => {
    const html = buildReceiptHtml(sale('Chicken'), shop, { paperWidth: 80, language: 'en' });
    for (const s of ['2026-00001', '6.08', '10.00', '3.92']) expect(html).toContain(s);
  });
  it('handles very long names without throwing', () => {
    expect(() => buildReceiptHtml(sale('x'.repeat(500)), shop, { paperWidth: 58, language: 'en' })).not.toThrow();
  });
});

describe('Money edge cases', () => {
  it('exact weight parsing', () => {
    expect(parseWeightKg('0.125')).toBe(125);
    expect(parseWeightKg('1,350')).toBe(1350);
    expect(parseWeightKg('1.350')).toBe(1350);
    for (const bad of ['', 'abc', '-1', '0', '1.2345', '1e3', '1.1.1', '99999999']) expect(() => parseWeightKg(bad)).toThrow();
  });
  it('exact money parsing (no float error)', () => {
    expect(parseMoney('0.07', 'USD')).toBe(7);
    expect(parseMoney('1.15', 'USD')).toBe(115);
    expect(parseMoney('19.99', 'USD')).toBe(1999);
    expect(parseMoney('1,000', 'LBP')).toBe(1000);
    for (const bad of ['-1', '1.999', 'x', '1e5']) expect(() => parseMoney(bad, 'USD')).toThrow();
  });
  it('weight line total is half-up at the boundary', () => {
    expect(computeLineTotal(1, 500, 'WEIGHT', 'USD')).toBe(1);   // 0.5 -> 1
    expect(computeLineTotal(1, 499, 'WEIGHT', 'USD')).toBe(0);   // 0.499 -> 0
  });
  it('roundLbp is a ceiling to 5,000 and leaves multiples alone', () => {
    expect(roundLbp(0)).toBe(0);
    expect(roundLbp(5000)).toBe(5000);
    expect(roundLbp(5001)).toBe(10000);
    expect(roundLbp(87300)).toBe(90000);
  });
  it('payment breakdown: random inputs obey conservation (change + due <= paid) and exactness', () => {
    let seed = 12345;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 2000; i++) {
      const rate = 1000 + rnd(200000);
      const owedUsd = rnd(100000), owedLbp = rnd(50_000_000);
      const paidUsd = rnd(200000), paidLbp = rnd(100_000_000);
      const cur = rnd(2) ? 'USD' : 'LBP';
      const b = computePaymentBreakdown({ owedUsdCents: owedUsd, owedLbp, paidUsdCents: paidUsd, paidLbp, rate, changeCurrency: cur });
      const owedU = owedUsd * rate + owedLbp * 100;
      const paidU = paidUsd * rate + paidLbp * 100;
      expect(b.isSufficient).toBe(paidU >= owedU);
      if (!b.isSufficient) { expect(b.changeUsdCents).toBe(0); expect(b.changeLbp).toBe(0); expect(b.shortfallUsdCents).toBeGreaterThan(0); }
      if (cur === 'USD') expect(b.changeUsdCents * rate).toBeLessThanOrEqual(Math.max(0, paidU - owedU));
    }
  });
  it('rejects invalid rate and oversize amounts', () => {
    const base = { owedUsdCents: 1, owedLbp: 0, paidUsdCents: 1, paidLbp: 0, changeCurrency: 'USD' as const };
    for (const rate of [0, -1, 1.5, MAX_RATE + 1, NaN]) expect(() => computePaymentBreakdown({ ...base, rate })).toThrow();
    expect(() => computePaymentBreakdown({ ...base, rate: 89500, paidUsdCents: 2e9 })).toThrow();
  });
});

describe('Date ranges', () => {
  it('week starts Monday; custom range covers the whole last day', () => {
    const wed = new Date(2026, 9, 14, 15, 0, 0); // Wed 14 Oct 2026
    const w = getRange('week', wed);
    expect(new Date(w.from * 1000).getDay()).toBe(1);
    const c = getCustomRange('2026-10-01', '2026-10-01')!;
    expect(c.to - c.from).toBe(86399);
    expect(getCustomRange('2026-10-02', '2026-10-01')).toBeNull();
  });
});

import { findStockProblems } from '../src/shared/stock/index';
describe('Stock rule D3 (never below zero)', () => {
  it('aggregates unmerged cart lines per product and flags shortfalls', () => {
    const stock = new Map([[1, 1000], [2, 5]]);
    expect(findStockProblems([{ productId: 1, quantityMinor: 600 }, { productId: 1, quantityMinor: 600 }], stock))
      .toEqual([{ productId: 1, availableMinor: 1000, requestedMinor: 1200 }]);
    expect(findStockProblems([{ productId: 1, quantityMinor: 1000 }, { productId: 2, quantityMinor: 5 }], stock)).toEqual([]);
    expect(findStockProblems([{ productId: 3, quantityMinor: 1 }], stock)).toHaveLength(1); // unknown product = 0 stock
  });
});

import { updateProduct as _upd, getProduct as _get } from '../src/main/services/database/productsService';
import { makeProduct as _mk, freshDb as _fresh } from './helpers';
import { beforeEach } from 'vitest';
describe('Review fix: changing product currency does not reinterpret old amounts', () => {
  beforeEach(() => { _fresh(); });
  it('requires a new price and cost when the currency changes', () => {
    const p = _mk({ price: 450, cost: 300, stock: 1 });
    expect(() => _upd(p.id, { priceCurrency: 'LBP' })).toThrow();
    expect(() => _upd(p.id, { priceCurrency: 'LBP', currentPrice: 400000 })).toThrow(); // cost missing
    _upd(p.id, { priceCurrency: 'LBP', currentPrice: 400000, currentCost: null });
    const r = _get(p.id)!;
    expect(r.priceCurrency).toBe('LBP');
    expect(r.currentCost).toBeNull();
  });
});

import { createProduct as _create } from '../src/main/services/database/productsService';
describe('Owner policy: LBP entry is converted to USD once and stored in USD', () => {
  beforeEach(() => { _fresh(); });
  it('400,000 LBP price / 300,000 LBP cost at 89,500 -> USD cents', () => {
    const base = _mk({ price: 100, stock: 0 });
    const p = _create({ name: 'Chicken', categoryId: base.categoryId, sellingUnit: 'WEIGHT',
      currentPrice: 400000, priceCurrency: 'LBP', currentCost: 300000, storeAsUsd: true });
    expect(p.priceCurrency).toBe('USD');
    expect(p.currentPrice).toBe(447);   // 4.4693 -> 4.47
    expect(p.currentCost).toBe(335);    // 3.3520 -> 3.35
  });
  it('without the flag, LBP-denominated products still work (old data)', () => {
    const base = _mk({ price: 100, stock: 0 });
    const p = _create({ name: 'Old', categoryId: base.categoryId, sellingUnit: 'PIECE',
      currentPrice: 90000, priceCurrency: 'LBP' });
    expect(p.priceCurrency).toBe('LBP');
  });
});
