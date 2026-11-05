/**
 * Receipt HTML builder — pure (no Electron), so it can be unit-tested.
 * PRD 42, 43. The receipt is built ONLY from the persisted invoice (SaleDTO loaded from
 * the database), never from renderer-supplied data.
 *
 * Width: 80 mm (default) or 58 mm. Arabic uses RTL layout and Arabic labels.
 */

import type { SaleDTO, ShopInfo, Language } from '@shared/types/index';
import { formatUsd, formatLbp, formatWeightKg } from '@shared/money/index';
import { SELLING_UNIT_LABELS } from '@shared/constants/index';

export interface ReceiptOptions {
  paperWidth: 80 | 58;
  language: Language;
}

const LABELS: Record<Language, Record<string, string>> = {
  en: {
    invoice: 'Invoice',
    date: 'Date',
    usdTotal: 'Total (USD)',
    lbpTotal: 'Total (LBP)',
    paidUsd: 'Paid USD',
    paidLbp: 'Paid LBP',
    changeUsd: 'Change USD',
    changeLbp: 'Change LBP',
    credit: 'On account',
    rate: 'Rate',
    thanks: 'Thank you!',
    perLbpUsd: 'LBP/USD',
  },
  ar: {
    invoice: 'فاتورة',
    date: 'التاريخ',
    usdTotal: 'المجموع (دولار)',
    lbpTotal: 'المجموع (ليرة)',
    paidUsd: 'المدفوع بالدولار',
    paidLbp: 'المدفوع بالليرة',
    changeUsd: 'الباقي بالدولار',
    changeLbp: 'الباقي بالليرة',
    credit: 'على الحساب',
    rate: 'سعر الصرف',
    thanks: 'شكراً لزيارتكم!',
    perLbpUsd: 'ليرة/دولار',
  },
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const money = (minor: number, cur: string): string =>
  cur === 'USD' ? formatUsd(minor) : formatLbp(minor);

export function buildReceiptHtml(
  sale: SaleDTO,
  shop: ShopInfo | null,
  opts: ReceiptOptions,
): string {
  const L = LABELS[opts.language];
  const rtl = opts.language === 'ar';
  const lines: string[] = [];
  const divider = '<div class="div"></div>';

  if (shop) {
    if (shop.shopName) lines.push(`<h1>${escapeHtml(shop.shopName)}</h1>`);
    if (shop.receiptHeader) lines.push(`<p class="meta">${escapeHtml(shop.receiptHeader)}</p>`);
    if (shop.phone) lines.push(`<p class="meta">${escapeHtml(shop.phone)}</p>`);
    if (shop.address) lines.push(`<p class="meta">${escapeHtml(shop.address)}</p>`);
  }
  lines.push(`<p class="meta">${L.invoice}: ${escapeHtml(sale.invoiceNumber)}</p>`);
  lines.push(
    `<p class="meta">${L.date}: ${escapeHtml(new Date(sale.createdAt * 1000).toLocaleString(rtl ? 'ar-LB' : 'en-GB'))}</p>`,
  );
  lines.push(divider);

  for (const item of sale.items) {
    const unit = SELLING_UNIT_LABELS[item.sellingUnitSnapshot];
    const qty =
      item.sellingUnitSnapshot === 'WEIGHT'
        ? `${formatWeightKg(item.quantityMinor)} KG`
        : `${item.quantityMinor} ${unit.short}`;
    const name =
      rtl && item.productNameArSnapshot ? item.productNameArSnapshot : item.productNameSnapshot;
    const unitPrice = item.directFinalPrice
      ? ''
      : `<span class="ltr">× ${money(item.unitPriceMinor, item.priceCurrencySnapshot)}</span>`;
    lines.push(`
      <div class="item">
        <div class="item-name">${escapeHtml(name)}</div>
        <div class="item-row">
          <span class="ltr">${escapeHtml(qty)}</span>
          ${unitPrice}
          <span class="item-total ltr">${money(item.lineTotalMinor, item.priceCurrencySnapshot)}</span>
        </div>
      </div>`);
  }
  lines.push(divider);

  const row = (label: string, value: string, cls = '') =>
    `<div class="total ${cls}"><span>${label}</span><span class="ltr">${value}</span></div>`;
  if (sale.totalUsdCents > 0) lines.push(row(L.usdTotal, formatUsd(sale.totalUsdCents), 'big'));
  if (sale.totalLbp > 0) lines.push(row(L.lbpTotal, formatLbp(sale.totalLbp), 'big'));
  if (sale.payment) {
    lines.push(divider);
    if (sale.payment.paidUsdCents > 0) lines.push(row(L.paidUsd, formatUsd(sale.payment.paidUsdCents)));
    if (sale.payment.paidLbp > 0) lines.push(row(L.paidLbp, formatLbp(sale.payment.paidLbp)));
    if (sale.payment.changeUsdCents > 0) lines.push(row(L.changeUsd, formatUsd(sale.payment.changeUsdCents), 'change'));
    if (sale.payment.changeLbp > 0) lines.push(row(L.changeLbp, formatLbp(sale.payment.changeLbp), 'change'));
  }
  if (sale.creditUsdCents > 0) lines.push(row(L.credit, formatUsd(sale.creditUsdCents), 'change'));
  lines.push(
    `<p class="meta">${L.rate}: <span class="ltr">${sale.exchangeRateSnapshot.toLocaleString('en-US')} ${L.perLbpUsd}</span></p>`,
  );
  if (shop?.receiptFooter) lines.push(`<p class="footer">${escapeHtml(shop.receiptFooter)}</p>`);
  lines.push(`<p class="thanks">${L.thanks}</p>`);

  const fontPx = opts.paperWidth === 58 ? '10px' : '12px';
  const widthMm = opts.paperWidth === 58 ? '52mm' : '72mm';

  return `<!doctype html>
<html lang="${opts.language}" dir="${rtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: ${fontPx}; width: ${widthMm}; color: #000; padding: 4px; }
  h1 { font-size: 16px; text-align: center; margin-bottom: 4px; overflow-wrap: anywhere; }
  p { margin: 1px 0; }
  p.meta { font-size: 11px; color: #222; text-align: center; overflow-wrap: anywhere; }
  p.footer { font-size: 10px; text-align: center; margin-top: 8px; overflow-wrap: anywhere; }
  p.thanks { text-align: center; margin-top: 4px; font-weight: bold; }
  .ltr { direction: ltr; unicode-bidi: embed; }
  .div { border-top: 1px dashed #444; margin: 6px 0; height: 0; }
  .item { margin: 4px 0; }
  .item-name { font-weight: bold; overflow-wrap: anywhere; }
  .item-row { display: flex; justify-content: space-between; gap: 6px; }
  .item-total { font-weight: bold; }
  .total { display: flex; justify-content: space-between; gap: 6px; margin: 2px 0; font-size: 13px; }
  .total.big { font-weight: bold; font-size: 14px; }
  .total.change { font-weight: bold; }
</style>
</head>
<body>
${lines.join('\n')}
</body>
</html>`;
}
