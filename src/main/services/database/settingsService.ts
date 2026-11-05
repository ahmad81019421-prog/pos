/**
 * Settings service — shop info, language, currency, receipt settings.
 */

import { eq } from 'drizzle-orm';
import {
  getDb,
  getDrizzle,
  isShopInitialized, rowOf } from './connection';
import { shopSettings, appSettings, auditLog } from './schema';
import { DEFAULT_CATEGORIES, DEFAULT_EXCHANGE_RATE } from '@shared/constants/index';
import { categories } from './schema';
import type {
  Language,
  Currency,
  ShopInfo,
} from '@shared/types/index';
import { requireNonEmptyString, requireCurrency, requireLanguage, requireObject, optionalString, ValidationError } from '@shared/validation/index';
import { MAX_RATE } from '@shared/money/index';
import { recordExchangeRateChange } from './exchangeRate';

export function getShopInfo(): ShopInfo | null {
  if (!isShopInitialized()) return null;
  const db = getDb();
  const row = rowOf(shopSettings, db.prepare('SELECT * FROM shop_settings LIMIT 1').get());
  if (!row) return null;
  return {
    shopName: row.shopName,
    phone: row.phone ?? '',
    address: row.address ?? '',
    defaultCurrency: row.defaultCurrency as Currency,
    language: row.language as Language,
    receiptFooter: row.receiptFooter ?? '',
    receiptHeader: row.receiptHeader ?? '',
  };
}

export function saveShopInfo(rawInfo: unknown): void {
  const info = requireObject(rawInfo, 'Shop');
  const db = getDb();
  const drizzle = getDrizzle();
  const existing = db
    .prepare('SELECT id FROM shop_settings LIMIT 1')
    .get() as { id: number } | undefined;

  const clean: Record<string, unknown> = {};
  if (info.shopName !== undefined) {
    const n = requireNonEmptyString(info.shopName, 'Shop name');
    if (n.length > 200) throw new ValidationError('Shop name is too long');
    clean.shopName = n;
  }
  for (const [key, max] of [
    ['phone', 50],
    ['address', 300],
    ['receiptFooter', 300],
    ['receiptHeader', 300],
  ] as const) {
    if (info[key] !== undefined) clean[key] = optionalString(info[key], max, key)?.trim() ?? '';
  }
  if (info.defaultCurrency !== undefined) clean.defaultCurrency = requireCurrency(info.defaultCurrency);
  if (info.language !== undefined) clean.language = requireLanguage(info.language);

  db.transaction(() => {
    if (existing) {
      drizzle
        .update(shopSettings)
        .set({ ...clean, updatedAt: new Date() })
        .where(eq(shopSettings.id, existing.id))
        .run();
    } else {
      drizzle
        .insert(shopSettings)
        .values({
          shopName: (clean.shopName as string) ?? 'My Shop',
          phone: (clean.phone as string) ?? null,
          address: (clean.address as string) ?? null,
          defaultCurrency: (clean.defaultCurrency as Currency) ?? 'USD',
          language: (clean.language as Language) ?? 'en',
          receiptFooter: (clean.receiptFooter as string) ?? null,
          receiptHeader: (clean.receiptHeader as string) ?? null,
        })
        .run();
    }
    drizzle.insert(auditLog).values({
      action: 'SETTINGS_CHANGE',
      entityType: 'shop_settings',
      payload: JSON.stringify(clean),
    }).run();
  })();
}

/**
 * Complete first-run setup wizard.
 * Validates input, inserts shop_settings row, seeds default categories,
 * and records the initial exchange rate.
 */
export function completeFirstRun(rawInput: unknown): void {
  const input = requireObject(rawInput, 'Setup');
  const shopName = requireNonEmptyString(input.shopName, 'Shop Name');
  const currency = requireCurrency(input.defaultCurrency);
  const language = requireLanguage(input.language);

  if (
    typeof input.exchangeRate !== 'number' ||
    !Number.isSafeInteger(input.exchangeRate) ||
    input.exchangeRate <= 0 ||
    input.exchangeRate > MAX_RATE
  ) {
    throw new ValidationError(
      'Exchange rate must be a positive whole number (LBP per 1 USD)',
      'exchangeRate',
    );
  }

  const db = getDb();
  if (isShopInitialized()) {
    // Setup can only run once; it must never re-seed or overwrite a configured shop.
    throw new ValidationError('The shop is already set up');
  }
  const tx = db.transaction(() => {
    // Insert shop settings
    saveShopInfo({
      shopName,
      phone: optionalString(input.phone, 50, 'Phone') ?? '',
      address: optionalString(input.address, 300, 'Address') ?? '',
      defaultCurrency: currency,
      language,
    });

    // Seed default categories
    const drizzle = getDrizzle();
    for (const cat of DEFAULT_CATEGORIES) {
      drizzle.insert(categories).values({
        name: cat.name,
        nameAr: cat.nameAr,
        sortOrder: cat.sortOrder,
        active: true,
      }).run();
    }

    // Seed initial exchange rate
    recordExchangeRateChange(input.exchangeRate as number);

    // Record first-run completion in app_settings
    drizzle.insert(appSettings).values({
      key: 'first_run_completed_at',
      value: String(Math.floor(Date.now() / 1000)),
    }).run();

    drizzle.insert(auditLog).values({
      action: 'SETTINGS_CHANGE',
      entityType: 'shop_settings',
      payload: JSON.stringify({ event: 'first_run_complete', shopName }),
    }).run();
  });
  tx();
}

/**
 * Get a generic string setting from app_settings.
 */
export function getAppSetting(key: string): string | null {
  const db = getDb();
  const row = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setAppSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value);
}

export { isShopInitialized };
