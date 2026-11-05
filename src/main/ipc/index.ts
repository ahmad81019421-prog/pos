/**
 * IPC handler registration (PRD 4, 53, 57).
 *
 * Security model
 *   - Every handler first checks that the call comes from OUR main window showing OUR
 *     bundled page (`isTrustedSender`). Any other frame/window is refused.
 *   - Handlers only forward to services; every service re-validates its input, because the
 *     renderer is never trusted. Ids and limits are validated here as well.
 *   - Backup/restore paths never come from the renderer as free text: restore takes the NAME
 *     of a listed backup, or a file chosen in a native dialog opened by the main process.
 *   - Errors returned to the renderer are short human messages. Technical details (stack,
 *     SQLite codes) go to the local log file only.
 */

import { saveDraftCart, getDraftCart, clearDraftCart } from '../services/database/draftService';
import { ipcMain, dialog, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@shared/constants/index';
import {
  isShopInitialized,
  getShopInfo,
  saveShopInfo,
  completeFirstRun,
} from '../services/database/settingsService';
import { getCurrentRate, recordExchangeRateChange } from '../services/database/exchangeRate';
import {
  listCategories,
  createCategory,
  updateCategory,
  toggleCategoryActive,
  listProducts,
  listActiveProducts,
  getProduct,
  createProduct,
  updateProduct,
  toggleProductActive,
} from '../services/database/productsService';
import {
  getInventory,
  listInventory,
  listLowStock,
  addStock,
  recordWaste,
  adjustStock,
  listMovements,
} from '../services/database/inventoryService';
import {
  completeSale,
  suspendSale,
  getSuspendedSale,
  cancelSuspendedSale,
  getSale,
  listSales,
} from '../services/database/salesService';
import { createReturn, getReturn, listReturns } from '../services/database/returnsService';
import { createExpense, listExpenses, deleteExpense } from '../services/database/expensesService';
import {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  recordCustomerPayment,
  listCustomerTransactions,
} from '../services/database/customersService';
import {
  getSalesReport,
  getBestSellingProducts,
  getSalesByCategory,
  getDashboard,
  getCurrentCustomerDebt,
  getCashBalance,
  setCashOpeningBalance,
  zeroCashBalance,
  getInventoryMovementsReport,
} from '../services/database/reportsService';
import {
  listBackups,
  createBackup,
  restoreBackup,
  backupToPath,
  resolveBackupName,
  getBackupStatus,
  BackupError,
} from '../services/database/backupService';
import {
  printReceipt,
  listAvailablePrinters,
  testPrint,
  getPrinterSettings,
  savePrinterSettings,
} from '../services/printing/printingService';
import { deleteCurrentDatabase, getDrizzle } from '../services/database/connection';
import { auditLog } from '../services/database/schema';
import { desc } from 'drizzle-orm';
import { logError } from '../services/logging/logger';
import { ValidationError, optionalLimit, requireId } from '@shared/validation/index';
import type { AppError } from '@shared/types/index';

export interface IpcOptions {
  /** True only for calls made by the application's own main window and bundled page. */
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean;
}

const GENERIC = 'Something went wrong. Your data was not changed. Please try again.';

export function toAppError(err: unknown): AppError {
  if (err instanceof ValidationError) {
    return { code: 'VALIDATION', userMessage: err.message };
  }
  if (err instanceof BackupError) {
    return { code: 'BACKUP', userMessage: err.message };
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('UNIQUE constraint')) {
    return { code: 'DUPLICATE', userMessage: 'A record with this name already exists.' };
  }
  if (msg.includes('FOREIGN KEY constraint')) {
    return {
      code: 'IN_USE',
      userMessage: 'This action is not possible because the item is used by other records.',
    };
  }
  if (msg.includes('SQLITE_BUSY') || msg.includes('database is locked')) {
    return { code: 'BUSY', userMessage: 'The database is busy. Please try again.' };
  }
  return { code: 'ERR_RUNTIME', userMessage: GENERIC };
}

export function registerIpcHandlers(opts: IpcOptions): void {
  let maintenance = false; // true while a restore swaps the database file

  const handle = <A extends unknown[], R>(
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: A) => R | Promise<R>,
  ): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!opts.isTrustedSender(event)) {
        logError(`IPC ${channel} rejected: untrusted sender`, event.senderFrame?.url ?? 'unknown');
        return { error: { code: 'FORBIDDEN', userMessage: 'This request is not allowed.' } };
      }
      if (maintenance) {
        return {
          error: { code: 'BUSY', userMessage: 'A restore is in progress. Please wait a moment.' },
        };
      }
      try {
        return await fn(event, ...(args as A));
      } catch (err) {
        const appErr = toAppError(err);
        if (appErr.code === 'ERR_RUNTIME' || appErr.code === 'BUSY') {
          logError(`IPC ${channel}`, err);
        }
        return { error: appErr };
      }
    });
  };

  /* ---------- Settings ---------- */
  handle(IPC_CHANNELS.IS_INITIALIZED, () => isShopInitialized());
  handle(IPC_CHANNELS.GET_SHOP_INFO, () => getShopInfo());
  handle(IPC_CHANNELS.SAVE_SHOP_INFO, (_e, info: unknown) => saveShopInfo(info));
  handle(IPC_CHANNELS.COMPLETE_FIRST_RUN, (_e, input: unknown) => completeFirstRun(input));
  handle(IPC_CHANNELS.DELETE_DATABASE, () => {
    maintenance = true;
    try {
      deleteCurrentDatabase();
    } finally {
      maintenance = false;
    }
  });

  /* ---------- Exchange rate ---------- */
  handle(IPC_CHANNELS.GET_CURRENT_RATE, () => getCurrentRate());
  handle(IPC_CHANNELS.UPDATE_RATE, (_e, rate: unknown) =>
    recordExchangeRateChange(rate as number),
  );

  /* ---------- Categories ---------- */
  handle(IPC_CHANNELS.LIST_CATEGORIES, (_e, activeOnly?: unknown) =>
    listCategories(activeOnly === true),
  );
  handle(IPC_CHANNELS.CREATE_CATEGORY, (_e, input: unknown) => createCategory(input));
  handle(IPC_CHANNELS.UPDATE_CATEGORY, (_e, id: unknown, input: unknown) =>
    updateCategory(id, input),
  );
  handle(IPC_CHANNELS.TOGGLE_CATEGORY_ACTIVE, (_e, id: unknown) => toggleCategoryActive(id));

  /* ---------- Products ---------- */
  handle(IPC_CHANNELS.LIST_PRODUCTS, (_e, activeOnly?: unknown) =>
    listProducts(activeOnly === true),
  );
  handle(IPC_CHANNELS.LIST_ACTIVE_PRODUCTS, () => listActiveProducts());
  handle(IPC_CHANNELS.GET_PRODUCT, (_e, id: unknown) => getProduct(requireId(id, 'Product')));
  handle(IPC_CHANNELS.CREATE_PRODUCT, (_e, input: unknown) => createProduct(input));
  handle(IPC_CHANNELS.UPDATE_PRODUCT, (_e, id: unknown, input: unknown) =>
    updateProduct(id, input),
  );
  handle(IPC_CHANNELS.TOGGLE_PRODUCT_ACTIVE, (_e, id: unknown) => toggleProductActive(id));

  /* ---------- Inventory ---------- */
  handle(IPC_CHANNELS.GET_INVENTORY, (_e, id: unknown) => getInventory(requireId(id, 'Product')));
  handle(IPC_CHANNELS.LIST_INVENTORY, () => listInventory());
  handle(IPC_CHANNELS.LIST_LOW_STOCK, () => listLowStock());
  handle(IPC_CHANNELS.ADD_STOCK, (_e, input: unknown) => addStock(input));
  handle(IPC_CHANNELS.RECORD_WASTE, (_e, input: unknown) => recordWaste(input));
  handle(
    IPC_CHANNELS.ADJUST_STOCK,
    (_e, productId: unknown, newQty: unknown, reason: unknown, notes?: unknown) =>
      adjustStock(productId as number, newQty as number, reason as string, notes as string | undefined),
  );
  handle(IPC_CHANNELS.LIST_MOVEMENTS, (_e, productId?: unknown, limit?: unknown) =>
    listMovements(productId, limit),
  );

  /* ---------- Sales / POS ---------- */
  handle(IPC_CHANNELS.COMPLETE_SALE, (_e, input: unknown) => completeSale(input));
  handle(IPC_CHANNELS.SUSPEND_SALE, (_e, lines: unknown, label?: unknown) =>
    suspendSale(lines, label),
  );
  handle(IPC_CHANNELS.GET_SUSPENDED_SALE, () => getSuspendedSale());
  handle(IPC_CHANNELS.CANCEL_SUSPENDED, () => cancelSuspendedSale());
  handle(IPC_CHANNELS.SAVE_DRAFT_CART, (_e, d: unknown) => saveDraftCart(d));
  handle(IPC_CHANNELS.GET_DRAFT_CART, () => getDraftCart());
  handle(IPC_CHANNELS.CLEAR_DRAFT_CART, () => clearDraftCart());
  handle(IPC_CHANNELS.LIST_SALES, (_e, options?: unknown) => listSales(options));
  handle(IPC_CHANNELS.GET_SALE, (_e, id: unknown) => getSale(requireId(id, 'Sale')));

  /* ---------- Returns ---------- */
  handle(IPC_CHANNELS.CREATE_RETURN, (_e, input: unknown) => createReturn(input));
  handle(IPC_CHANNELS.LIST_RETURNS, (_e, options?: unknown) => listReturns(options));
  handle(IPC_CHANNELS.GET_RETURN, (_e, id: unknown) => getReturn(requireId(id, 'Return')));

  /* ---------- Expenses ---------- */
  handle(IPC_CHANNELS.CREATE_EXPENSE, (_e, input: unknown) => createExpense(input));
  handle(IPC_CHANNELS.LIST_EXPENSES, (_e, options?: unknown) => listExpenses(options));
  handle(IPC_CHANNELS.DELETE_EXPENSE, (_e, id: unknown) => deleteExpense(id));

  /* ---------- Customers ---------- */
  handle(IPC_CHANNELS.LIST_CUSTOMERS, (_e, activeOnly?: unknown) =>
    listCustomers(activeOnly === true),
  );
  handle(IPC_CHANNELS.GET_CUSTOMER, (_e, id: unknown) => getCustomer(id));
  handle(IPC_CHANNELS.CREATE_CUSTOMER, (_e, input: unknown) => createCustomer(input));
  handle(IPC_CHANNELS.UPDATE_CUSTOMER, (_e, id: unknown, input: unknown) =>
    updateCustomer(id, input),
  );
  handle(IPC_CHANNELS.RECORD_CUSTOMER_PAYMENT, (_e, input: unknown) =>
    recordCustomerPayment(input),
  );
  handle(IPC_CHANNELS.LIST_CUSTOMER_TXNS, (_e, customerId: unknown) =>
    listCustomerTransactions(customerId),
  );

  /* ---------- Reports ---------- */
  handle(IPC_CHANNELS.GET_SALES_REPORT, (_e, range: unknown) => getSalesReport(range));
  handle(IPC_CHANNELS.GET_BEST_SELLING, (_e, range: unknown, limit?: unknown) =>
    getBestSellingProducts(range, limit),
  );
  handle(IPC_CHANNELS.GET_SALES_BY_CATEGORY, (_e, range: unknown) => getSalesByCategory(range));
  handle(IPC_CHANNELS.GET_DASHBOARD, () => getDashboard());
  handle(IPC_CHANNELS.GET_CURRENT_CUSTOMER_DEBT, () => getCurrentCustomerDebt());
  handle(IPC_CHANNELS.GET_CASH_BALANCE, () => getCashBalance());
  handle(IPC_CHANNELS.SET_CASH_OPENING_BALANCE, (_e, amount: unknown) =>
    setCashOpeningBalance(amount),
  );
  handle(IPC_CHANNELS.ZERO_CASH_BALANCE, () => zeroCashBalance());
  handle(IPC_CHANNELS.GET_INVENTORY_REPORT, (_e, range: unknown) =>
    getInventoryMovementsReport(range),
  );

  /* ---------- Printing ---------- */
  // Prints the PERSISTED invoice identified by id; never data supplied by the renderer.
  handle(IPC_CHANNELS.PRINT_RECEIPT, (_e, saleId: unknown) => printReceipt(saleId));
  handle(IPC_CHANNELS.LIST_PRINTERS, () => listAvailablePrinters());
  handle(IPC_CHANNELS.TEST_PRINT, () => testPrint());
  handle(IPC_CHANNELS.GET_PRINTER_SETTINGS, () => getPrinterSettings());
  handle(IPC_CHANNELS.SAVE_PRINTER_SETTINGS, (_e, s: unknown) => savePrinterSettings(s));

  /* ---------- Backup ---------- */
  handle(IPC_CHANNELS.LIST_BACKUPS, () => listBackups());
  handle(IPC_CHANNELS.GET_BACKUP_STATUS, () => getBackupStatus());
  handle(IPC_CHANNELS.CREATE_BACKUP, () => createBackup());

  const runRestore = async (file: string) => {
    maintenance = true;
    try {
      return restoreBackup(file);
    } finally {
      maintenance = false;
    }
  };

  // Restore one of the backups listed in the app's own backups folder, by file NAME.
  handle(IPC_CHANNELS.RESTORE_BACKUP, async (_e, fileName: unknown) =>
    runRestore(resolveBackupName(fileName)),
  );

  // Restore a backup chosen by the user in a native file dialog (e.g. from a USB drive).
  handle(IPC_CHANNELS.RESTORE_FROM_FILE, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose a backup file',
      properties: ['openFile'],
      filters: [{ name: 'Local POS backup', extensions: ['db'] }],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    return runRestore(result.filePaths[0]);
  });

  // Back up to a folder chosen by the user (USB/external drive) — the path is chosen in a
  // native dialog opened here, never taken from the renderer.
  handle(IPC_CHANNELS.BACKUP_TO_PATH, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose backup destination folder',
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    return backupToPath(result.filePaths[0]);
  });

  /* ---------- Audit ---------- */
  handle(IPC_CHANNELS.LIST_AUDIT, (_e, limit?: unknown) => {
    const rows = getDrizzle()
      .select()
      .from(auditLog)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(optionalLimit(limit, 200, 1000))
      .all();
    return rows.map((r) => ({
      action: r.action,
      entityId: r.entityId,
      entityType: r.entityType,
      payload: r.payload,
      createdAt: Math.floor(r.createdAt.getTime() / 1000),
    }));
  });

}
