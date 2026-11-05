/**
 * Electron main process entry point.
 *
 * Architecture (PRD section 4):
 *   React Renderer → Preload API → Secure IPC → Electron Main → Services → SQLite
 *
 * Hardening (PRD 53):
 *   - contextIsolation, sandbox, no node integration, webSecurity on
 *   - the window can only ever show the bundled page (navigation + window.open denied)
 *   - all permission requests (camera, notifications, ...) denied
 *   - IPC accepted only from this window and this page (see ipc/index.ts)
 *   - a second app instance is refused so two processes never share one database
 */

import { app, BrowserWindow, Menu, dialog, session, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  initDatabase,
  closeDatabase,
  isShopInitialized,
  getAppDataDir,
} from './services/database/connection';
import { runAutomaticBackupIfNeeded } from './services/database/backupService';
import { registerIpcHandlers } from './ipc';
import { logError } from './services/logging/logger';

let mainWindow: BrowserWindow | null = null;

const DEV_URL = 'http://localhost:5173';
const isDevServer = (): boolean => !app.isPackaged && process.env.NODE_ENV === 'development';

/** dist-electron/src/main/main.js -> ../../../dist/renderer/index.html */
function rendererIndexPath(): string {
  return path.join(__dirname, '..', '..', '..', 'dist', 'renderer', 'index.html');
}

function isTrustedUrl(url: string): boolean {
  if (!url) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (isDevServer()) return u.origin === new URL(DEV_URL).origin;
  const expected = new URL(pathToFileURL(rendererIndexPath()).href);
  // Exact page match (query/hash allowed for the SPA router), not a prefix match.
  return u.protocol === 'file:' && u.pathname === expected.pathname;
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (event.sender !== mainWindow.webContents) return false;
  return isTrustedUrl(event.senderFrame?.url ?? '');
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Local POS',
    backgroundColor: '#f5f5f7',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // The preload is bundled into a single file so it can run sandboxed.
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  win.once('ready-to-show', () => win.show());

  // The app has no external links: refuse every new window.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Never navigate away from the bundled page (hash routing does not trigger this).
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  win.webContents.on('render-process-gone', (_e, details) => {
    logError('render-process-gone', JSON.stringify(details));
  });

  if (isDevServer()) {
    win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(rendererIndexPath());
  }
  return win;
}

function failStartup(title: string, detail: unknown): never {
  logError(title, detail);
  dialog.showErrorBox(
    'Local POS',
    `${title}\n\nYour data has NOT been changed.\n` +
      `Backups are kept in:\n${path.join(getAppDataDirSafe(), 'backups')}\n\n` +
      'Please contact support and keep this folder.',
  );
  app.exit(1);
  throw new Error(title);
}

function getAppDataDirSafe(): string {
  try {
    return getAppDataDir();
  } catch {
    return app.getPath('userData');
  }
}

if (!app.requestSingleInstanceLock()) {
  // Another copy is already running (it owns the database).
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  process.on('uncaughtException', (err) => logError('uncaughtException', err));
  process.on('unhandledRejection', (err) => logError('unhandledRejection', err));

  app.whenReady().then(() => {
    // Deny every permission prompt (the POS needs none).
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    session.defaultSession.setPermissionCheckHandler(() => false);

    try {
      initDatabase();
    } catch (err) {
      failStartup(
        err instanceof Error && err.name === 'DatabaseCorruptError'
          ? 'The database file appears to be damaged.'
          : err instanceof Error && err.name === 'DatabaseTooNewError'
            ? 'This data was created by a newer version of Local POS. Please install the latest version.'
            : 'The database could not be opened.',
        err,
      );
    }

    registerIpcHandlers({ isTrustedSender });
    buildAppMenu();

    // Daily automatic backup: at startup and then hourly (covers shops that never close
    // the app). A failure is recorded and shown on the Backup page; it never blocks sales.
    const backupTick = (): void => {
      if (isShopInitialized()) runAutomaticBackupIfNeeded();
    };
    backupTick();
    setInterval(backupTick, 60 * 60 * 1000).unref();

    mainWindow = createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    closeDatabase();
    app.quit();
  });

  app.on('before-quit', () => {
    closeDatabase();
  });
}

function buildAppMenu(): void {
  if (app.isPackaged) {
    // The app has its own navigation; no native menu in production.
    Menu.setApplicationMenu(null);
    return;
  }
  const nav = (route: string) => () => mainWindow?.webContents.send('menu:navigate', route);
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'New Sale', accelerator: 'CmdOrCtrl+N', click: nav('pos') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] },
    {
      label: 'Navigate',
      submenu: ['pos', 'products', 'inventory', 'invoices', 'reports', 'expenses', 'settings', 'backup'].map(
        (r) => ({ label: r, click: nav(r) }),
      ),
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

