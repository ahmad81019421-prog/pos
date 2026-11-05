/**
 * SQLite database connection management.
 *
 * - Uses better-sqlite3 (synchronous, fast, reliable for desktop apps).
 * - Stores the production DB in the OS application-data directory (PRD section 47).
 * - Enables foreign keys and WAL mode for crash safety.
 * - Provides migration runner for forward-only schema evolution (PRD section 56).
 */

import { getTableColumns, type Table } from 'drizzle-orm';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import * as schema from './schema';

let dbInstance: Database.Database | null = null;
let drizzleInstance: BetterSQLite3Database<typeof schema> | null = null;
// Absolute path of the database currently open (set by initDatabase). Lets the
// backup/restore code and the tests work against an isolated temporary database.
let currentDbPath: string | null = null;

/**
 * Returns the absolute path of the production SQLite database file.
 * On Windows this resolves to: %APPDATA%/LocalPOS/local-pos.db
 */
export function getDatabasePath(): string {
  if (currentDbPath) return currentDbPath;
  const userDataDir = app.getPath('userData');
  // userData is typically %APPDATA%/<productName> on Windows
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }
  return path.join(userDataDir, 'local-pos.db');
}

export function getBackupsDir(): string {
  const baseDir = currentDbPath && currentDbPath !== ':memory:'
    ? path.dirname(currentDbPath)
    : app.getPath('userData');
  const backupDir = path.join(baseDir, 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  return backupDir;
}

export function getAppDataDir(): string {
  return currentDbPath && currentDbPath !== ':memory:'
    ? path.dirname(currentDbPath)
    : app.getPath('userData');
}

export function getDb(): Database.Database {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return dbInstance;
}

export function getDrizzle(): BetterSQLite3Database<typeof schema> {
  if (!drizzleInstance) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return drizzleInstance;
}

export class DatabaseCorruptError extends Error {
  constructor(detail: string) {
    super(`Database integrity check failed: ${detail}`);
    this.name = 'DatabaseCorruptError';
  }
}

/** Run SQLite's integrity check. Returns null when healthy, else a description. */
export function checkIntegrity(db: Database.Database, full = false): string | null {
  const rows = db.pragma(full ? 'integrity_check' : 'quick_check') as Array<
    Record<string, string>
  >;
  const first = rows[0] ? Object.values(rows[0])[0] : 'no result';
  if (rows.length === 1 && first === 'ok') return null;
  return rows.map((r) => Object.values(r)[0]).slice(0, 5).join('; ');
}

function applyPragmas(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
}

export class DatabaseTooNewError extends Error {
  constructor(public found: number, public supported: number) {
    super(`Database schema v${found} is newer than this app supports (v${supported}).`);
    this.name = 'DatabaseTooNewError';
  }
}

export function initDatabase(dbPath?: string): void {
  if (dbInstance) {
    return;
  }
  const finalPath = dbPath ?? getDatabasePath();
  const instance = new Database(finalPath);
  try {
    applyPragmas(instance);
    const problem = checkIntegrity(instance);
    if (problem) throw new DatabaseCorruptError(problem);

    // A database written by a NEWER app version must never be opened (and silently
    // misread/downgraded) by this one.
    if (databaseHasData(instance)) {
      const v = (instance.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }).v ?? 0;
      const latest = MIGRATIONS[MIGRATIONS.length - 1].version;
      if (v > latest) throw new DatabaseTooNewError(v, latest);
    }

    // Before applying schema upgrades to an existing customer database, take a
    // recovery copy (PRD 56). A failed upgrade is rolled back by its transaction.
    const pending = pendingMigrationCount(instance);
    if (pending > 0 && finalPath !== ':memory:' && databaseHasData(instance)) {
      const dir = path.join(path.dirname(finalPath), 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target = path.join(dir, `pre-upgrade-${stamp}.db`);
      instance.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    }

    currentDbPath = finalPath;
    dbInstance = instance;
    drizzleInstance = drizzle(instance, { schema });
    runMigrations(instance);
  } catch (err) {
    dbInstance = null;
    drizzleInstance = null;
    currentDbPath = null;
    try {
      instance.close();
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function databaseHasData(db: Database.Database): boolean {
  const t = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();
  return Boolean(t);
}

function pendingMigrationCount(db: Database.Database): number {
  let current = 0;
  if (databaseHasData(db)) {
    const r = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
      v: number | null;
    };
    current = r?.v ?? 0;
  }
  return MIGRATIONS.filter((m) => m.version > current).length;
}

export function getSchemaVersion(db: Database.Database = getDb()): number {
  const r = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
    v: number | null;
  };
  return r?.v ?? 0;
}

export const LATEST_SCHEMA_VERSION = (): number =>
  MIGRATIONS[MIGRATIONS.length - 1].version;

export function closeDatabase(): void {
  if (dbInstance) {
    try {
      dbInstance.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* best effort */
    }
    dbInstance.close();
    dbInstance = null;
    drizzleInstance = null;
    // currentDbPath is kept so that a following initDatabase() reopens the same file.
  }
}

/** Reset local application data and recreate an empty, migrated database in place. */
export function deleteCurrentDatabase(): void {
  const databasePath = getDatabasePath();
  if (databasePath === ':memory:') {
    throw new Error('Deleting an in-memory database is not supported.');
  }

  closeDatabase();
  const files = [`${databasePath}-wal`, `${databasePath}-shm`, databasePath];
  try {
    for (const file of files) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    const backupsDir = path.join(path.dirname(databasePath), 'backups');
    if (fs.existsSync(backupsDir)) {
      fs.rmSync(backupsDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (fs.existsSync(databasePath)) initDatabase(databasePath);
    throw error;
  }
  initDatabase(databasePath);
}

/** Path to reopen after closeDatabase() (restore flow). */
export function getLastDatabasePath(): string {
  return getDatabasePath();
}

/**
 * Forward-only migrations. Each migration is a tuple of [version, sql, description].
 * The `schema_version` table tracks which migrations have been applied.
 *
 * For V1, we apply all migrations on first run.
 * Future versions will add new migrations that ALTER existing tables safely
 * (never destructive).
 */
interface Migration {
  version: number;
  description: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial schema',
    sql: `
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS shop_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_name TEXT NOT NULL,
        phone TEXT,
        address TEXT,
        default_currency TEXT NOT NULL DEFAULT 'USD',
        language TEXT NOT NULL DEFAULT 'en',
        receipt_footer TEXT,
        receipt_header TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS exchange_rate_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rate INTEGER NOT NULL,
        effective_from INTEGER NOT NULL DEFAULT (unixepoch()),
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS erh_effective_from_idx ON exchange_rate_history(effective_from);

      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        name_ar TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE UNIQUE INDEX IF NOT EXISTS category_name_idx ON categories(name);

      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        name_ar TEXT,
        category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
        selling_unit TEXT NOT NULL,
        current_price INTEGER NOT NULL,
        price_currency TEXT NOT NULL DEFAULT 'USD',
        current_cost INTEGER,
        low_stock_threshold INTEGER,
        image_data_url TEXT,
        notes TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS product_category_idx ON products(category_id);
      CREATE INDEX IF NOT EXISTS product_active_idx ON products(active);

      CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL UNIQUE REFERENCES products(id) ON DELETE RESTRICT,
        quantity_minor INTEGER NOT NULL DEFAULT 0,
        average_cost INTEGER,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE UNIQUE INDEX IF NOT EXISTS inventory_product_idx ON inventory(product_id);

      CREATE TABLE IF NOT EXISTS inventory_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        movement_type TEXT NOT NULL,
        delta_minor INTEGER NOT NULL,
        resulting_quantity_minor INTEGER NOT NULL,
        unit_cost INTEGER,
        currency TEXT,
        sale_id INTEGER,
        return_id INTEGER,
        reason TEXT,
        notes TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS inv_movement_product_idx ON inventory_movements(product_id);
      CREATE INDEX IF NOT EXISTS inv_movement_type_idx ON inventory_movements(movement_type);
      CREATE INDEX IF NOT EXISTS inv_movement_sale_idx ON inventory_movements(sale_id);
      CREATE INDEX IF NOT EXISTS inv_movement_created_idx ON inventory_movements(created_at);

      CREATE TABLE IF NOT EXISTS sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_number TEXT NOT NULL UNIQUE,
        customer_id INTEGER,
        status TEXT NOT NULL DEFAULT 'COMPLETED',
        total_usd_cents INTEGER NOT NULL DEFAULT 0,
        total_lbp INTEGER NOT NULL DEFAULT 0,
        cost_usd_cents INTEGER NOT NULL DEFAULT 0,
        exchange_rate_snapshot INTEGER NOT NULL,
        total_usd_equivalent_cents INTEGER NOT NULL DEFAULT 0,
        suspended_label TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        completed_at INTEGER,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS sale_status_idx ON sales(status);
      CREATE INDEX IF NOT EXISTS sale_created_idx ON sales(created_at);
      CREATE INDEX IF NOT EXISTS sale_customer_idx ON sales(customer_id);

      CREATE TABLE IF NOT EXISTS sale_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        product_name_snapshot TEXT NOT NULL,
        product_name_ar_snapshot TEXT,
        category_id_snapshot INTEGER NOT NULL,
        selling_unit_snapshot TEXT NOT NULL,
        quantity_minor INTEGER NOT NULL,
        unit_price_minor INTEGER NOT NULL,
        price_currency_snapshot TEXT NOT NULL,
        direct_final_price INTEGER NOT NULL DEFAULT 0,
        line_total_minor INTEGER NOT NULL,
        unit_cost_snapshot INTEGER,
        line_cost_minor INTEGER,
        exchange_rate_snapshot INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS sale_item_sale_idx ON sale_items(sale_id);
      CREATE INDEX IF NOT EXISTS sale_item_product_idx ON sale_items(product_id);

      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
        payment_type TEXT NOT NULL,
        paid_usd_cents INTEGER NOT NULL DEFAULT 0,
        paid_lbp INTEGER NOT NULL DEFAULT 0,
        change_usd_cents INTEGER NOT NULL DEFAULT 0,
        change_lbp INTEGER NOT NULL DEFAULT 0,
        exchange_rate_snapshot INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS payment_sale_idx ON payments(sale_id);

      CREATE TABLE IF NOT EXISTS returns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_number TEXT NOT NULL UNIQUE,
        original_sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
        return_type TEXT NOT NULL,
        refund_usd_cents INTEGER NOT NULL DEFAULT 0,
        refund_lbp INTEGER NOT NULL DEFAULT 0,
        exchange_rate_snapshot INTEGER NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS return_original_sale_idx ON returns(original_sale_id);

      CREATE TABLE IF NOT EXISTS return_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_id INTEGER NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
        sale_item_id INTEGER NOT NULL REFERENCES sale_items(id) ON DELETE RESTRICT,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        quantity_returned_minor INTEGER NOT NULL,
        refund_line_minor INTEGER NOT NULL,
        refund_currency TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS return_item_return_idx ON return_items(return_id);
      CREATE INDEX IF NOT EXISTS return_item_product_idx ON return_items(product_id);

      CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date INTEGER NOT NULL DEFAULT (unixepoch()),
        description TEXT NOT NULL,
        amount_minor INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        category TEXT NOT NULL DEFAULT 'OTHER',
        amount_usd_equivalent_cents INTEGER NOT NULL,
        exchange_rate_snapshot INTEGER NOT NULL,
        notes TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS expense_date_idx ON expenses(date);
      CREATE INDEX IF NOT EXISTS expense_category_idx ON expenses(category);

      CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT,
        balance_usd_cents INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS customer_name_idx ON customers(name);
      CREATE INDEX IF NOT EXISTS customer_phone_idx ON customers(phone);

      CREATE TABLE IF NOT EXISTS customer_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
        transaction_type TEXT NOT NULL,
        amount_usd_cents INTEGER NOT NULL,
        sale_id INTEGER,
        exchange_rate_snapshot INTEGER NOT NULL,
        notes TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS cust_txn_customer_idx ON customer_transactions(customer_id);
      CREATE INDEX IF NOT EXISTS cust_txn_sale_idx ON customer_transactions(sale_id);

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        entity_id INTEGER,
        entity_type TEXT,
        payload TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS audit_action_idx ON audit_log(action);
      CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log(created_at);

      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL DEFAULT (unixepoch()),
        description TEXT
      );
    `,
  },
  {
    version: 2,
    description: 'Idempotent sales, credit sales, return cost/revenue snapshots, waste cost snapshot',
    sql: `
      ALTER TABLE sales ADD COLUMN client_request_id TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS sale_client_request_idx
        ON sales(client_request_id) WHERE client_request_id IS NOT NULL;
      ALTER TABLE sales ADD COLUMN credit_usd_cents INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE returns ADD COLUMN refund_usd_equivalent_cents INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE returns ADD COLUMN cost_usd_cents INTEGER NOT NULL DEFAULT 0;
      UPDATE returns SET refund_usd_equivalent_cents =
        refund_usd_cents + (refund_lbp * 100 + exchange_rate_snapshot / 2) / exchange_rate_snapshot;

      ALTER TABLE inventory_movements ADD COLUMN cost_usd_cents INTEGER;
      -- Best-effort backfill of waste cost (USD-equivalent) for rows created before this
      -- version, using the product's cost at upgrade time.
      UPDATE inventory_movements SET cost_usd_cents = (
        SELECT CASE
          WHEN p.current_cost IS NULL THEN 0
          ELSE (
            CASE WHEN p.price_currency = 'USD'
              THEN (CASE WHEN p.selling_unit = 'WEIGHT'
                    THEN (ABS(inventory_movements.delta_minor) * p.current_cost + 500) / 1000
                    ELSE ABS(inventory_movements.delta_minor) * p.current_cost END)
              ELSE (
                (CASE WHEN p.selling_unit = 'WEIGHT'
                    THEN (ABS(inventory_movements.delta_minor) * p.current_cost + 500) / 1000
                    ELSE ABS(inventory_movements.delta_minor) * p.current_cost END) * 100
                + COALESCE((SELECT rate FROM exchange_rate_history ORDER BY effective_from DESC, id DESC LIMIT 1), 89500) / 2
              ) / COALESCE((SELECT rate FROM exchange_rate_history ORDER BY effective_from DESC, id DESC LIMIT 1), 89500)
            END)
          END
        FROM products p WHERE p.id = inventory_movements.product_id
      ) WHERE movement_type = 'WASTE';
    `,
  },
  {
    version: 3,
    description: 'Index return items by sale item for cumulative return validation',
    sql: `
      CREATE INDEX IF NOT EXISTS return_item_sale_item_idx ON return_items(sale_item_id);
    `,
  },
  {
    version: 4,
    description: 'Record customer payment cash amounts and debt settlement rounding differences',
    sql: `
      ALTER TABLE customer_transactions ADD COLUMN cash_amount_minor INTEGER;
      ALTER TABLE customer_transactions ADD COLUMN cash_currency TEXT;
      ALTER TABLE customer_transactions ADD COLUMN rounding_difference_lbp INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 5,
    description: 'Record the payment source of new expenses without classifying legacy expenses',
    sql: `
      ALTER TABLE expenses ADD COLUMN payment_source TEXT;
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  // Ensure schema_version table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch()),
      description TEXT
    );
  `);

  const currentVersionRow = db
    .prepare('SELECT MAX(version) AS v FROM schema_version')
    .get() as { v: number | null } | undefined;
  const currentVersion = currentVersionRow?.v ?? 0;

  const pending = MIGRATIONS.filter((m) => m.version > currentVersion);
  if (pending.length === 0) return;

  for (const migration of pending) {
    const tx = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO schema_version (version, description) VALUES (?, ?)',
      ).run(migration.version, migration.description);
    });
    tx();
  }
}

/**
 * Check whether the database is initialized (i.e. shop_settings has at least one row).
 */
export function isShopInitialized(): boolean {
  const db = getDb();
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM shop_settings')
    .get() as { c: number };
  return row.c > 0;
}

/**
 * Generate the next invoice number for a given date.
 * Format: YYYY-NNNNN where NNNNN is a zero-padded sequence within the year.
 */
export function generateInvoiceNumber(db: Database.Database): string {
  const year = new Date().getFullYear();
  const prefix = `${year}-`;
  // Numeric MAX (not lexicographic) so the sequence stays correct beyond 99,999.
  const row = db
    .prepare(
      `SELECT MAX(CAST(SUBSTR(invoice_number, ?) AS INTEGER)) AS seq FROM sales
       WHERE invoice_number LIKE ?`,
    )
    .get(prefix.length + 1, prefix + '%') as { seq: number | null } | undefined;
  const next = (row?.seq ?? 0) + 1;
  return `${year}-${String(next).padStart(5, '0')}`;
}

export function generateReturnNumber(db: Database.Database): string {
  const year = new Date().getFullYear();
  const prefix = `R-${year}-`;
  const row = db
    .prepare(
      `SELECT MAX(CAST(SUBSTR(return_number, ?) AS INTEGER)) AS seq FROM returns
       WHERE return_number LIKE ?`,
    )
    .get(prefix.length + 1, prefix + '%') as { seq: number | null } | undefined;
  const next = (row?.seq ?? 0) + 1;
  return `${prefix}${String(next).padStart(5, '0')}`;
}

/**
 * Map a raw better-sqlite3 row (snake_case column names, integer timestamps) to the Drizzle
 * row shape (camelCase fields, Date/boolean conversions) for the given table. Raw `SELECT *`
 * rows must never be cast to `$inferSelect` directly: the field names differ.
 */
export function rowOf<T extends Table>(table: T, raw: unknown): T['$inferSelect'] | undefined {
  if (!raw) return undefined;
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, col] of Object.entries(getTableColumns(table))) {
    const v = r[col.name];
    out[key] = v === null || v === undefined ? v : (col as any).mapFromDriverValue ? (col as any).mapFromDriverValue(v) : v;
  }
  return out as T['$inferSelect'];
}
export function rowsOf<T extends Table>(table: T, raws: unknown[]): Array<T['$inferSelect']> {
  return raws.map((r) => rowOf(table, r)!);
}
