import { vi } from 'vitest';
import os from 'node:os';

// The main-process services import `electron`; tests run in plain Node against temp DBs.
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false, getVersion: () => 'test' },
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined },
  dialog: {},
  session: {},
  Menu: {},
}));
