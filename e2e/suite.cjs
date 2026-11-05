const h = require('./run.cjs');
const { step, expect, eq, api, nav, field, btn, modal, shot, start, addProductUI, productId, stock, salesCount, addToCartUI } = h;

(async () => {
  const dir = h.tmpDir();
  await start(dir);

  await step('01 first-run setup wizard (English)', async () => {
    await h.page.waitForSelector('.setup-container');
    await shot('01-setup-en');
    await h.page.locator('.setup-container input').first().fill('Test Shop');
    await field('Exchange Rate').fill('89500');
    await btn('Start Using POS').click();
    await h.page.waitForSelector('.app-shell', { timeout: 8000 });
    eq(await api('isInitialized'), true, 'initialized');
    eq((await api('getCurrentRate')).currentRate, 89500, 'rate');
  });

  await step('02 create products via UI (weight, piece, LBP, USD box)', async () => {
    await addProductUI({ name: 'Chicken', type: 'WEIGHT', price: '4.50', cost: '3.00' });
    await addProductUI({ name: 'Box', type: 'PIECE', price: '10', cost: '6' });
    await addProductUI({ name: 'Gum', type: 'PIECE', price: '87300', currency: 'LBP' });
    const names = (await api('listProducts', false)).map((p) => p.name).sort();
    eq(names, ['Box', 'Chicken', 'Gum'], 'products');
    await shot('02-products');
  });

  await step('03 edit price via UI', async () => {
    await nav('Products');
    await h.page.locator('tr', { hasText: 'Box' }).locator('button', { hasText: /Edit/ }).first().click();
    await field('Current Price').fill('12');
    await btn('Save Product').click();
    await h.page.waitForSelector('.modal', { state: 'detached' });
    eq((await api('listProducts', false)).find((p) => p.name === 'Box').currentPrice, 1200, 'price');
    // restore to 10 for later maths
    await h.page.locator('tr', { hasText: 'Box' }).locator('button', { hasText: /Edit/ }).first().click();
    await field('Current Price').fill('10');
    await btn('Save Product').click();
    await h.page.waitForSelector('.modal', { state: 'detached' });
  });

  await step('04 add stock via Inventory UI', async () => {
    await nav('Inventory');
    await h.page.locator('tr', { hasText: 'Chicken' }).locator('button', { hasText: 'Add Stock' }).click();
    await modal().locator('input:not([disabled])').first().fill('10');
    await btn('Add Stock', modal()).last().click();
    await h.page.waitForSelector('.modal', { state: 'detached', timeout: 5000 });
    eq(await stock('Chicken'), 10000, 'chicken stock');
    // other products seeded through the API (UI path for add-stock proven above)
    for (const [n, q] of [['Box', 5], ['Gum', 20]]) {
      await api('addStock', { productId: await productId(n), quantityMinor: q, currency: n === 'Gum' ? 'LBP' : 'USD', unitCostMinor: null });
    }
  });

  await step('05 weight sale: 1.350 kg x $4.50 = $6.08, pay $10, change $3.92', async () => {
    const m = await addToCartUI('Chicken', '1.350');
    await h.page.waitForTimeout(200);
    expect((await m.innerText()).includes('$6.08'), 'preview $6.08');
    await btn('Add to Cart', m).click();
    await btn('Complete Sale').first().click();
    const pay = modal();
    await pay.locator('input').nth(0).fill('10');
    await h.page.waitForTimeout(200);
    const txt = await pay.innerText();
    expect(txt.includes('$3.92'), 'change shows $3.92');
    await shot('05-payment-dialog');
    await btn('Complete Sale', pay).last().click();
    await h.page.waitForSelector('text=Sale completed');
    await shot('05-sale-completed');
    await btn('New Sale').click().catch(() => btn('Close').first().click());
    eq(await stock('Chicken'), 8650, 'stock after sale');
    const s = (await api('listSales', { limit: 5 }))[0];
    eq([s.totalUsdCents, s.payment.changeUsdCents], [608, 392], 'sale amounts');
  });


  const pay = () => modal();
  const closeDone = async () => { await h.page.waitForSelector('text=Sale completed'); await btn('New Sale').click(); await h.page.waitForSelector('text=Sale completed', { state: 'detached' }); };
  const openPay = async () => { await btn('Complete Sale').first().click(); await h.page.waitForSelector('.modal'); };
  const completeBtn = () => btn('Complete Sale', pay()).last();

  await step('06 direct final price entry (1.000 kg, scale says $6.00)', async () => {
    const m = await addToCartUI('Chicken', '1.000', { direct: '6.00' });
    await btn('Add to Cart', m).click();
    await openPay();
    await pay().locator('input').nth(0).fill('6');
    await completeBtn().click();
    await closeDone();
    const s = (await api('listSales', { limit: 1 }))[0];
    eq([s.totalUsdCents, s.items[0].directFinalPrice, s.items[0].quantityMinor], [600, true, 1000], 'direct sale');
    eq(await stock('Chicken'), 7650, 'stock');
  });

  await step('07 LBP-only: 87,300 owed -> 90,000 cash due; 87,300 paid is refused', async () => {
    const m = await addToCartUI('Gum', '1');
    await btn('Add to Cart', m).click();
    await openPay();
    await pay().locator('input').nth(1).fill('87300');
    await h.page.waitForTimeout(150);
    expect(await completeBtn().isDisabled(), 'complete disabled at 87,300');
    await shot('07-lbp-short');
    await pay().locator('input').nth(1).fill('90000');
    await h.page.waitForTimeout(150);
    expect(!(await completeBtn().isDisabled()), 'complete enabled at 90,000');
    expect((await pay().innerText()).includes('90,000'), 'shows 90,000 cash due');
    await completeBtn().click();
    await closeDone();
    const s = (await api('listSales', { limit: 1 }))[0];
    eq([s.totalLbp, s.payment.paidLbp, s.payment.changeLbp], [87300, 90000, 0], 'stored exact total, no change');
  });

  await step('08 mixed currency: $10 invoice paid $5 + 447,500 LBP is exact', async () => {
    const m = await addToCartUI('Box', '1');
    await btn('Add to Cart', m).click();
    await openPay();
    await pay().locator('input').nth(0).fill('5');
    await pay().locator('input').nth(1).fill('447500');
    await h.page.waitForTimeout(150);
    expect(!(await completeBtn().isDisabled()), 'enabled');
    await completeBtn().click();
    await closeDone();
    const s = (await api('listSales', { limit: 1 }))[0];
    eq([s.totalUsdCents, s.payment.changeUsdCents, s.payment.changeLbp], [1000, 0, 0], 'no change');
  });

  await step('09 change returned in LBP and in USD', async () => {
    let m = await addToCartUI('Box', '1');
    await btn('Add to Cart', m).click();
    await openPay();
    await pay().locator('input').nth(0).fill('11');
    await btn('LBP', pay()).last().click();
    await h.page.waitForTimeout(150);
    expect((await pay().innerText()).includes('90,000'), 'LBP change 90,000');
    await shot('09-change-lbp');
    await completeBtn().click();
    await closeDone();
    let s = (await api('listSales', { limit: 1 }))[0];
    eq([s.payment.changeLbp, s.payment.changeUsdCents], [90000, 0], 'LBP change stored');
    // USD change on a second Box
    m = await addToCartUI('Box', '1');
    await btn('Add to Cart', m).click();
    await openPay();
    await pay().locator('input').nth(0).fill('20');
    await h.page.waitForTimeout(150);
    await completeBtn().click();
    await closeDone();
    s = (await api('listSales', { limit: 1 }))[0];
    eq([s.payment.changeUsdCents, s.payment.changeLbp], [1000, 0], 'USD change stored');
  });

  await step('10 insufficient stock: warning, add blocked, sale cannot proceed', async () => {
    eq(await stock('Box'), 2, 'box stock');
    let m = await addToCartUI('Box', '3');
    await btn('Add to Cart', m).click();
    await h.page.waitForTimeout(150);
    expect((await m.innerText()).toLowerCase().includes('not enough stock'), 'warning shown in dialog');
    await shot('10-insufficient-stock');
    await m.locator('input').first().fill('2');
    await btn('Add to Cart', m).click();
    // 2 in cart; adding 1 more must be refused using cart-aware availability
    m = await addToCartUI('Box', '1');
    await btn('Add to Cart', m).click();
    await h.page.waitForTimeout(150);
    expect((await m.innerText()).toLowerCase().includes('not enough stock'), 'cart-aware warning');
    await btn('Cancel', m).click();
    eq(await stock('Box'), 2, 'stock untouched');
  });


  await step('11 suspend, resume only into empty cart, banner', async () => {
    await btn('Suspend').first().click();
    await btn('Suspend', modal()).last().click();
    await h.page.waitForSelector('text=Suspended Sale');
    eq((await api('getSuspendedSale')).status, 'SUSPENDED', 'suspended');
    eq(await stock('Box'), 2, 'suspend does not touch stock');
    await shot('11-suspended');
    await btn('Resume Suspended Sale').click();
    await h.page.waitForSelector('.cart-item');
    eq(await api('getSuspendedSale'), null, 'suspended consumed');
    await btn('Clear Cart').click();
    eq(await h.page.locator('.cart-item').count(), 0, 'cart cleared');
  });

  await step('12 duplicate submit: double-click Complete Sale creates one invoice', async () => {
    const before = await salesCount();
    const m = await addToCartUI('Gum', '1');
    await btn('Add to Cart', m).click();
    await openPay();
    await pay().locator('input').nth(1).fill('90000');
    await h.page.waitForTimeout(150);
    await completeBtn().dblclick({ delay: 10 });
    await h.page.waitForSelector('text=Sale completed');
    await h.page.waitForTimeout(400);
    eq(await salesCount(), before + 1, 'one new sale');
    eq(await stock('Gum'), 18, 'stock deducted once');
    await btn('New Sale').click();
  });

  await step('13 empty cart shows no Complete Sale; payment button disabled with nothing paid', async () => {
    await nav('Sales');
    eq(await btn('Complete Sale').count(), 0, 'no complete button on empty cart');
    const m = await addToCartUI('Gum', '1');
    await btn('Add to Cart', m).click();
    await openPay();
    expect(await completeBtn().isDisabled(), 'disabled with no payment');
    await btn('Cancel', pay()).click().catch(() => h.page.keyboard.press('Escape'));
    await h.page.keyboard.press('Escape');
    await btn('Clear Cart').click();
  });

  await step('14 invalid input is rejected with a friendly message', async () => {
    let m = await addToCartUI('Chicken', '1.2345');
    await btn('Add to Cart', m).click();
    await h.page.waitForTimeout(150);
    expect(await m.locator('.alert-error').count() > 0, 'weight error shown');
    await btn('Cancel', m).click();
    await nav('Products');
    await btn('Add Product').click();
    await btn('Save Product').click();
    await h.page.waitForTimeout(200);
    expect(await modal().locator('.alert-error').count() > 0, 'product form error');
    await btn('Cancel', modal()).click();
  });

  await step('15 returns UI: partial, partial again, then return the remainder', async () => {
    const cid = await productId('Chicken');
    const sale = await api('completeSale', { lines: [{ productId: cid, quantityMinor: 2000, unitPriceMinor: 450, priceCurrency: 'USD', directFinalPrice: false, lineTotalMinor: 0 }], payment: { paidUsdCents: 900, paidLbp: 0, changeCurrency: 'USD' } });
    const before = await stock('Chicken');
    const doReturn = async (type, qty) => {
      await nav('Invoices');
      await h.page.locator('tr', { hasText: sale.invoiceNumber }).locator('button', { hasText: 'Return' }).click();
      if (type === 'PARTIAL') { await btn('Partial Return', modal()).click(); await modal().locator('tbody input').first().fill(qty); }
      await btn('Confirm Return', modal()).click();
      await h.page.waitForSelector('.modal', { state: 'detached', timeout: 5000 });
    };
    await doReturn('PARTIAL', '0.500');
    await doReturn('PARTIAL', '0.500');
    eq((await api('getSale', sale.id)).items[0].returnedQuantityMinor, 1000, 'returned so far');
    eq((await api('getSale', sale.id)).status, 'COMPLETED', 'still completed');
    await doReturn('FULL');
    const after = await api('getSale', sale.id);
    eq([after.status, after.items[0].returnedQuantityMinor], ['RETURNED', 2000], 'fully returned');
    eq(await stock('Chicken'), before + 2000, 'stock restored exactly');
    const rets = await api('listReturns', { limit: 10 });
    eq(rets.filter((r) => r.originalSaleId === sale.id).map((r) => r.refundUsdCents).reduce((a, b) => a + b, 0), 900, 'refunds sum to the sale');
    await nav('Invoices'); await shot('15-invoices');
  });

  await step('16 expenses UI and profit report reconcile with the API', async () => {
    await nav('Expenses');
    await btn('Add Expense').click();
    await field('Description').fill('Bags');
    await field('Amount').fill('5');
    await btn('Save', modal()).click();
    await h.page.waitForSelector('.modal', { state: 'detached', timeout: 5000 });
    await nav('Reports');
    await h.page.waitForSelector('.stat-grid');
    const now = Math.floor(Date.now() / 1000);
    const r = await api('getSalesReport', { from: now - 86400, to: now + 86400 });
    expect(r.expensesUsdCents >= 500, 'expense counted');
    const txt = await h.page.locator('.stat-grid').innerText();
    const fmt = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
    for (const [k, v] of [['net', r.netProfitUsdCents], ['gross', r.totalUsdEquivalentCents], ['exp', r.expensesUsdCents]]) expect(txt.includes(fmt(v)), `${k} ${fmt(v)} shown`);
    await shot('16-reports');
    await btn('Inventory & Waste').click();
    await h.page.waitForSelector('[data-testid=inventory-report]');
    await h.page.waitForTimeout(400);
    expect((await h.page.locator('[data-testid=inventory-report]').innerText()).includes('Chicken'), 'real stock rows');
    await shot('16-inventory-report');
    await btn('Returns').click();
    await h.page.waitForSelector('[data-testid=returns-report]');
  });

  await step('17 waste via UI appears in the waste report with its cost snapshot', async () => {
    await nav('Inventory');
    await h.page.locator('tr', { hasText: 'Chicken' }).locator('button', { hasText: 'Record Waste' }).click();
    await modal().locator('input:not([disabled])').first().fill('0.500');
    await btn('Record Waste', modal()).last().click();
    await h.page.waitForSelector('.modal', { state: 'detached', timeout: 5000 });
    await nav('Reports');
    await btn('Inventory & Waste').click();
    await h.page.waitForTimeout(500);
    eq(await h.page.locator('[data-testid=waste-total]').innerText(), '$1.50', 'waste cost 0.5kg x $3.00');
  });

  await step('18 backup via UI, change data, restore via UI, data reverted', async () => {
    await nav('Backup');
    await btn('Create Backup Now').click();
    await h.page.waitForSelector('.alert-success');
    const n0 = (await api('listExpenses', {})).length;
    await api('createExpense', { date: Math.floor(Date.now() / 1000), description: 'After backup', amountMinor: 100, currency: 'USD', category: 'OTHER' });
    eq((await api('listExpenses', {})).length, n0 + 1, 'added');
    await h.page.locator('tbody tr button', { hasText: 'Restore' }).first().click();
    await h.page.waitForTimeout(3500);
    await h.page.waitForSelector('.app-shell');
    eq((await api('listExpenses', {})).length, n0, 'restored to backup state');
    expect(h.dialogs.some((d) => /restore|replace/i.test(d)), 'confirmation shown');
    expect(await api('isInitialized'), 'still initialised');
  });

  await step('19 crash recovery: draft cart survives kill -9, restores once, no double sale', async () => {
    await nav('Sales');
    let m = await addToCartUI('Chicken', '0.750');
    await btn('Add to Cart', m).click();
    await h.page.waitForTimeout(900); // debounce
    const sales0 = await salesCount(), st0 = await stock('Chicken');
    h.app.kill();
    await h.app.close();
    await start(dir);
    await h.page.waitForSelector('text=Unfinished cart recovered', { timeout: 10000 });
    await shot('19-draft-banner');
    eq([await salesCount(), await stock('Chicken')], [sales0, st0], 'draft booked nothing');
    await btn('Restore cart').click();
    expect((await h.page.locator('.cart-total').innerText()).includes('$3.38'), 'restored total $3.38');
    await openPay();
    await pay().locator('input').nth(0).fill('4');
    await completeBtn().click();
    await closeDone();
    eq(await salesCount(), sales0 + 1, 'exactly one sale');
    await h.app.close();
    await start(dir);
    await h.page.waitForTimeout(1500);
    eq(await h.page.locator('text=Unfinished cart recovered').count(), 0, 'no draft after sale');
  });

  await step('20 draft: discard clears it', async () => {
    await nav('Sales');
    const m = await addToCartUI('Gum', '1');
    await btn('Add to Cart', m).click();
    await h.page.waitForTimeout(900);
    h.app.kill(); await h.app.close(); await start(dir);
    await h.page.waitForSelector('text=Unfinished cart recovered', { timeout: 10000 });
    await btn('Discard').click();
    eq(await api('getDraftCart'), null, 'draft cleared');
  });

  await step('21 Arabic RTL: switch language in Settings; layout checks and screenshots', async () => {
    await nav('Settings');
    await field('Application Language').selectOption('ar');
    await h.page.locator('button.btn-primary').first().click();
    await h.page.waitForTimeout(600);
    const dir_ = await h.page.evaluate(() => [document.documentElement.dir, getComputedStyle(document.body).direction]);
    eq(dir_, ['rtl', 'rtl'], 'rtl');
    const sidebarRight = await h.page.evaluate(() => document.querySelector('.app-sidebar').getBoundingClientRect().left > innerWidth / 2);
    expect(sidebarRight, 'sidebar on the right in RTL');
    const links = await h.page.locator('nav a').allInnerTexts();
    expect(links.some((t) => /[؀-ۿ]/.test(t)), 'Arabic nav labels');
    for (const [name, route] of [['pos', 0], ['products', 1], ['inventory', 2], ['invoices', 3], ['customers', 4], ['reports', 5], ['expenses', 6], ['settings', 7], ['backup', 8]]) {
      await h.page.locator('nav a').nth(route).click();
      await h.page.waitForTimeout(500);
      const over = await h.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      expect(!over, `no horizontal overflow on ${name}`);
      await shot('21-ar-' + name);
    }
    await h.page.locator('nav a').nth(0).click();
    const m = await (async () => { await h.page.locator('.product-card').first().click(); return modal(); })();
    await shot('21-ar-add-dialog');
    await h.page.keyboard.press('Escape'); await btn('إلغاء', m).click().catch(() => {});
  });

  await step('22 switch back to English (LTR)', async () => {
    await api('saveShopInfo', { language: 'en' });
    await h.page.reload();
    await h.page.waitForSelector('.app-shell');
    await h.page.waitForTimeout(500);
    eq(await h.page.evaluate(() => getComputedStyle(document.body).direction), 'ltr', 'ltr');
  });
  // STAGE2
  await h.app.close();
  require('node:fs').writeFileSync(__dirname + '/RESULTS.json', JSON.stringify(h.results, null, 1));
  console.log(h.results.filter((r) => r.ok).length + '/' + h.results.length + ' passed');
  process.exit(0);
})();
