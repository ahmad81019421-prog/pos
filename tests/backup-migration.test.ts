import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { freshDb, cleanup, makeProduct } from './helpers';
import {
  getDb, MIGRATIONS, runMigrations, getSchemaVersion, LATEST_SCHEMA_VERSION, initDatabase, closeDatabase,
  deleteCurrentDatabase, isShopInitialized,
} from '../src/main/services/database/connection';
import {
  createBackup, restoreBackup, listBackups, resolveBackupName, validateBackupFile, backupToPath,
} from '../src/main/services/database/backupService';
import { listProducts } from '../src/main/services/database/productsService';

afterAll(cleanup);
const names = () => listProducts().map((p) => p.name).sort();

describe('Backup / restore (isolated temp DB)', () => {
  it('resets the active database and removes local backups for a fresh-install state', () => {
    const { dbPath } = freshDb();
    makeProduct({ name: 'Delete me', price: 100 });
    const backup = createBackup();

    deleteCurrentDatabase();

    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.existsSync(backup.filePath)).toBe(false);
    expect(isShopInitialized()).toBe(false);
    expect(getSchemaVersion()).toBe(LATEST_SCHEMA_VERSION());
    expect((getDb().prepare('SELECT COUNT(*) c FROM products').get() as { c: number }).c).toBe(0);
    expect((getDb().prepare('SELECT COUNT(*) c FROM sales').get() as { c: number }).c).toBe(0);
  });

  it('restores the exact state of the backup and keeps working afterwards', () => {
    freshDb();
    makeProduct({ name: 'Before', price: 100 });
    const b = createBackup();
    makeProduct({ name: 'After', price: 100 });
    expect(names()).toEqual(['After', 'Before']);

    const { safetyBackupPath } = restoreBackup(b.filePath);
    expect(names()).toEqual(['Before']);
    expect(fs.existsSync(safetyBackupPath)).toBe(true);
    // the safety backup holds the pre-restore state
    const safety = new Database(safetyBackupPath, { readonly: true });
    expect((safety.prepare('SELECT COUNT(*) c FROM products').get() as { c: number }).c).toBe(2);
    safety.close();
    // DB is writable and a new backup works after restore
    makeProduct({ name: 'Later', price: 100 });
    expect(() => createBackup()).not.toThrow();
    expect(getDb().pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('rejects a corrupt file, a non-database file and leaves the live DB untouched', () => {
    const { dir } = freshDb();
    makeProduct({ name: 'Keep', price: 100 });
    const junk = path.join(dir, 'junk.db');
    fs.writeFileSync(junk, 'this is not sqlite at all'.repeat(100));
    expect(() => restoreBackup(junk)).toThrow();
    const b = createBackup();
    const corrupt = path.join(dir, 'corrupt.db');
    const buf = fs.readFileSync(b.filePath);
    buf.fill(0xff, 100, Math.min(buf.length, 40000)); // wipes the schema page and the first data pages
    fs.writeFileSync(corrupt, buf);
    expect(() => restoreBackup(corrupt)).toThrow();
    expect(() => restoreBackup(path.join(dir, 'missing.db'))).toThrow();
    expect(names()).toEqual(['Keep']);
  });

  it('rejects a backup made by a NEWER schema version', () => {
    const { dir } = freshDb();
    const b = createBackup();
    const future = path.join(dir, 'future.db');
    fs.copyFileSync(b.filePath, future);
    const d = new Database(future);
    d.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)').run(LATEST_SCHEMA_VERSION() + 5, 'future');
    d.close();
    expect(() => validateBackupFile(future)).toThrow(/newer/i);
  });

  it('only accepts listed backup names (no path traversal)', () => {
    freshDb();
    const b = createBackup();
    expect(resolveBackupName(b.fileName)).toBe(b.filePath);
    for (const bad of ['../x.db', '..\\x.db', '/etc/passwd', 'a/b.db', 'x.txt', '', null, 5]) {
      expect(() => resolveBackupName(bad)).toThrow();
    }
    expect(listBackups().some((x) => x.fileName === b.fileName)).toBe(true);
  });

  it('fails cleanly (no partial file) when the destination is unwritable', () => {
    const { dir } = freshDb();
    const target = path.join(dir, 'does-not-exist', 'sub', 'x.db');
    expect(() => backupToPath(target)).toThrow();
    expect(fs.existsSync(target)).toBe(false);
  });

  it('a second backup on the same day does not overwrite the first', () => {
    freshDb();
    const a = createBackup();
    const b = createBackup();
    expect(a.filePath).not.toBe(b.filePath);
    expect(fs.existsSync(a.filePath)).toBe(true);
  });
});

describe('Migrations', () => {
  it('upgrades a v1 database with data to the latest schema, preserving the data and taking a pre-upgrade backup', () => {
    const { dir, dbPath } = freshDb({ setup: false });
    closeDatabase();
    fs.rmSync(dbPath);
    for (const ext of ['-wal', '-shm']) fs.rmSync(dbPath + ext, { force: true });

    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()), description TEXT);`);
    raw.exec('BEGIN');
    raw.exec(MIGRATIONS[0].sql);
    raw.prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)').run(1, 'v1');
    raw.exec('COMMIT');
    raw.prepare(`INSERT INTO categories (name, sort_order) VALUES ('Old', 1)`).run();
    raw.prepare(
      `INSERT INTO products (name, category_id, selling_unit, current_price, price_currency) VALUES ('Legacy', 1, 'PIECE', 500, 'USD')`,
    ).run();
    raw.prepare(`INSERT INTO customers (name, balance_usd_cents) VALUES ('Legacy customer', 200)`).run();
    raw.prepare(
      `INSERT INTO customer_transactions
       (customer_id, transaction_type, amount_usd_cents, exchange_rate_snapshot, notes)
       VALUES (1, 'CREDIT', 200, 89500, 'legacy transaction')`,
    ).run();
    raw.close();

    initDatabase(dbPath);
    expect(getSchemaVersion()).toBe(LATEST_SCHEMA_VERSION());
    expect(names()).toEqual(['Legacy']);
    const cols = (getDb().prepare('PRAGMA table_info(sales)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('client_request_id');
    expect(cols).toContain('credit_usd_cents');
    const customerTxnCols = (getDb().prepare('PRAGMA table_info(customer_transactions)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(customerTxnCols).toContain('cash_amount_minor');
    expect(customerTxnCols).toContain('cash_currency');
    expect(customerTxnCols).toContain('rounding_difference_lbp');
    const expenseCols = (getDb().prepare('PRAGMA table_info(expenses)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(expenseCols).toContain('payment_source');
    const legacyTxn = getDb().prepare('SELECT * FROM customer_transactions WHERE id = 1').get() as {
      amount_usd_cents: number;
      cash_amount_minor: number | null;
      cash_currency: string | null;
      rounding_difference_lbp: number;
    };
    expect(legacyTxn.amount_usd_cents).toBe(200);
    expect(legacyTxn.cash_amount_minor).toBeNull();
    expect(legacyTxn.cash_currency).toBeNull();
    expect(legacyTxn.rounding_difference_lbp).toBe(0);
    const pre = fs.readdirSync(path.join(dir, 'backups'));
    expect(pre.some((f) => f.includes('pre-upgrade'))).toBe(true);
  });

  it('is idempotent: re-running changes nothing', () => {
    freshDb();
    const v = getSchemaVersion();
    runMigrations(getDb());
    expect(getSchemaVersion()).toBe(v);
  });

  it('refuses to open a database from a newer app version', () => {
    const { dbPath } = freshDb({ setup: false });
    getDb().prepare('INSERT INTO schema_version (version, description) VALUES (?, ?)').run(LATEST_SCHEMA_VERSION() + 3, 'future');
    closeDatabase();
    expect(() => initDatabase(dbPath)).toThrow();
  });
});
