/**
 * Printing service — isolated behind a service boundary (PRD 43, 44).
 *
 * Guarantees
 *   - A sale is already committed to SQLite before anything here runs. Nothing in this file
 *     can undo, change or duplicate a sale.
 *   - printReceipt NEVER throws: every failure (no printer, disconnected, timeout, driver
 *     error) becomes { success: false, error } and the POS keeps working.
 *   - The receipt is rendered from the PERSISTED invoice (looked up by id), not from data
 *     sent by the renderer.
 */

import { BrowserWindow } from 'electron';
import type { SaleDTO } from '@shared/types/index';
import { getShopInfo, setAppSetting, getAppSetting } from '../database/settingsService';
import { getSale } from '../database/salesService';
import { buildReceiptHtml as buildHtml } from './receipt';
import { requireObject, requireId, ValidationError } from '@shared/validation/index';

let cachedPrinters: Array<{ name: string; displayName: string; isDefault: boolean }> = [];

const PRINT_TIMEOUT_MS = 30_000;

export interface PrinterSettings {
  enabled: boolean;
  printerName: string | null; // null = system default
  paperWidth: 80 | 58;
  silent: boolean;
}

export function getPrinterSettings(): PrinterSettings {
  const enabled = getAppSetting('printer_enabled') === '1';
  const printerName = getAppSetting('printer_name');
  const paperWidthStr = getAppSetting('printer_paper_width') ?? '80';
  const silent = getAppSetting('printer_silent') !== '0';
  return {
    enabled,
    printerName: printerName ? printerName : null,
    paperWidth: paperWidthStr === '58' ? 58 : 80,
    silent,
  };
}

export function savePrinterSettings(raw: unknown): PrinterSettings {
  const o = requireObject(raw, 'Printer settings');
  if (o.paperWidth !== 58 && o.paperWidth !== 80) {
    throw new ValidationError('Paper width must be 58 or 80 mm');
  }
  if (o.printerName !== null && o.printerName !== undefined) {
    if (typeof o.printerName !== 'string' || o.printerName.length > 200) {
      throw new ValidationError('Invalid printer name');
    }
  }
  const settings: PrinterSettings = {
    enabled: o.enabled === true,
    printerName: typeof o.printerName === 'string' && o.printerName ? o.printerName : null,
    paperWidth: o.paperWidth,
    silent: o.silent !== false,
  };
  setAppSetting('printer_enabled', settings.enabled ? '1' : '0');
  setAppSetting('printer_name', settings.printerName ?? '');
  setAppSetting('printer_paper_width', String(settings.paperWidth));
  setAppSetting('printer_silent', settings.silent ? '1' : '0');
  return settings;
}

export async function listAvailablePrinters(): Promise<
  Array<{ name: string; displayName: string; isDefault: boolean }>
> {
  try {
    const windows = BrowserWindow.getAllWindows();
    if (!windows.length) return cachedPrinters;
    const printers = await windows[0].webContents.getPrintersAsync();
    cachedPrinters = printers.map((p) => ({
      name: p.name,
      displayName: p.displayName || p.name,
      isDefault: String((p.options as Record<string, string> | undefined)?.['is-default']) === 'true',
    }));
    return cachedPrinters;
  } catch (err) {
    console.error('Failed to list printers:', err);
    return cachedPrinters;
  }
}

/** Receipt HTML for a persisted sale, using the shop's language and the saved paper width. */
export function buildReceiptHtml(sale: SaleDTO): string {
  const shop = getShopInfo();
  const settings = getPrinterSettings();
  return buildHtml(sale, shop, {
    paperWidth: settings.paperWidth,
    language: shop?.language ?? 'en',
  });
}

export type PrintResult = { success: boolean; skipped?: boolean; error?: string };

async function printHtml(html: string, settings: PrinterSettings): Promise<void> {
  const printers = await listAvailablePrinters();
  if (printers.length === 0) {
    throw new Error('No printer was found on this computer.');
  }
  const win = new BrowserWindow({
    width: 400,
    height: 600,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      javascript: false,
    },
  });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 200));
    const printerName =
      settings.printerName && printers.some((p) => p.name === settings.printerName)
        ? settings.printerName
        : undefined; // system default
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        win.webContents.print(
          {
            silent: settings.silent,
            printBackground: true,
            deviceName: printerName,
            margins: { marginType: 'none' },
          },
          (success, failureType) => {
            if (success) resolve();
            else reject(new Error(`The printer reported an error (${failureType}).`));
          },
        );
      }),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('The printer did not respond.')), PRINT_TIMEOUT_MS),
      ),
    ]);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * Print the receipt of an already-saved invoice. Returns { skipped: true } when printing
 * is disabled — the shop works perfectly without a printer.
 */
export async function printReceipt(saleId: unknown): Promise<PrintResult> {
  try {
    const settings = getPrinterSettings();
    if (!settings.enabled) return { success: true, skipped: true };
    const sale = getSale(requireId(saleId, 'Invoice'));
    if (!sale) return { success: false, error: 'The invoice was not found.' };
    await printHtml(buildReceiptHtml(sale), settings);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Printing error:', message);
    return { success: false, error: message };
  }
}

/** Print a test page with the current settings (works even if printing is "disabled"). */
export async function testPrint(): Promise<PrintResult> {
  try {
    const settings = getPrinterSettings();
    const now = Math.floor(Date.now() / 1000);
    const sale: SaleDTO = {
      id: 0,
      invoiceNumber: 'TEST-0001',
      status: 'COMPLETED',
      totalUsdCents: 563,
      totalLbp: 0,
      costUsdCents: 438,
      exchangeRateSnapshot: 89500,
      totalUsdEquivalentCents: 563,
      customerId: null,
      creditUsdCents: 0,
      createdAt: now,
      completedAt: now,
      items: [
        {
          id: 0,
          productId: 0,
          productNameSnapshot: 'Test Product',
          productNameArSnapshot: 'منتج تجريبي',
          categoryIdSnapshot: 0,
          sellingUnitSnapshot: 'WEIGHT',
          quantityMinor: 1250,
          unitPriceMinor: 450,
          priceCurrencySnapshot: 'USD',
          directFinalPrice: false,
          lineTotalMinor: 563,
          unitCostSnapshot: 350,
          lineCostMinor: 438,
          exchangeRateSnapshot: 89500,
          returnedQuantityMinor: 0,
        },
      ],
      payment: {
        id: 0,
        paymentType: 'USD',
        paidUsdCents: 1000,
        paidLbp: 0,
        changeUsdCents: 437,
        changeLbp: 0,
        exchangeRateSnapshot: 89500,
      },
    };
    await printHtml(buildReceiptHtml(sale), settings);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Test print error:', message);
    return { success: false, error: message };
  }
}
