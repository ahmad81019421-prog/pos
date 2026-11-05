import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { freshDb, cleanup, makeProduct, stockOf } from './helpers';
import { completeSale, getSale } from '../src/main/services/database/salesService';
import { createReturn } from '../src/main/services/database/returnsService';
import {
  recordWaste,
  addStock,
  listInventory,
  listLowStock,
} from '../src/main/services/database/inventoryService';
import { updateProduct, getProduct } from '../src/main/services/database/productsService';
import { recordExchangeRateChange } from '../src/main/services/database/exchangeRate';
import { createExpense } from '../src/main/services/database/expensesService';
import {
  createCustomer,
  getCustomer,
  listCustomerTransactions,
  recordCustomerPayment,
} from '../src/main/services/database/customersService';
import {
  getSalesReport,
  getBestSellingProducts,
  getCurrentCustomerDebt,
  getCashBalance,
  setCashOpeningBalance,
  zeroCashBalance,
} from '../src/main/services/database/reportsService';
import { getDb } from '../src/main/services/database/connection';

afterAll(cleanup);
beforeEach(() => { freshDb(); });

const pay = (u: number, l = 0) => ({ paidUsdCents: u, paidLbp: l, changeCurrency: 'USD' as const });
const A = (productId: number, qty: number, price: number, cur: 'USD' | 'LBP' = 'USD') =>
  ({ productId, quantityMinor: qty, unitPriceMinor: price, priceCurrency: cur, directFinalPrice: false, lineTotalMinor: 0 });
const range = () => { const n = Math.floor(Date.now() / 1000); return { from: n - 3600, to: n + 3600 }; };

describe('Returns', () => {
  it('refunds the remaining half of a partially returned kilogram at the proportional amount', () => {
    const p = makeProduct({ unit: 'WEIGHT', price: 800, stock: 10000 });
    const sale = completeSale({ lines: [A(p.id, 1000, 800)], payment: pay(800) });

    const first = createReturn({
      originalSaleId: sale.id,
      returnType: 'PARTIAL',
      items: [{ saleItemId: sale.items[0].id, quantityReturnedMinor: 500 }],
    });
    expect(first.refundUsdCents).toBe(400);

    const second = createReturn({
      originalSaleId: sale.id,
      returnType: 'PARTIAL',
      items: [{ saleItemId: sale.items[0].id, quantityReturnedMinor: 500 }],
    });
    expect(second.refundUsdCents).toBe(400);
    expect(getSale(sale.id)!.items[0].returnedQuantityMinor).toBe(1000);
  });

  it('partial then full return: cumulative refund equals the sale total, status RETURNED, stock restored', () => {
    const p = makeProduct({ unit: 'WEIGHT', price: 450, cost: 300, stock: 10000 });
    const sale = completeSale({ lines: [A(p.id, 2000, 450)], payment: pay(900) });
    expect(stockOf(p.id)).toBe(8000);
    const item = sale.items[0];

    const r1 = createReturn({ originalSaleId: sale.id, returnType: 'PARTIAL', items: [{ saleItemId: item.id, quantityReturnedMinor: 500 }] });
    expect(r1.refundUsdCents).toBe(225);
    expect(r1.costUsdCents).toBe(150);
    expect(getSale(sale.id)!.status).toBe('COMPLETED');
    expect(getSale(sale.id)!.items[0].returnedQuantityMinor).toBe(500);

    const r2 = createReturn({ originalSaleId: sale.id, returnType: 'FULL' });
    expect(r2.refundUsdCents).toBe(675); // 900 - 225, no rounding drift
    expect(getSale(sale.id)!.status).toBe('RETURNED');
    expect(stockOf(p.id)).toBe(10000);
    expect(() => createReturn({ originalSaleId: sale.id, returnType: 'FULL' })).toThrow();
  });

  it('rejects over-return, zero/negative quantities, duplicate lines and unknown items', () => {
    const p = makeProduct({ price: 100, stock: 10 });
    const sale = completeSale({ lines: [A(p.id, 2, 100)], payment: pay(200) });
    const id = sale.items[0].id;
    for (const q of [3, 0, -1, 1.5]) {
      expect(() => createReturn({ originalSaleId: sale.id, returnType: 'PARTIAL', items: [{ saleItemId: id, quantityReturnedMinor: q }] })).toThrow();
    }
    expect(() => createReturn({ originalSaleId: sale.id, returnType: 'PARTIAL', items: [{ saleItemId: 9999, quantityReturnedMinor: 1 }] })).toThrow();
    expect(() => createReturn({ originalSaleId: 9999, returnType: 'FULL' })).toThrow();
    expect(stockOf(p.id)).toBe(8);
    createReturn({ originalSaleId: sale.id, returnType: 'PARTIAL', items: [{ saleItemId: id, quantityReturnedMinor: 1 }] });
    expect(() => createReturn({ originalSaleId: sale.id, returnType: 'PARTIAL', items: [{ saleItemId: id, quantityReturnedMinor: 2 }] })).toThrow();
    expect(stockOf(p.id)).toBe(9);
  });

  it('LBP refunds convert at the ORIGINAL sale rate, not the current one', () => {
    const p = makeProduct({ price: 100000, currency: 'LBP', stock: 10 });
    const sale = completeSale({ lines: [A(p.id, 3, 100000, 'LBP')], payment: pay(0, 300000) });
    recordExchangeRateChange(100000);
    const r = createReturn({ originalSaleId: sale.id, returnType: 'PARTIAL', items: [{ saleItemId: sale.items[0].id, quantityReturnedMinor: 1 }] });
    expect(r.refundLbp).toBe(100000);
    expect(r.exchangeRateSnapshot).toBe(100000); // rate at return time (informational)
    expect(r.refundUsdEquivalentCents).toBe(112); // 100000/89500 = $1.1173
  });

  it('refunds use sale-time price and cost even after the product changed', () => {
    const p = makeProduct({ price: 1000, cost: 600, stock: 5 });
    const sale = completeSale({ lines: [A(p.id, 1, 1000)], payment: pay(1000) });
    updateProduct(p.id, { currentPrice: 5000, currentCost: 4000 });
    const r = createReturn({ originalSaleId: sale.id, returnType: 'FULL' });
    expect(r.refundUsdCents).toBe(1000);
    expect(r.costUsdCents).toBe(600);
  });

  it('returning a credit sale reduces the customer debt', () => {
    const c = createCustomer({ name: 'Ali' });
    const p = makeProduct({ price: 1000, stock: 5 });
    const sale = completeSale({ lines: [A(p.id, 1, 1000)], payment: pay(400), customerId: c.id, allowCredit: true });
    expect(getCustomer(c.id)!.balanceUsdCents).toBe(600);
    createReturn({ originalSaleId: sale.id, returnType: 'FULL' });
    expect(getCustomer(c.id)!.balanceUsdCents).toBeLessThanOrEqual(600);
    expect(getCustomer(c.id)!.balanceUsdCents).toBeGreaterThanOrEqual(0);
  });
});

describe('Reports reconcile with transactions', () => {
  it('returns complete zero-valued financial KPIs when the selected range has no data', () => {
    const r = getSalesReport(range());
    expect(r).toEqual({
      totalUsdCents: 0,
      totalLbp: 0,
      totalUsdEquivalentCents: 0,
      returnsUsdCents: 0,
      netSalesUsdEquivalentCents: 0,
      costUsdCents: 0,
      grossProfitUsdCents: 0,
      expensesUsdCents: 0,
      expensesCashUsdCents: 0,
      expensesOwnerUsdCents: 0,
      expensesUnclassifiedUsdCents: 0,
      wasteUsdCents: 0,
      netProfitUsdCents: 0,
      invoiceCount: 0,
    });
  });

  it('cash balance includes opening funds and actual cash movements once, excluding credit', () => {
    setCashOpeningBalance(10000);
    const customer = createCustomer({ name: 'Credit customer' });
    const cashProduct = makeProduct({ price: 500, stock: 5 });
    completeSale({ lines: [A(cashProduct.id, 1, 500)], payment: pay(500) });
    const lbpProduct = makeProduct({ price: 90000, currency: 'LBP', stock: 5 });
    completeSale({
      lines: [A(lbpProduct.id, 1, 90000, 'LBP')],
      payment: pay(0, 90000),
    });
    const creditProduct = makeProduct({ price: 300, stock: 5 });
    completeSale({
      lines: [A(creditProduct.id, 1, 300)],
      payment: pay(0),
      customerId: customer.id,
      allowCredit: true,
    });
    createExpense({
      date: Math.floor(Date.now() / 1000),
      description: 'Cash expense',
      amountMinor: 100,
      currency: 'USD',
      paymentSource: 'CASH',
      category: 'OTHER',
    });

    expect(getCashBalance()).toMatchObject({
      openingBalanceUsdCents: 10000,
      currentBalanceUsdCents: 10000 + 500 + 101 - 100,
    });

    recordExchangeRateChange(179000);
    expect(getCashBalance()).toMatchObject({
      openingBalanceUsdCents: 10000,
      currentBalanceUsdCents: 10501,
      currentBalanceLbp: 18796790,
    });
  });

  it('cash balance tracks cash collected against a customer debt', () => {
    const customer = createCustomer({ name: 'Paying customer' });
    const product = makeProduct({ price: 1000, stock: 5 });
    completeSale({
      lines: [A(product.id, 1, 1000)],
      payment: pay(400),
      customerId: customer.id,
      allowCredit: true,
    });
    recordCustomerPayment({
      customerId: customer.id,
      amountMinor: 200,
      currency: 'USD',
    });

    expect(getCashBalance().currentBalanceUsdCents).toBe(600);
  });

  it('allows expenses to exceed cash and can zero the balance without losing later tracking', () => {
    setCashOpeningBalance(100);
    createExpense({
      date: Math.floor(Date.now() / 1000),
      description: 'Expense greater than cash',
      amountMinor: 250,
      currency: 'USD',
      paymentSource: 'CASH',
      category: 'OTHER',
    });
    expect(getCashBalance()).toMatchObject({
      currentBalanceUsdCents: -150,
      currentBalanceLbp: -134250,
    });

    zeroCashBalance();
    expect(getCashBalance()).toMatchObject({
      openingBalanceUsdCents: 0,
      currentBalanceUsdCents: 0,
      currentBalanceLbp: 0,
    });

    setCashOpeningBalance(5000);
    expect(getCashBalance().currentBalanceUsdCents).toBe(5000);

    createExpense({
      date: Math.floor(Date.now() / 1000),
      description: 'Expense after cash reset',
      amountMinor: 25,
      currency: 'USD',
      paymentSource: 'CASH',
      category: 'OTHER',
    });
    expect(getCashBalance().currentBalanceUsdCents).toBe(4975);

    setCashOpeningBalance(7500);
    expect(getCashBalance().currentBalanceUsdCents).toBe(7475);

    zeroCashBalance();
    expect(getCashBalance()).toMatchObject({
      openingBalanceUsdCents: 0,
      currentBalanceUsdCents: 0,
      currentBalanceLbp: 0,
    });

    setCashOpeningBalance(1200);
    expect(getCashBalance().currentBalanceUsdCents).toBe(1200);
  });

  it('clears a legacy zeroing adjustment before accepting a new cash balance', () => {
    setCashOpeningBalance(10000);
    getDb()
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ('cash_balance_adjustment_usd_cents', '-5000', unixepoch())`,
      )
      .run();
    expect(getCashBalance().currentBalanceUsdCents).toBe(5000);

    zeroCashBalance();
    expect(getCashBalance().currentBalanceUsdCents).toBe(0);

    setCashOpeningBalance(20000);
    expect(getCashBalance().currentBalanceUsdCents).toBe(20000);

    zeroCashBalance();
    expect(getCashBalance().currentBalanceUsdCents).toBe(0);

    setCashOpeningBalance(30000);
    expect(getCashBalance().currentBalanceUsdCents).toBe(30000);
  });

  it('rejects invalid cash opening balances', () => {
    expect(() => setCashOpeningBalance(-1)).toThrow();
    expect(() => setCashOpeningBalance(1.5)).toThrow();
    expect(() => setCashOpeningBalance('100')).toThrow();
  });

  it('cash-paid expenses reduce cash; owner-paid expenses do not, and report totals reconcile', () => {
    setCashOpeningBalance(10000);
    createExpense({
      date: Math.floor(Date.now() / 1000),
      description: 'Paid from till',
      amountMinor: 3000,
      currency: 'USD',
      paymentSource: 'CASH',
      category: 'OTHER',
    });
    createExpense({
      date: Math.floor(Date.now() / 1000),
      description: 'Paid personally',
      amountMinor: 5000,
      currency: 'USD',
      paymentSource: 'OWNER',
      category: 'OTHER',
    });

    const report = getSalesReport(range());
    expect(getCashBalance().currentBalanceUsdCents).toBe(7000);
    expect(report.expensesUsdCents).toBe(8000);
    expect(report.expensesCashUsdCents).toBe(3000);
    expect(report.expensesOwnerUsdCents).toBe(5000);
    expect(report.expensesUnclassifiedUsdCents).toBe(0);
    expect(
      report.expensesUsdCents,
    ).toBe(report.expensesCashUsdCents + report.expensesOwnerUsdCents);
    expect(report.netProfitUsdCents).toBe(-8000);
  });

  it('leaves legacy expense sources unknown and excludes them from cash deductions', () => {
    setCashOpeningBalance(10000);
    const expense = createExpense({
      date: Math.floor(Date.now() / 1000),
      description: 'Legacy source not known',
      amountMinor: 13000,
      currency: 'USD',
      paymentSource: 'OWNER',
      category: 'OTHER',
    });
    getDb().prepare('UPDATE expenses SET payment_source = NULL WHERE id = ?').run(expense.id);

    const report = getSalesReport(range());
    expect(getCashBalance().currentBalanceUsdCents).toBe(10000);
    expect(report.expensesUsdCents).toBe(13000);
    expect(report.expensesCashUsdCents).toBe(0);
    expect(report.expensesOwnerUsdCents).toBe(0);
    expect(report.expensesUnclassifiedUsdCents).toBe(13000);
  });

  it('requires an explicit payment source when creating an expense', () => {
    const input = {
      date: Math.floor(Date.now() / 1000),
      description: 'Missing source',
      amountMinor: 100,
      currency: 'USD',
      category: 'OTHER',
    };
    expect(() => createExpense(input)).toThrow(/paid from cash or by the owner/i);
  });

  it('sales - returns - COGS - expenses - waste = net profit, with partial returns reducing revenue and cost', () => {
    const p = makeProduct({ unit: 'WEIGHT', price: 450, cost: 300, stock: 10000 });
    const sale = completeSale({ lines: [A(p.id, 2000, 450)], payment: pay(900) });
    createReturn({ originalSaleId: sale.id, returnType: 'PARTIAL', items: [{ saleItemId: sale.items[0].id, quantityReturnedMinor: 500 }] });
    createExpense({ date: Math.floor(Date.now() / 1000), description: 'Bags', amountMinor: 50, currency: 'USD', paymentSource: 'OWNER', category: 'OTHER' });
    recordWaste({ productId: p.id, quantityMinor: 500, reason: 'Spoiled' });
    // Cost/price changes after the fact must not move the waste figure.
    updateProduct(p.id, { currentCost: 1000 });

    const r = getSalesReport(range());
    expect(r.totalUsdEquivalentCents).toBe(900);
    expect(r.returnsUsdCents).toBe(225);
    expect(r.netSalesUsdEquivalentCents).toBe(675);
    expect(r.costUsdCents).toBe(450);              // 1.5kg x $3.00
    expect(r.grossProfitUsdCents).toBe(225);
    expect(r.expensesUsdCents).toBe(50);
    expect(r.expensesCashUsdCents).toBe(0);
    expect(r.expensesOwnerUsdCents).toBe(50);
    expect(r.wasteUsdCents).toBe(150);             // 0.5kg x $3.00 at the time of waste
    expect(r.netProfitUsdCents).toBe(225 - 50 - 150);
    expect(r.invoiceCount).toBe(1);
  });

  it('a fully returned invoice nets to zero revenue and zero cost', () => {
    const p = makeProduct({ price: 1000, cost: 600, stock: 5 });
    const sale = completeSale({ lines: [A(p.id, 1, 1000)], payment: pay(1000) });
    createReturn({ originalSaleId: sale.id, returnType: 'FULL' });
    const r = getSalesReport(range());
    expect(r.netSalesUsdEquivalentCents).toBe(0);
    expect(r.costUsdCents).toBe(0);
    expect(r.grossProfitUsdCents).toBe(0);
  });

  it('suspended sales never appear in reports; best sellers aggregate by product', () => {
    const p = makeProduct({ price: 100, stock: 10 });
    completeSale({ lines: [A(p.id, 2, 100)], payment: pay(200) });
    completeSale({ lines: [A(p.id, 3, 100)], payment: pay(300) });
    const best = getBestSellingProducts(range(), 5);
    expect(best[0].quantitySoldMinor).toBe(5);
    expect(best[0].saleCount).toBe(2);
    expect(getSalesReport(range()).invoiceCount).toBe(2);
  });
});

describe('Inventory', () => {
  it('detects low weight stock using gram-based thresholds', () => {
    const belowThreshold = makeProduct({ name: 'Below threshold', unit: 'WEIGHT', price: 100, stock: 8000 });
    updateProduct(belowThreshold.id, { lowStockThreshold: 10000 });

    const aboveThreshold = makeProduct({ name: 'Above threshold', unit: 'WEIGHT', price: 100, stock: 12000 });
    updateProduct(aboveThreshold.id, { lowStockThreshold: 10000 });

    const lowStock = listLowStock();
    expect(lowStock.map((item) => item.productId)).toContain(belowThreshold.id);
    expect(lowStock.map((item) => item.productId)).not.toContain(aboveThreshold.id);
  });

  it('includes the current purchase cost in inventory rows', () => {
    const p = makeProduct({ price: 1000, cost: null, stock: 5 });
    expect(listInventory().find((item) => item.productId === p.id)?.currentCost).toBeNull();

    updateProduct(p.id, { currentCost: 350 });
    expect(listInventory().find((item) => item.productId === p.id)?.currentCost).toBe(350);

    addStock({ productId: p.id, quantityMinor: 2, currency: 'USD', unitCostMinor: 450 });
    expect(listInventory().find((item) => item.productId === p.id)?.currentCost).toBe(450);
  });

  it('add-stock cost is converted into the product currency and the product cost updates', () => {
    const p = makeProduct({ price: 1000, cost: 100, stock: 0 });
    addStock({ productId: p.id, quantityMinor: 5, currency: 'LBP', unitCostMinor: 89500 });
    // 89,500 LBP at 89,500 = $1.00 -> 100 cents
    expect(stockOf(p.id)).toBe(5);
    const row = getProduct(p.id)!;
    expect(row.currentCost).toBe(100);
  });
  it('waste needs a reason and cannot exceed stock', () => {
    const p = makeProduct({ price: 100, stock: 3 });
    expect(() => recordWaste({ productId: p.id, quantityMinor: 1, reason: '' })).toThrow();
    expect(() => recordWaste({ productId: p.id, quantityMinor: 4, reason: 'x' })).toThrow();
    expect(stockOf(p.id)).toBe(3);
  });
});

describe('Customers', () => {
  it('reports current positive customer balances once, independent of the sales date range', () => {
    const a = createCustomer({ name: 'Debt A' });
    const b = createCustomer({ name: 'Debt B' });
    const noDebt = createCustomer({ name: 'No debt' });
    const p = makeProduct({ price: 1000, stock: 2 });
    completeSale({ lines: [A(p.id, 1, 1000)], payment: pay(0), customerId: a.id, allowCredit: true });
    completeSale({ lines: [A(p.id, 1, 1000)], payment: pay(500), customerId: b.id, allowCredit: true });
    recordCustomerPayment({ customerId: a.id, currency: 'USD', amountMinor: 200 });
    getDb().prepare('UPDATE customers SET balance_usd_cents = -500 WHERE id = ?').run(noDebt.id);

    const before = getCurrentCustomerDebt();
    getSalesReport({ from: 1, to: 2 });
    expect(getCurrentCustomerDebt()).toBe(before);
    expect(before).toBe(1300);
  });

  it('payment cannot exceed the balance', () => {
    const c = createCustomer({ name: 'B' });
    const p = makeProduct({ price: 1000, stock: 5 });
    completeSale({ lines: [A(p.id, 1, 1000)], payment: pay(0), customerId: c.id, allowCredit: true });
    expect(() => recordCustomerPayment({ customerId: c.id, currency: 'USD', amountMinor: 1001 })).toThrow();
    expect(recordCustomerPayment({ customerId: c.id, currency: 'USD', amountMinor: 400 }).balanceUsdCents).toBe(600);
  });

  it('return after the customer has fully paid the original credit never creates a negative balance', () => {
    const c = createCustomer({ name: 'Paid customer' });
    const p = makeProduct({ price: 1000, stock: 2 });
    const sale = completeSale({ lines: [A(p.id, 1, 1000)], payment: pay(0), customerId: c.id, allowCredit: true });
    expect(getCustomer(c.id)!.balanceUsdCents).toBe(1000);
    recordCustomerPayment({ customerId: c.id, currency: 'USD', amountMinor: 1000 });
    expect(getCustomer(c.id)!.balanceUsdCents).toBe(0);
    createReturn({ originalSaleId: sale.id, returnType: 'FULL' });
    expect(getCustomer(c.id)!.balanceUsdCents).toBe(0);
  });

  it('LBP customer cash payments must respect the 5,000 note denomination', () => {
    const c = createCustomer({ name: 'LBP customer' });
    const p = makeProduct({ price: 1000, stock: 2 });
    completeSale({ lines: [A(p.id, 1, 1000)], payment: pay(0), customerId: c.id, allowCredit: true });
    expect(() => recordCustomerPayment({ customerId: c.id, currency: 'LBP', amountMinor: 5001 })).toThrow();
  });

  it('records an LBP partial payment as the actual cash and keeps the USD-cent remainder', () => {
    const c = createCustomer({ name: 'Partial LBP customer' });
    const p = makeProduct({ price: 200, stock: 1 });
    completeSale({ lines: [A(p.id, 1, 200)], payment: pay(0), customerId: c.id, allowCredit: true });

    const updated = recordCustomerPayment({
      customerId: c.id,
      currency: 'LBP',
      amountMinor: 175000,
    });
    const txn = listCustomerTransactions(c.id)[0];
    expect(updated.balanceUsdCents).toBe(4);
    expect(txn.amountUsdCents).toBe(-196);
    expect(txn.cashAmountMinor).toBe(175000);
    expect(txn.cashCurrency).toBe('LBP');
    expect(txn.roundingDifferenceLbp).toBe(0);
  });

  it('settles the full debt at the rounded cash amount without adding the difference to the balance', () => {
    const c = createCustomer({ name: 'Rounded settlement customer' });
    const p = makeProduct({ price: 200, stock: 1 });
    completeSale({ lines: [A(p.id, 1, 200)], payment: pay(0), customerId: c.id, allowCredit: true });

    const updated = recordCustomerPayment({
      customerId: c.id,
      currency: 'LBP',
      amountMinor: 180000,
      settleRemainder: true,
    });
    const txn = listCustomerTransactions(c.id)[0];
    expect(updated.balanceUsdCents).toBe(0);
    expect(txn.amountUsdCents).toBe(-200);
    expect(txn.cashAmountMinor).toBe(180000);
    expect(txn.cashCurrency).toBe('LBP');
    expect(txn.roundingDifferenceLbp).toBe(1000);
    expect(txn.notes).toContain('rounding difference 1000 LBP');
  });

  it('rejects an overpayment or a non-rounded amount unless full rounded settlement was selected', () => {
    const c = createCustomer({ name: 'Validated LBP customer' });
    const p = makeProduct({ price: 200, stock: 1 });
    completeSale({ lines: [A(p.id, 1, 200)], payment: pay(0), customerId: c.id, allowCredit: true });

    expect(() => recordCustomerPayment({
      customerId: c.id, currency: 'LBP', amountMinor: 180000,
    })).toThrow(/more than/i);
    expect(() => recordCustomerPayment({
      customerId: c.id, currency: 'LBP', amountMinor: 179000,
    })).toThrow(/multiple of 5,000/i);
    expect(getCustomer(c.id)!.balanceUsdCents).toBe(200);
  });

  it('preserves USD payment behavior and rejects payments when no balance is due', () => {
    const c = createCustomer({ name: 'USD payment customer' });
    const p = makeProduct({ price: 200, stock: 1 });
    completeSale({ lines: [A(p.id, 1, 200)], payment: pay(0), customerId: c.id, allowCredit: true });

    expect(recordCustomerPayment({
      customerId: c.id, currency: 'USD', amountMinor: 100,
    }).balanceUsdCents).toBe(100);
    const empty = createCustomer({ name: 'No debt customer' });
    expect(() => recordCustomerPayment({
      customerId: empty.id, currency: 'USD', amountMinor: 1,
    })).toThrow();
    expect(getCustomer(empty.id)!.balanceUsdCents).toBe(0);
  });

  it('closes a one-cent debt with rounded LBP cash without creating a negative balance', () => {
    const c = createCustomer({ name: 'Tiny debt customer' });
    const p = makeProduct({ price: 1, stock: 1 });
    completeSale({ lines: [A(p.id, 1, 1)], payment: pay(0), customerId: c.id, allowCredit: true });

    const updated = recordCustomerPayment({
      customerId: c.id,
      currency: 'LBP',
      amountMinor: 5000,
      settleRemainder: true,
    });
    const txn = listCustomerTransactions(c.id)[0];
    expect(updated.balanceUsdCents).toBe(0);
    expect(txn.cashAmountMinor).toBe(5000);
    expect(txn.roundingDifferenceLbp).toBe(4105);
  });
});

import { getInventoryMovementsReport } from '../src/main/services/database/reportsService';
describe('Inventory & waste report (D5)', () => {
  it('lists additions and waste in the date range with the cost snapshot; waste is not double counted', () => {
    const p = makeProduct({ unit: 'WEIGHT', price: 450, cost: 300, stock: 10000 });
    const noCost = makeProduct({ price: 100, stock: 5 });
    recordWaste({ productId: p.id, quantityMinor: 500, reason: 'Expired' });
    recordWaste({ productId: noCost.id, quantityMinor: 1, reason: 'Damaged' });
    updateProduct(p.id, { currentCost: 900 }); // must not change history
    const rep = getInventoryMovementsReport(range());
    expect(rep.additions.length).toBe(2);
    const w = rep.waste.find((x) => x.productName === p.name)!;
    expect(w.costUsdCents).toBe(150);
    expect(w.costKnown).toBe(true);
    expect(rep.waste.find((x) => x.productName === noCost.name)!.costKnown).toBe(false);
    // net profit deducts waste exactly once (no sales -> gross 0)
    const sr = getSalesReport(range());
    expect(sr.wasteUsdCents).toBe(150);
    expect(sr.costUsdCents).toBe(0);
    expect(sr.netProfitUsdCents).toBe(-150);
    // outside the range -> nothing
    const old = { from: 1, to: 2 };
    expect(getInventoryMovementsReport(old)).toEqual({ additions: [], waste: [] });
  });
});
