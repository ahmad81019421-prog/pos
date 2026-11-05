/**
 * Local error log (PRD 57). Technical details go to <appData>/logs/app.log, never to the
 * UI. The file is rotated at ~1 MB so it cannot grow without bound. Logging must never
 * throw.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getAppDataDir } from '../database/connection';

const MAX_BYTES = 1_000_000;

export function logError(context: string, err: unknown): void {
  const detail =
    err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err);
  const line = `[${new Date().toISOString()}] ${context}\n${detail}\n\n`;
  try {
    const dir = path.join(getAppDataDir(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'app.log');
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
      fs.renameSync(file, path.join(dir, 'app.old.log'));
    }
    fs.appendFileSync(file, line);
  } catch {
    console.error(line);
  }
}
