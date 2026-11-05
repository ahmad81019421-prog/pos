/**
 * Backup & restore service.
 *
 * PRD sections 45, 46, 47.
 *
 * Backups
 *   - Created with SQLite `VACUUM INTO`, which produces a consistent snapshot even while the
 *     database is open in WAL mode (a plain file copy would miss data still in the -wal file).
 *   - Written to a temporary name, integrity-checked, then renamed: a half-written file can
 *     never be mistaken for a good backup, and an existing backup is never overwritten.
 *   - Daily automatic backup into <appData>/backups, plus manual backup to any folder (USB).
 *   - Retention only deletes old DAILY/MANUAL backups; recovery points are pruned separately
 *     and always keep the most recent ones.
 *
 * Restore (never destroys data without a recovery point)
 *   1. Validate the candidate file (is a SQLite DB, integrity_check ok, expected tables,
 *      not from a newer app version).
 *   2. Make a safety backup of the live database.
 *   3. Close the live connection, set the live file aside, put the candidate in its place
 *      (with stale -wal/-shm removed), reopen (migrations run), run a full integrity check.
 *   4. On ANY failure: put the original file back, reopen it, and report a clear error.
 */

import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import {
  getDb,
  getDatabasePath,
  getBackupsDir,
  closeDatabase,
  initDatabase,
  checkIntegrity,
  LATEST_SCHEMA_VERSION,
} from './connection';
import { setAppSetting, getAppSetting } from './settingsService';
import { getDrizzle } from './connection';
import { auditLog } from './schema';
import { BACKUP_RETENTION_DEFAULT } from '@shared/constants/index';
import type { BackupInfo, BackupStatus } from '@shared/types/index';

export interface BackupResult {
  fileName: string;
  filePath: string;
  sizeBytes: number;
}

export class BackupError extends Error {
  constructor(message: string, public technical?: string) {
    super(message);
    this.name = 'BackupError';
  }
}

const AUTO_NAME = /^backup-\d{4}-\d{2}-\d{2}(-\d+)?\.db$/;
const SAFE_RESTORE_KEEP = 10;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function dayStamp(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeStamp(d: Date = new Date()): string {
  return `${dayStamp(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Turn a low-level filesystem error into a message a shop owner can act on. */
export function friendlyFsMessage(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOSPC':
      return 'There is not enough free space on the destination drive.';
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return 'The destination folder is not writable. Choose another folder or drive.';
    case 'ENOENT':
      return 'The destination folder or drive was not found. Check that the USB drive is connected.';
    case 'EBUSY':
      return 'The file is in use by another program. Close it and try again.';
    default:
      return 'The backup could not be written. Choose another folder and try again.';
  }
}

function uniqueFile(dir: string, base: string): string {
  let candidate = path.join(dir, `${base}.db`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${n}.db`);
    n++;
  }
  return candidate;
}

/** Snapshot the open database into `target` (must not exist) and verify it. */
function snapshotTo(target: string): void {
  const tmp = `${target}.tmp`;
  try {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    getDb().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const check = new Database(tmp, { readonly: true, fileMustExist: true });
    try {
      const problem = checkIntegrity(check, true);
      if (problem) throw new BackupError('The backup file failed its integrity check.', problem);
    } finally {
      check.close();
    }
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    if (err instanceof BackupError) throw err;
    throw new BackupError(friendlyFsMessage(err), String((err as Error)?.message ?? err));
  }
}

/** Create a backup in `targetDir` (default: the application backups folder). */
export function createBackup(targetDir?: string): BackupResult {
  const dir = targetDir ?? getBackupsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new BackupError(friendlyFsMessage(err), String((err as Error)?.message ?? err));
  }
  const filePath = uniqueFile(dir, `backup-${dayStamp()}`);
  snapshotTo(filePath);
  return {
    fileName: path.basename(filePath),
    filePath,
    sizeBytes: fs.statSync(filePath).size,
  };
}

function kindOf(name: string): BackupInfo['kind'] {
  if (name.startsWith('pre-restore-')) return 'pre-restore';
  if (name.startsWith('pre-upgrade-')) return 'pre-upgrade';
  return 'backup';
}

export function listBackups(): BackupInfo[] {
  const dir = getBackupsDir();
  if (!fs.existsSync(dir)) return [];
  const infos: BackupInfo[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.db')) continue;
    const fp = path.join(dir, f);
    try {
      const stat = fs.statSync(fp);
      infos.push({
        fileName: f,
        filePath: fp,
        sizeBytes: stat.size,
        createdAt: Math.floor(stat.mtimeMs / 1000),
        kind: kindOf(f),
      });
    } catch {
      /* skip unreadable */
    }
  }
  return infos.sort((a, b) => b.createdAt - a.createdAt || b.fileName.localeCompare(a.fileName));
}

/**
 * Resolve a backup listed in the app backups folder by NAME. The renderer can never make
 * the main process read or overwrite an arbitrary path through this route.
 */
export function resolveBackupName(fileName: unknown): string {
  if (
    typeof fileName !== 'string' ||
    fileName !== path.basename(fileName) ||
    !/^[\w][\w.\- ]*\.db$/.test(fileName)
  ) {
    throw new BackupError('Invalid backup file.');
  }
  const full = path.join(getBackupsDir(), fileName);
  if (!fs.existsSync(full)) throw new BackupError('The backup file was not found.');
  return full;
}

/** Throws a BackupError (friendly message) when the file is not a restorable backup. */
export function validateBackupFile(filePath: string): { schemaVersion: number } {
  let candidate: Database.Database;
  try {
    candidate = new Database(filePath, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw new BackupError(
      'This file is not a valid backup (it could not be opened as a database).',
      String((err as Error)?.message ?? err),
    );
  }
  try {
    let problem: string | null;
    try {
      problem = checkIntegrity(candidate, true);
    } catch (err) {
      throw new BackupError(
        'This file is not a valid backup (it is not a database or it is damaged).',
        String((err as Error)?.message ?? err),
      );
    }
    if (problem) {
      throw new BackupError('This backup is damaged and cannot be restored.', problem);
    }
    const tables = new Set(
      (
        candidate
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>
      ).map((t) => t.name),
    );
    for (const required of ['schema_version', 'shop_settings', 'products', 'sales', 'sale_items']) {
      if (!tables.has(required)) {
        throw new BackupError('This file is not a Local POS backup.', `missing table ${required}`);
      }
    }
    const v = (
      candidate.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
        v: number | null;
      }
    ).v;
    if (!v) throw new BackupError('This file is not a Local POS backup.', 'no schema version');
    if (v > LATEST_SCHEMA_VERSION()) {
      throw new BackupError(
        'This backup was made by a newer version of Local POS. Install the newer version first.',
      );
    }
    return { schemaVersion: v };
  } finally {
    candidate.close();
  }
}

function removeSidecars(dbPath: string): void {
  for (const ext of ['-wal', '-shm']) {
    try {
      fs.unlinkSync(dbPath + ext);
    } catch {
      /* not present */
    }
  }
}

/**
 * Restore `backupFilePath` over the live database using the safe sequence described in
 * the file header. Returns the location of the safety backup of the previous data.
 */
export function restoreBackup(backupFilePath: string): { safetyBackupPath: string } {
  if (!fs.existsSync(backupFilePath)) {
    throw new BackupError('The backup file was not found.');
  }
  const liveDbPath = getDatabasePath();
  if (path.resolve(backupFilePath) === path.resolve(liveDbPath)) {
    throw new BackupError('The live database cannot be restored onto itself.');
  }

  // 1. Validate BEFORE touching anything.
  validateBackupFile(backupFilePath);

  // 2. Recovery point of the current data (consistent snapshot, includes WAL content).
  const backupsDir = getBackupsDir();
  fs.mkdirSync(backupsDir, { recursive: true });
  const safetyPath = uniqueFile(backupsDir, `pre-restore-${timeStamp()}`);
  snapshotTo(safetyPath);
  try {
    getDrizzle()
      .insert(auditLog)
      .values({
        action: 'RESTORE',
        entityType: 'backup',
        payload: JSON.stringify({ from: path.basename(backupFilePath), safety: path.basename(safetyPath) }),
      })
      .run();
  } catch {
    /* audit is best effort; the restore replaces this DB anyway */
  }

  const stagedPath = `${liveDbPath}.restore-tmp`;
  const asidePath = `${liveDbPath}.before-restore`;
  let swapped = false;
  try {
    // Stage the candidate next to the live file first (same volume => atomic rename).
    fs.copyFileSync(backupFilePath, stagedPath);

    // 3. Close, set the original aside, move the candidate into place.
    closeDatabase();
    removeSidecars(liveDbPath);
    if (fs.existsSync(asidePath)) fs.unlinkSync(asidePath);
    fs.renameSync(liveDbPath, asidePath);
    swapped = true;
    fs.renameSync(stagedPath, liveDbPath);
    removeSidecars(liveDbPath);

    initDatabase(liveDbPath);
    const problem = checkIntegrity(getDb(), true);
    if (problem) throw new BackupError('The restored database failed its integrity check.', problem);

    // Success: the aside copy is no longer needed (the safety backup remains).
    try {
      fs.unlinkSync(asidePath);
    } catch {
      /* ignore */
    }
    pruneSafetyBackups();
    return { safetyBackupPath: safetyPath };
  } catch (err) {
    // 4. Roll back to the original database.
    try {
      closeDatabase();
    } catch {
      /* ignore */
    }
    try {
      if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath);
      if (swapped && fs.existsSync(asidePath)) {
        removeSidecars(liveDbPath);
        if (fs.existsSync(liveDbPath)) fs.unlinkSync(liveDbPath);
        fs.renameSync(asidePath, liveDbPath);
      }
    } catch {
      /* the safety backup still holds the original data */
    }
    try {
      initDatabase(liveDbPath);
    } catch {
      /* reported below */
    }
    if (err instanceof BackupError) throw err;
    throw new BackupError(
      'The restore failed. Your previous data was kept.',
      String((err as Error)?.message ?? err),
    );
  }
}

/** Backup to a user-chosen folder (e.g. a USB drive). */
export function backupToPath(targetPath: string): BackupResult {
  if (typeof targetPath !== 'string' || !fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
    throw new BackupError('The destination folder was not found. Check that the USB drive is connected.');
  }
  return createBackup(targetPath);
}

function todayStr(): string {
  return dayStamp();
}

/**
 * Run the automatic daily backup if none was made today. Never throws: a failure is
 * recorded (and shown on the Backup page) so normal POS operation is unaffected.
 */
export function runAutomaticBackupIfNeeded(): BackupResult | null {
  try {
    if (getAppSetting('last_auto_backup_date') === todayStr()) return null;
    const result = createBackup();
    setAppSetting('last_auto_backup_date', todayStr());
    setAppSetting('last_backup_error', '');
    pruneOldBackups();
    return result;
  } catch (err) {
    const msg = err instanceof BackupError ? err.message : friendlyFsMessage(err);
    try {
      setAppSetting('last_backup_error', `${new Date().toISOString()} ${msg}`);
    } catch {
      /* ignore */
    }
    console.error('Automatic backup failed:', err);
    return null;
  }
}

export function getBackupStatus(): BackupStatus {
  const list = listBackups();
  const err = getAppSetting('last_backup_error');
  return {
    lastAutoBackupDate: getAppSetting('last_auto_backup_date'),
    lastError: err ? err : null,
    latestBackupAt: list.find((b) => b.kind === 'backup')?.createdAt ?? null,
    retention: getBackupRetention(),
  };
}

/** Keep the newest N daily/manual backups; never touch recovery points here. */
export function pruneOldBackups(): void {
  const retention = getBackupRetention();
  const backups = listBackups().filter((b) => AUTO_NAME.test(b.fileName));
  for (const b of backups.slice(retention)) {
    try {
      fs.unlinkSync(b.filePath);
    } catch {
      /* ignore */
    }
  }
}

function pruneSafetyBackups(): void {
  for (const kind of ['pre-restore', 'pre-upgrade'] as const) {
    const list = listBackups().filter((b) => b.kind === kind);
    for (const b of list.slice(SAFE_RESTORE_KEEP)) {
      try {
        fs.unlinkSync(b.filePath);
      } catch {
        /* ignore */
      }
    }
  }
}

export function setBackupRetention(count: number): void {
  if (!Number.isInteger(count) || count < 1 || count > 365) {
    throw new BackupError('Retention must be between 1 and 365.');
  }
  setAppSetting('backup_retention_count', String(count));
}

export function getBackupRetention(): number {
  const v = getAppSetting('backup_retention_count');
  if (!v) return BACKUP_RETENTION_DEFAULT;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : BACKUP_RETENTION_DEFAULT;
}
