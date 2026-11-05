/**
 * Sales service tests against a REAL temporary SQLite database.
 * Expected values are hand-derived from the PRD rules, not computed by the code under test.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { freshDb, cleanup, makeProduct, stockOf, RATE } from './helpers';
import { getDb } from '../src/main/services/database/connection';
import {
  completeSale, getSale, listSales, suspendSale, getSuspendedSale, cancelSuspendedSale,
} from '../src/main/services/database/salesService';
import { updateProduct } from '../src/main/services/database/productsService';
import { recordExchangeRateChange } from '../src/main/services/database/exchangeRate';
import { createCustomer, getCustomer } from '../src/main/services/database/customersService';

afterAll(cleanup);
beforeEach(() => { freshDb(); });

const usdPay = (paidUsdCents: number, paidLbp = 0, changeCurrency: 'USD' | 'LBP' = 'USD') =>
  ({ paidUsdCents, paidLbp, changeCurrency });
const lineA = (productId: number, qty: number, price: number, cur: 'USD' | 'LBP' = 'USD') =>
  ({ productId, quantityMinor: qty, unitPriceMinor: price, priceCurrency: cur, directFinalPrice: false, lineTotalMinor: 0 });
const count = (t: string) => (getDb().prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;

describe('Workflow A (weight x price)', () => {
  it('1.350 kg x $4.50/kg = $6.075 -> $6.08 (half-up) and stock drops by 1350 g', () => {
    const p = makeProduct({ unit: 'WEIGHT', price: 450, cost: 300, stock: 10000 });
    const sale = completeSale({ lines: [lineA(p.id, 1350, 450)], payment: usdPay(1000) });
    expect(sale.totalUsdCents).toBe(608);
    expect(sale.payment!.changeUsdCents).toBe(392);
    expect(stockOf(p.id)).toBe(8650);
    expect(sale.status).toBe('COMPLETED');
    // cost: 1.350kg x $3.00 = $4.05
    expect(sale.costUsdCents).toBe(405);
  });
  it('0.125 kg x $10.00/kg = $1.25 exactly', () => {
    const p = makeProduct({ unit: 'WEIGHT', price: 1000, stock: 5000 });
    expect(completeSale({ lines: [lineA(p.id, 125, 1000)], payment: usdPay(125) }).totalUsdCents).toBe(125);
  });
  it('ignores a tampered client unit price/total and uses the stored product price', () => {
    const p = makeProduct({ unit: 'WEIGHT', price: 450, stock: 10000 });
    const sale = completeSale({
      lines: [{ ...lineA(p.id, 1000, 1), lineTotalMinor: 1 }],
      payment: usdPay(450),
    });
    expect(sale.totalUsdCents).toBe(450);
  });
});

describe('Workflow B (direct final price)', () => {
  it('uses the entered final price and still deducts the weight', () => {
    const p = makeProduct({ unit: 'WEIGHT', price: 450, stock: 10000 });
    const sale = completeSale({
      lines: [{ productId: p.id, quantityMinor: 1350, unitPriceMinor: 600, priceCurrency: 'USD', directFinalPrice: true, lineTotalMinor: 600 }],
      payment: usdPay(600),
    });
    expect(sale.totalUsdCents).toBe(600);
    expect(stockOf(p.id)).toBe(8650);
  });
  it('accepts a final price in LBP even when the product is priced in USD', () => {
    const p = makeProduct({ unit: 'WEIGHT', price: 450, stock: 10000 });
    const sale = completeSale({
      lines: [{
        productId: p.id,
        quantityMinor: 1350,
        unitPriceMinor: 600000,
        priceCurrency: 'LBP',
        directFinalPrice: true,
        lineTotalMinor: 600000,
      }],
      payment: { paidUsdCents: 0, paidLbp: 600000, changeCurrency: 'LBP' },
    });
    expect(sale.totalLbp).toBe(600000);
    expect(sale.totalUsdCents).toBe(0);
    expect(stockOf(p.id)).toBe(8650);
  });
  it('rejects a zero or negative final price', () => {
    const p = makeProduct({ unit: 'WEIGHT', price: 450, stock: 10000 });
    for (const t of [0, -5]) {
      expect(() => completeSale({
        lines: [{ productId: p.id, quantityMinor: 1000, unitPriceMinor: t, priceCurrency: 'USD', directFinalPrice: true, lineTotalMinor: t }],
        payment: usdPay(100),
      })).toThrow();
    }
    expect(count('sales')).toBe(0);
  });
  it('is not allowed for piece products', () => {
    const p = makeProduct({ unit: 'PIECE', price: 100, stock: 10 });
    expect(() => completeSale({
      lines: [{ productId: p.id, quantityMinor: 1, unitPriceMinor: 1, priceCurrency: 'USD', directFinalPrice: true, lineTotalMinor: 1 }],
      payment: usdPay(1),
    })).toThrow();
  });
});

describe('Payments', () => {
  it('mixed USD+LBP invoice paid with $10: exact, no change', () => {
    const a = makeProduct({ price: 500, stock: 5 });
    const b = makeProduct({ price: 447500, currency: 'LBP', stock: 5 });
    const sale = completeSale({
      lines: [lineA(a.id, 1, 500), lineA(b.id, 1, 447500, 'LBP')],
      payment: usdPay(1000),
    });
    expect(sale.totalUsdCents).toBe(500);
    expect(sale.totalLbp).toBe(447500);
    expect(sale.payment!.changeUsdCents).toBe(0);
  });
  it('LBP change is rounded to 5,000 (up)', () => {
    const a = makeProduct({ price: 100, stock: 5 });
    const sale = completeSale({ lines: [lineA(a.id, 1, 100)], payment: usdPay(150, 0, 'LBP') });
    // surplus $0.50 = 44,750 LBP -> 45,000
    expect(sale.payment!.changeLbp).toBe(45000);
    expect(sale.payment!.changeUsdCents).toBe(0);
  });
  it('underpayment is rejected and leaves no trace', () => {
    const a = makeProduct({ price: 500, stock: 5 });
    expect(() => completeSale({ lines: [lineA(a.id, 1, 500)], payment: usdPay(499) })).toThrow();
    expect(count('sales')).toBe(0);
    expect(stockOf(a.id)).toBe(5);
  });
  it('one cent short is NOT treated as paid (no lossy rounding)', () => {
    const a = makeProduct({ price: 1, stock: 5 });
    expect(() => completeSale({ lines: [lineA(a.id, 1, 1)], payment: usdPay(0, 894) })).toThrow();
  });
  it('rejects negative, fractional and absurd payment values', () => {
    const a = makeProduct({ price: 100, stock: 5 });
    for (const pay of [usdPay(-1), usdPay(1.5), usdPay(1e15), { paidUsdCents: NaN, paidLbp: 0, changeCurrency: 'USD' }]) {
      expect(() => completeSale({ lines: [lineA(a.id, 1, 100)], payment: pay })).toThrow();
    }
    expect(count('sales')).toBe(0);
  });
});

describe('Atomicity, stock and idempotency', () => {
  it('insufficient stock on the 2nd line rolls back the whole sale', () => {
    const a = makeProduct({ price: 100, stock: 5 });
    const b = makeProduct({ price: 100, stock: 1 });
    expect(() => completeSale({
      lines: [lineA(a.id, 2, 100), lineA(b.id, 2, 100)], payment: usdPay(400),
    })).toThrow(/stock/i);
    expect(stockOf(a.id)).toBe(5);
    expect(stockOf(b.id)).toBe(1);
    expect(count('sales')).toBe(0);
    expect(count('sale_items')).toBe(0);
    expect(count('payments')).toBe(0);
  });
  it('a failure after the sale row is written rolls everything back', () => {
    const a = makeProduct({ price: 100, stock: 5 });
    getDb().exec(`CREATE TRIGGER boom BEFORE INSERT ON payments BEGIN SELECT RAISE(ABORT,'injected'); END;`);
    expect(() => completeSale({ lines: [lineA(a.id, 1, 100)], payment: usdPay(100) })).toThrow();
    expect(count('sales')).toBe(0);
    expect(count('sale_items')).toBe(0);
    expect(stockOf(a.id)).toBe(5);
    expect(count('inventory_movements')).toBe(1); // only the initial add-stock
  });
  it('the same clientRequestId returns the same sale and deducts stock once', () => {
    const a = makeProduct({ price: 100, stock: 5 });
    const input = { lines: [lineA(a.id, 1, 100)], payment: usdPay(100), clientRequestId: 'req-1' };
    const s1 = completeSale(input);
    const s2 = completeSale(input);
    expect(s2.id).toBe(s1.id);
    expect(count('sales')).toBe(1);
    expect(stockOf(a.id)).toBe(4);
  });
  it('rejects empty carts, unknown, inactive and wrong-currency lines', () => {
    const a = makeProduct({ price: 100, stock: 5 });
    expect(() => completeSale({ lines: [], payment: usdPay(0) })).toThrow();
    expect(() => completeSale({ lines: [lineA(9999, 1, 100)], payment: usdPay(100) })).toThrow();
    expect(() => completeSale({ lines: [lineA(a.id, 1, 100, 'LBP')], payment: usdPay(100) })).toThrow();
    expect(() => completeSale({ lines: [lineA(a.id, 0, 100)], payment: usdPay(0) })).toThrow();
    expect(() => completeSale({ lines: [lineA(a.id, -1, 100)], payment: usdPay(0) })).toThrow();
    expect(() => completeSale({ lines: [lineA(a.id, 1.5, 100)], payment: usdPay(200) })).toThrow();
    expect(count('sales')).toBe(0);
  });
  it('invoice numbers are sequential and unique', () => {
    const a = makeProduct({ price: 100, stock: 10 });
    const n = [1, 2, 3].map(() => completeSale({ lines: [lineA(a.id, 1, 100)], payment: usdPay(100) }).invoiceNumber);
    expect(new Set(n).size).toBe(3);
    expect(n[0] < n[1] && n[1] < n[2]).toBe(true);
  });
});

describe('Historical stability (PRD 50)', () => {
  it('later price, name and rate changes do not alter an existing invoice', () => {
    const p = makeProduct({ name: 'Chicken', unit: 'WEIGHT', price: 450, cost: 300, stock: 10000 });
    const sale = completeSale({ lines: [lineA(p.id, 1350, 450)], payment: usdPay(1000) });
    updateProduct(p.id, { name: 'Renamed', currentPrice: 999, currentCost: 700 });
    recordExchangeRateChange(120000);
    const again = getSale(sale.id)!;
    expect(again.totalUsdCents).toBe(608);
    expect(again.exchangeRateSnapshot).toBe(RATE);
    expect(again.items[0].productNameSnapshot).toBe('Chicken');
    expect(again.items[0].unitPriceMinor).toBe(450);
    expect(again.items[0].unitCostSnapshot).toBe(300);
    expect(again.costUsdCents).toBe(405);
  });
});

describe('Credit sales', () => {
  it('puts the unpaid remainder on the customer account only when allowed', () => {
    const c = createCustomer({ name: 'Ali' });
    const a = makeProduct({ price: 1000, stock: 5 });
    const base = { lines: [lineA(a.id, 1, 1000)], payment: usdPay(400), customerId: c.id };
    expect(() => completeSale(base)).toThrow();
    const sale = completeSale({ ...base, allowCredit: true });
    expect(sale.creditUsdCents).toBe(600);
    expect(getCustomer(c.id)!.balanceUsdCents).toBe(600);
  });
  it('credit requires a customer', () => {
    const a = makeProduct({ price: 1000, stock: 5 });
    expect(() => completeSale({ lines: [lineA(a.id, 1, 1000)], payment: usdPay(400), allowCredit: true })).toThrow();
  });
});

describe('Suspended sales', () => {
  it('does not touch stock or the invoice sequence, is excluded from lists and holds one at a time', () => {
    const a = makeProduct({ price: 100, stock: 5 });
    const s = suspendSale([lineA(a.id, 2, 100)], 'Customer A');
    expect(s.status).toBe('SUSPENDED');
    expect(stockOf(a.id)).toBe(5);
    expect(getSuspendedSale()!.id).toBe(s.id);
    expect(listSales({}).some((x) => x.id === s.id)).toBe(false);
    expect(() => suspendSale([lineA(a.id, 1, 100)])).toThrow();
    cancelSuspendedSale();
    expect(getSuspendedSale()).toBeNull();
    expect(stockOf(a.id)).toBe(5);
    const real = completeSale({ lines: [lineA(a.id, 1, 100)], payment: usdPay(100) });
    expect(real.invoiceNumber).not.toBe('SUSPENDED');
    expect(real.invoiceNumber.endsWith('00001')).toBe(true);
  });
});

describe('Invoice search', () => {
  it('finds by invoice number and treats LIKE wildcards literally', () => {
    const a = makeProduct({ price: 100, stock: 5 });
    const s = completeSale({ lines: [lineA(a.id, 1, 100)], payment: usdPay(100) });
    expect(listSales({ search: s.invoiceNumber }).length).toBe(1);
    expect(listSales({ search: '%' }).length).toBe(0);
  });
});
