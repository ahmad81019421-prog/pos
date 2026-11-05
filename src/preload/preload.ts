/**
 * Secure preload bridge.
 *
 * PRD section 4: React renderer must NOT directly access unrestricted Node.js APIs.
 * This preload uses contextBridge to expose a narrow, typed API surface.
 * All privileged operations go through IPC to the main process.
 */

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '@shared/constants/index';

const api = {
  // Settings
  isInitialized: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.IS_INITIALIZED),
  getShopInfo: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_SHOP_INFO),
  saveShopInfo: (info: unknown): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_SHOP_INFO, info),
  completeFirstRun: (input: unknown): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPLETE_FIRST_RUN, input),
  deleteDatabase: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.DELETE_DATABASE),

  // Exchange rate
  getCurrentRate: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_CURRENT_RATE),
  updateRate: (rate: number): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.UPDATE_RATE, rate),

  // Categories
  listCategories: (activeOnly?: boolean): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.LIST_CATEGORIES, activeOnly),
  createCategory: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.CREATE_CATEGORY, input),
  updateCategory: (id: number, input: unknown): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CATEGORY, id, input),
  toggleCategoryActive: (id: number): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TOGGLE_CATEGORY_ACTIVE, id),

  // Products
  listProducts: (activeOnly?: boolean): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.LIST_PRODUCTS, activeOnly),
  listActiveProducts: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.LIST_ACTIVE_PRODUCTS),
  getProduct: (id: number): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_PRODUCT, id),
  createProduct: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.CREATE_PRODUCT, input),
  updateProduct: (id: number, input: unknown): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.UPDATE_PRODUCT, id, input),
  toggleProductActive: (id: number): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TOGGLE_PRODUCT_ACTIVE, id),

  // Inventory
  getInventory: (productId: number): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_INVENTORY, productId),
  listInventory: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.LIST_INVENTORY),
  listLowStock: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.LIST_LOW_STOCK),
  addStock: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.ADD_STOCK, input),
  recordWaste: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.RECORD_WASTE, input),
  adjustStock: (productId: number, newQty: number, reason: string, notes?: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.ADJUST_STOCK, productId, newQty, reason, notes),
  listMovements: (productId?: number, limit?: number): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.LIST_MOVEMENTS, productId, limit),

  // Sales / POS
  completeSale: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPLETE_SALE, input),
  suspendSale: (lines: unknown[], label?: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.SUSPEND_SALE, lines, label),
  getSuspendedSale: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_SUSPENDED_SALE),
  saveDraftCart: (d: unknown): Promise<unknown> => ipcRenderer.invoke(IPC_CHANNELS.SAVE_DRAFT_CART, d),
  getDraftCart: (): Promise<unknown> => ipcRenderer.invoke(IPC_CHANNELS.GET_DRAFT_CART),
  clearDraftCart: (): Promise<unknown> => ipcRenderer.invoke(IPC_CHANNELS.CLEAR_DRAFT_CART),
  cancelSuspendedSale: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CANCEL_SUSPENDED),
  listSales: (options?: unknown): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.LIST_SALES, options),
  getSale: (id: number): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_SALE, id),

  // Returns
  createReturn: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.CREATE_RETURN, input),
  listReturns: (options?: unknown): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.LIST_RETURNS, options),
  getReturn: (id: number): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_RETURN, id),

  // Expenses
  createExpense: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.CREATE_EXPENSE, input),
  listExpenses: (options?: unknown): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.LIST_EXPENSES, options),
  deleteExpense: (id: number): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.DELETE_EXPENSE, id),

  // Customers
  listCustomers: (activeOnly?: boolean): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.LIST_CUSTOMERS, activeOnly),
  getCustomer: (id: number): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_CUSTOMER, id),
  createCustomer: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.CREATE_CUSTOMER, input),
  updateCustomer: (id: number, input: unknown): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CUSTOMER, id, input),
  recordCustomerPayment: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.RECORD_CUSTOMER_PAYMENT, input),
  listCustomerTxns: (customerId: number): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.LIST_CUSTOMER_TXNS, customerId),

  // Reports
  getSalesReport: (range: unknown): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_SALES_REPORT, range),
  getBestSelling: (range: unknown, limit?: number): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_BEST_SELLING, range, limit),
  getSalesByCategory: (range: unknown): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_SALES_BY_CATEGORY, range),
  getDashboard: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_DASHBOARD),
  getCurrentCustomerDebt: (): Promise<number> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_CURRENT_CUSTOMER_DEBT),
  getCashBalance: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_CASH_BALANCE),
  setCashOpeningBalance: (amountUsdCents: number): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_CASH_OPENING_BALANCE, amountUsdCents),
  zeroCashBalance: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.ZERO_CASH_BALANCE),
  getInventoryReport: (range: unknown): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_INVENTORY_REPORT, range),

  // Printing
  printReceipt: (saleId: number): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.PRINT_RECEIPT, saleId),
  getPrinterSettings: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_PRINTER_SETTINGS),
  savePrinterSettings: (settings: unknown): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_PRINTER_SETTINGS, settings),
  listPrinters: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.LIST_PRINTERS),
  testPrint: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.TEST_PRINT),

  // Backup
  listBackups: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.LIST_BACKUPS),
  createBackup: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.CREATE_BACKUP),
  getBackupStatus: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_BACKUP_STATUS),
  // Restore a listed backup by FILE NAME (no free paths from the renderer).
  restoreBackup: (fileName: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.RESTORE_BACKUP, fileName),
  // Opens a native file picker in the main process.
  restoreFromFile: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.RESTORE_FROM_FILE),
  // Opens a native folder picker in the main process.
  backupToPath: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.BACKUP_TO_PATH),

  // Audit
  listAudit: (limit?: number): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.LIST_AUDIT, limit),

  // Menu events from main process
  onMenuNavigate: (callback: (route: string) => void) => {
    const handler = (_event: IpcRendererEvent, route: string) => callback(route);
    ipcRenderer.on('menu:navigate', handler);
    return () => ipcRenderer.off('menu:navigate', handler);
  },
  onMenuAbout: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('menu:about', handler);
    return () => ipcRenderer.off('menu:about', handler);
  },
};

contextBridge.exposeInMainWorld('posApi', api);

export type PosApi = typeof api;
