// End-to-end UI tests against the REAL packaged app (see harness.cjs).
// Results are written to e2e/RESULTS.json; screenshots to e2e/shots/.
const fs = require('node:fs');
const path = require('node:path');
const { launch, tmpDir } = require('./harness.cjs');

const results = [];
const shots = path.join(__dirname, 'shots');
fs.mkdirSync(shots, { recursive: true });
let app, page, dialogs = [];

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log('PASS', name);
  } catch (e) {
    results.push({ name, ok: false, error: String(e.message || e).split('\n')[0] });
    console.log('FAIL', name, '-', String(e.message || e).split('\n')[0]);
    try { await page.screenshot({ path: path.join(shots, 'FAIL-' + name.replace(/\W+/g, '_') + '.png') }); } catch { /* */ }
    // close any open modal so later steps can continue
    try { await page.keyboard.press('Escape'); for (let i = 0; i < 3 && await page.locator('.modal').count(); i++) { await page.locator('.modal .modal-header button, .modal .btn:has-text("Cancel")').first().click({ timeout: 1500 }).catch(() => {}); } } catch { /* */ }
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error('assert: ' + msg); };
const eq = (a, b, msg) => expect(JSON.stringify(a) === JSON.stringify(b), `${msg}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
const api = (fn, ...args) => page.evaluate(([f, a]) => window.posApi[f](...a), [fn, args]);
const nav = (label) => page.locator('nav a', { hasText: label }).click();
const field = (label) => page.locator('.form-group', { has: page.locator('label', { hasText: label }) }).locator('input, select').first();
const btn = (text, scope = page) => scope.locator('button', { hasText: text });
const modal = () => page.locator('.modal').last();
const shot = (n) => page.screenshot({ path: path.join(shots, n + '.png') });

async function start(dir) {
  dialogs = [];
  app = await launch(dir);
  page = app.page;
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.waitForSelector('#root *', { timeout: 15000 });
}

async function addProductUI({ name, nameAr, type, price, currency = 'USD', cost }) {
  await nav('Products');
  await btn('Add Product').click();
  await field('Product Name').fill(name);
  if (nameAr) await field('Arabic Name').fill(nameAr);
  await page.locator('.modal select').nth(0).selectOption({ index: 1 }).catch(() => {});
  await field('Selling Type').selectOption(type);
  await field('Current Price').fill(price);
  await field('Currency').selectOption(currency);
  if (cost) await field('Purchase Cost').fill(cost);
  await btn('Save Product').click();
  await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 });
}
async function productId(name) { return (await api('listProducts', false)).find((p) => p.name === name).id; }
async function stock(name) { return (await api('listInventory')).find((i) => i.productName === name).quantityMinor; }
async function salesCount() { return (await api('listSales', { limit: 500 })).length; }
async function addToCartUI(productName, qty, opts = {}) {
  await nav('Sales');
  await page.locator('.product-card', { hasText: productName }).first().click();
  const m = modal();
  if (opts.direct) { await btn('Direct Final Price', m).click(); await m.locator('input').nth(1).fill(opts.direct); }
  await m.locator('input').first().fill(String(qty));
  return m;
}

module.exports = { results, step, expect, eq, api, nav, field, btn, modal, shot, start, addProductUI, productId, stock, salesCount, addToCartUI,
  get page() { return page; }, get app() { return app; }, get dialogs() { return dialogs; }, tmpDir };
