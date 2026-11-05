/** Policy D1 (PRD §17): exact stored amounts; 5,000 LBP cash rounding only for LBP-only tenders. */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { computePaymentBreakdown as pb } from '../src/shared/money/index';
import { freshDb, cleanup, makeProduct } from './helpers';
import { completeSale, getSale } from '../src/main/services/database/salesService';
import { getSalesReport } from '../src/main/services/database/reportsService';

const R = 89500;
const base = { owedUsdCents: 0, owedLbp: 87300, rate: R };

describe('LBP-only tender rounds the cash due up to 5,000 (PRD example)', () => {
  it('87,300 owed -> 90,000 due', () => {
    const b = pb({ ...base, paidUsdCents: 0, paidLbp: 90000, changeCurrency: 'LBP' });
    expect(b.exactOwedLbp).toBe(87300);
    expect(b.cashDueLbp).toBe(90000);
    expect(b.isSufficient).toBe(true);
    expect(b.changeLbp).toBe(0);
  });
  it('87,300 paid in LBP is NOT enough (due is 90,000) but the debt is measured exactly', () => {
    const b = pb({ ...base, paidUsdCents: 0, paidLbp: 87300, changeCurrency: 'LBP' });
    expect(b.isSufficient).toBe(false);
    expect(b.shortfallLbp).toBe(0); // exact amount is covered; only the rounding is outstanding
  });
  it.each([
    [85000, 85000], [85001, 90000], [89999, 90000], [90000, 90000], [90001, 95000], [1, 5000],
  ])('boundary: %i owed -> %i cash due', (owed, due) => {
    expect(pb({ owedUsdCents: 0, owedLbp: owed, paidUsdCents: 0, paidLbp: 1, rate: R, changeCurrency: 'LBP' }).cashDueLbp).toBe(due);
  });
  it('overpayment: LBP change, and USD change from the rounded due', () => {
    const l = pb({ ...base, paidUsdCents: 0, paidLbp: 100000, changeCurrency: 'LBP' });
    expect(l.changeLbp).toBe(10000);
    const u = pb({ ...base, paidUsdCents: 0, paidLbp: 179000, changeCurrency: 'USD' });
    // surplus = 179,000 - 90,000 = 89,000 LBP -> $0.99 (floor of 99.4 cents)
    expect(u.changeUsdCents).toBe(99);
  });
});

describe('Payments that include USD are compared exactly (no rounding of the due)', () => {
  it('USD only for an LBP invoice: 87,300 LBP = $0.9754 -> $0.98 is enough, $0.97 is not', () => {
    expect(pb({ ...base, paidUsdCents: 98, paidLbp: 0, changeCurrency: 'USD' }).isSufficient).toBe(true);
    expect(pb({ ...base, paidUsdCents: 97, paidLbp: 0, changeCurrency: 'USD' }).isSufficient).toBe(false);
  });
  it('PRD §25: $10 invoice paid with $5 + 447,500 LBP is exactly paid', () => {
    const b = pb({ owedUsdCents: 1000, owedLbp: 0, paidUsdCents: 500, paidLbp: 447500, rate: R, changeCurrency: 'USD' });
    expect(b.isSufficient).toBe(true);
    expect(b.changeUsdCents).toBe(0);
    expect(b.changeLbp).toBe(0);
  });
  it('mixed tender: $1 + 44,750 LBP covers 87,300 LBP exactly-or-better', () => {
    const b = pb({ ...base, paidUsdCents: 100, paidLbp: 0, changeCurrency: 'LBP' });
    // $1 = 89,500 LBP; surplus 2,200 -> change rounds up to 5,000
    expect(b.isSufficient).toBe(true);
    expect(b.changeLbp).toBe(5000);
  });
  it('underpayment reports shortfall in both currencies, rounded up', () => {
    const b = pb({ owedUsdCents: 1000, owedLbp: 0, paidUsdCents: 999, paidLbp: 0, rate: R, changeCurrency: 'USD' });
    expect(b.isSufficient).toBe(false);
    expect(b.shortfallUsdCents).toBe(1);
    expect(b.shortfallLbp).toBe(895);
  });
  it('USD-priced invoice paid in LBP only is rounded up to 5,000', () => {
    // $1.00 = 89,500 LBP -> cash due 90,000
    const b = pb({ owedUsdCents: 100, owedLbp: 0, paidUsdCents: 0, paidLbp: 90000, rate: R, changeCurrency: 'LBP' });
    expect(b.cashDueLbp).toBe(90000);
    expect(b.isSufficient).toBe(true);
    expect(pb({ owedUsdCents: 100, owedLbp: 0, paidUsdCents: 0, paidLbp: 89500, rate: R, changeCurrency: 'LBP' }).isSufficient).toBe(false);
  });
});

describe('Stored amounts and reports stay exact (service level)', () => {
  afterAll(cleanup);
  beforeEach(() => { freshDb(); });
  it('invoice stores exact 87,300; payment records what was handed over; report uses exact total', () => {
    const p = makeProduct({ price: 87300, currency: 'LBP', stock: 5 });
    const line = { productId: p.id, quantityMinor: 1, unitPriceMinor: 87300, priceCurrency: 'LBP' as const, directFinalPrice: false, lineTotalMinor: 0 };
    expect(() => completeSale({ lines: [line], payment: { paidUsdCents: 0, paidLbp: 87300, changeCurrency: 'LBP' } })).toThrow(/90,000/);
    const sale = completeSale({ lines: [line], payment: { paidUsdCents: 0, paidLbp: 100000, changeCurrency: 'LBP' } });
    const s = getSale(sale.id)!;
    expect(s.totalLbp).toBe(87300);
    expect(s.payment!.paidLbp).toBe(100000);
    expect(s.payment!.changeLbp).toBe(10000); // cash: 100,000 - 90,000
    const n = Math.floor(Date.now() / 1000);
    const r = getSalesReport({ from: n - 3600, to: n + 3600 });
    expect(r.totalLbp).toBe(87300);
    expect(r.totalUsdEquivalentCents).toBe(98); // 87,300 / 89,500 = $0.9754
  });
});

describe('Review fixes: LBP notes and credit', () => {
  beforeEach(() => { freshDb(); });
  const pay = (u: number, l = 0) => ({ paidUsdCents: u, paidLbp: l, changeCurrency: 'USD' as const });
  it('87,300 LBP owed: 87,300 cash is rejected (no such note) even on account; 90,000 is accepted', async () => {
    const { completeSale } = await import('../src/main/services/database/salesService');
    const { createCustomer } = await import('../src/main/services/database/customersService');
    const { makeProduct } = await import('./helpers');
    const c = createCustomer({ name: 'T' });
    const p = makeProduct({ price: 87300, currency: 'LBP', stock: 5 });
    const line = [{ productId: p.id, quantityMinor: 1, unitPriceMinor: 87300, priceCurrency: 'LBP' as const, directFinalPrice: false, lineTotalMinor: 0 }];
    expect(() => completeSale({ lines: line, payment: pay(0, 87300), customerId: c.id, allowCredit: true })).toThrow(/5,000/);
    expect(() => completeSale({ lines: line, payment: pay(0, 87300) })).toThrow();
    const ok = completeSale({ lines: line, payment: pay(0, 90000) });
    expect(ok.status).toBe('COMPLETED');
  });
});
