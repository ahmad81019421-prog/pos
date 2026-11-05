/**
 * Shared constants used across main, preload, and renderer.
 */

import type {
  Currency,
  ExpenseCategory,
  SellingUnit,
} from '@shared/types/index';

export const IPC_CHANNELS = {
  // Settings
  GET_SHOP_INFO: 'settings:getShopInfo',
  SAVE_SHOP_INFO: 'settings:saveShopInfo',
  IS_INITIALIZED: 'settings:isInitialized',
  COMPLETE_FIRST_RUN: 'settings:completeFirstRun',

  // Exchange rate
  GET_CURRENT_RATE: 'rate:getCurrent',
  UPDATE_RATE: 'rate:update',

  // Categories
  LIST_CATEGORIES: 'categories:list',
  CREATE_CATEGORY: 'categories:create',
  UPDATE_CATEGORY: 'categories:update',
  TOGGLE_CATEGORY_ACTIVE: 'categories:toggleActive',

  // Products
  LIST_PRODUCTS: 'products:list',
  LIST_ACTIVE_PRODUCTS: 'products:listActive',
  GET_PRODUCT: 'products:get',
  CREATE_PRODUCT: 'products:create',
  UPDATE_PRODUCT: 'products:update',
  TOGGLE_PRODUCT_ACTIVE: 'products:toggleActive',

  // Inventory
  GET_INVENTORY: 'inventory:get',
  LIST_INVENTORY: 'inventory:list',
  LIST_LOW_STOCK: 'inventory:listLowStock',
  ADD_STOCK: 'inventory:addStock',
  RECORD_WASTE: 'inventory:recordWaste',
  ADJUST_STOCK: 'inventory:adjustStock',
  LIST_MOVEMENTS: 'inventory:listMovements',

  // Sales / POS
  COMPLETE_SALE: 'sales:complete',
  SUSPEND_SALE: 'sales:suspend',
  GET_SUSPENDED_SALE: 'sales:getSuspended',
  RESUME_SUSPENDED_SALE: 'sales:resumeSuspended',
  CANCEL_SUSPENDED: 'sales:cancelSuspended',
  SAVE_DRAFT_CART: 'draft:save',
  GET_DRAFT_CART: 'draft:get',
  CLEAR_DRAFT_CART: 'draft:clear',
  LIST_SALES: 'sales:list',
  GET_SALE: 'sales:get',

  // Returns
  CREATE_RETURN: 'returns:create',
  LIST_RETURNS: 'returns:list',
  GET_RETURN: 'returns:get',

  // Expenses
  CREATE_EXPENSE: 'expenses:create',
  LIST_EXPENSES: 'expenses:list',
  DELETE_EXPENSE: 'expenses:delete',

  // Customers
  LIST_CUSTOMERS: 'customers:list',
  GET_CUSTOMER: 'customers:get',
  CREATE_CUSTOMER: 'customers:create',
  UPDATE_CUSTOMER: 'customers:update',
  RECORD_CUSTOMER_PAYMENT: 'customers:recordPayment',
  LIST_CUSTOMER_TXNS: 'customers:listTxns',

  // Reports
  GET_SALES_REPORT: 'reports:sales',
  GET_BEST_SELLING: 'reports:bestSelling',
  GET_SALES_BY_CATEGORY: 'reports:salesByCategory',
  GET_DASHBOARD: 'reports:dashboard',
  GET_CURRENT_CUSTOMER_DEBT: 'reports:currentCustomerDebt',
  GET_CASH_BALANCE: 'reports:cashBalance',
  SET_CASH_OPENING_BALANCE: 'reports:setCashOpeningBalance',
  ZERO_CASH_BALANCE: 'reports:zeroCashBalance',
  DELETE_DATABASE: 'settings:deleteDatabase',

  // Printing
  PRINT_RECEIPT: 'print:receipt',
  LIST_PRINTERS: 'print:listPrinters',
  TEST_PRINT: 'print:test',

  // Backup
  LIST_BACKUPS: 'backup:list',
  CREATE_BACKUP: 'backup:create',
  RESTORE_BACKUP: 'backup:restore',
  BACKUP_TO_PATH: 'backup:backupToPath',
  RESTORE_FROM_FILE: 'backup:restoreFromFile',
  GET_BACKUP_STATUS: 'backup:status',

  // Printer settings
  GET_PRINTER_SETTINGS: 'print:getSettings',
  SAVE_PRINTER_SETTINGS: 'print:saveSettings',

  // Inventory report
  GET_INVENTORY_REPORT: 'reports:inventoryMovements',

  // Audit
  LIST_AUDIT: 'audit:list',
} as const;

export type IpcChannel = keyof typeof IPC_CHANNELS | (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export const DEFAULT_CATEGORIES = [
  { name: 'Chicken', nameAr: 'دجاج', sortOrder: 1 },
  { name: 'Cheese', nameAr: 'جبن', sortOrder: 2 },
  { name: 'Dairy', nameAr: 'ألبان', sortOrder: 3 },
  { name: 'Fish', nameAr: 'سمك', sortOrder: 4 },
  { name: 'Frozen', nameAr: 'مجمدات', sortOrder: 5 },
  { name: 'Canned / Packaged Food', nameAr: 'معلبات ومغلقات', sortOrder: 6 },
  { name: 'Beverages', nameAr: 'مشروبات', sortOrder: 7 },
  { name: 'Other', nameAr: 'أخرى', sortOrder: 99 },
];

export const EXPENSE_CATEGORIES: { value: ExpenseCategory; enLabel: string; arLabel: string }[] = [
  { value: 'ELECTRICITY', enLabel: 'Electricity', arLabel: 'كهرباء' },
  { value: 'WATER', enLabel: 'Water', arLabel: 'مياه' },
  { value: 'RENT', enLabel: 'Rent', arLabel: 'إيجار' },
  { value: 'TRANSPORT', enLabel: 'Transportation', arLabel: 'نقل' },
  { value: 'MAINTENANCE', enLabel: 'Maintenance', arLabel: 'صيانة' },
  { value: 'OTHER', enLabel: 'Other', arLabel: 'أخرى' },
];

export const WASTE_REASONS = [
  'Expired',
  'Damaged',
  'Spoiled',
  'Other',
];

export const WASTE_REASONS_AR = [
  'منتهي الصلاحية',
  'تالف',
  'فسد',
  'أخرى',
];

export const SELLING_UNIT_LABELS: Record<
  SellingUnit,
  { en: string; ar: string; short: string }
> = {
  WEIGHT: { en: 'Weight (KG)', ar: 'وزن (كلغ)', short: 'KG' },
  PACKAGE: { en: 'Package', ar: 'علبة', short: 'BOX' },
  PIECE: { en: 'Piece', ar: 'قطعة', short: 'PCS' },
};

export const DEFAULT_EXCHANGE_RATE = 89500; // 1 USD = 89,500 LBP (initial default per PRD section 16)

export const BACKUP_RETENTION_DEFAULT = 7; // keep last 7 days of daily backups

export const APP_DATA_DIR_NAME = 'LocalPOS';
