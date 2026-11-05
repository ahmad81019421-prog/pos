/**
 * Type declarations for window.posApi (exposed by preload).
 * Renderer imports this to get autocomplete and type safety.
 */

import type {
  ShopInfo,
  CategoryDTO,
  ProductDTO,
  Currency,
  InventoryDTO,
  SaleDTO,
  ReturnDTO,
  ExpenseDTO,
  ExpensePaymentSource,
  CustomerDTO,
  BestSellingProductDTO,
  SalesReport,
  CashBalanceDTO,
  BackupInfo,
  BackupStatus,
  ExchangeRateInfo,
  CartLineInput,
  CompleteSaleInput,
  AddStockInput,
  WasteInput,
  ReturnInput,
  AppError,
  DateRange,
} from '@shared/types/index';

export interface DraftCartDTO {
  requestId: string;
  savedAt: number;
  items: Array<{
    product: ProductDTO;
    quantityMinor: number;
    unitPriceMinor: number;
    priceCurrency: Currency;
    directFinalPrice: boolean;
    lineTotalMinor: number;
    repriced: boolean;
  }>;
  dropped: Array<{ productId: number; reason: 'missing' | 'inactive' | 'invalid' }>;
}
export interface PrintResult {
  success: boolean;
  skipped?: boolean;
  error?: string;
}
export interface PrinterSettings {
  enabled: boolean;
  printerName: string | null;
  paperWidth: 80 | 58;
  silent: boolean;
}
export interface InventoryMovementsReport {
  additions: Array<{
    productName: string;
    quantityMinor: number;
    sellingUnit: 'WEIGHT' | 'PACKAGE' | 'PIECE';
    unitCost: number | null;
    currency: string | null;
    createdAt: number;
  }>;
  waste: Array<{
    productName: string;
    quantityMinor: number;
    sellingUnit: 'WEIGHT' | 'PACKAGE' | 'PIECE';
    reason: string | null;
    costUsdCents: number;
    costKnown: boolean;
    createdAt: number;
  }>;
}

export interface PosApiSurface {
  isInitialized: () => Promise<boolean>;
  getShopInfo: () => Promise<ShopInfo | null | { error: AppError }>;
  saveShopInfo: (info: Partial<ShopInfo>) => Promise<void | { error: AppError }>;
  completeFirstRun: (input: {
    shopName: string;
    phone?: string;
    address?: string;
    defaultCurrency: 'USD' | 'LBP';
    language: 'en' | 'ar';
    exchangeRate: number;
  }) => Promise<void | { error: AppError }>;
  deleteDatabase: () => Promise<void | { error: AppError }>;

  getCurrentRate: () => Promise<ExchangeRateInfo | { error: AppError }>;
  updateRate: (rate: number) => Promise<void | { error: AppError }>;

  listCategories: (activeOnly?: boolean) => Promise<CategoryDTO[] | { error: AppError }>;
  createCategory: (input: {
    name: string;
    nameAr?: string;
    sortOrder?: number;
  }) => Promise<CategoryDTO | { error: AppError }>;
  updateCategory: (
    id: number,
    input: Partial<{ name: string; nameAr: string; sortOrder: number }>,
  ) => Promise<void | { error: AppError }>;
  toggleCategoryActive: (id: number) => Promise<void | { error: AppError }>;

  listProducts: (activeOnly?: boolean) => Promise<ProductDTO[] | { error: AppError }>;
  listActiveProducts: () => Promise<ProductDTO[] | { error: AppError }>;
  getProduct: (id: number) => Promise<ProductDTO | null | { error: AppError }>;
  createProduct: (input: {
    name: string;
    nameAr?: string;
    categoryId: number;
    sellingUnit: 'WEIGHT' | 'PACKAGE' | 'PIECE';
    currentPrice: number;
    priceCurrency: 'USD' | 'LBP';
    currentCost?: number | null;
    lowStockThreshold?: number | null;
    imageDataUrl?: string | null;
    notes?: string;
    storeAsUsd?: boolean;
  }) => Promise<ProductDTO | { error: AppError }>;
  updateProduct: (
    id: number,
    input: Partial<{
      name: string;
      nameAr: string;
      categoryId: number;
      sellingUnit: 'WEIGHT' | 'PACKAGE' | 'PIECE';
      currentPrice: number;
      priceCurrency: 'USD' | 'LBP';
      currentCost: number | null;
      lowStockThreshold: number | null;
      imageDataUrl: string | null;
      notes: string;
      storeAsUsd: boolean;
    }>,
  ) => Promise<void | { error: AppError }>;
  toggleProductActive: (id: number) => Promise<void | { error: AppError }>;

  getInventory: (productId: number) => Promise<InventoryDTO | null | { error: AppError }>;
  listInventory: () => Promise<InventoryDTO[] | { error: AppError }>;
  listLowStock: () => Promise<InventoryDTO[] | { error: AppError }>;
  addStock: (input: AddStockInput) => Promise<InventoryDTO | { error: AppError }>;
  recordWaste: (input: WasteInput) => Promise<InventoryDTO | { error: AppError }>;
  adjustStock: (
    productId: number,
    newQty: number,
    reason: string,
    notes?: string,
  ) => Promise<InventoryDTO | { error: AppError }>;
  listMovements: (
    productId?: number,
    limit?: number,
  ) => Promise<unknown[] | { error: AppError }>;

  completeSale: (input: CompleteSaleInput) => Promise<SaleDTO | { error: AppError }>;
  suspendSale: (lines: CartLineInput[], label?: string) => Promise<SaleDTO | { error: AppError }>;
  getSuspendedSale: () => Promise<SaleDTO | null | { error: AppError }>;
  cancelSuspendedSale: () => Promise<void | { error: AppError }>;
  saveDraftCart: (d: {
    requestId: string;
    lines: Array<{ productId: number; quantityMinor: number; directFinalPrice: boolean; lineTotalMinor: number }>;
  }) => Promise<void | { error: AppError }>;
  getDraftCart: () => Promise<DraftCartDTO | null | { error: AppError }>;
  clearDraftCart: () => Promise<void | { error: AppError }>;
  listSales: (options?: {
    search?: string;
    status?: 'COMPLETED' | 'SUSPENDED' | 'VOIDED' | 'RETURNED';
    from?: number;
    to?: number;
    limit?: number;
  }) => Promise<SaleDTO[] | { error: AppError }>;
  getSale: (id: number) => Promise<SaleDTO | null | { error: AppError }>;

  createReturn: (input: ReturnInput) => Promise<ReturnDTO | { error: AppError }>;
  listReturns: (options?: { from?: number; to?: number; limit?: number }) => Promise<ReturnDTO[] | { error: AppError }>;
  getReturn: (id: number) => Promise<ReturnDTO | null | { error: AppError }>;

  createExpense: (input: {
    date: number;
    description: string;
    amountMinor: number;
    currency: 'USD' | 'LBP';
    paymentSource: ExpensePaymentSource;
    category: string;
    notes?: string;
  }) => Promise<ExpenseDTO | { error: AppError }>;
  listExpenses: (options?: {
    from?: number;
    to?: number;
    category?: string;
    limit?: number;
  }) => Promise<ExpenseDTO[] | { error: AppError }>;
  deleteExpense: (id: number) => Promise<void | { error: AppError }>;

  listCustomers: (activeOnly?: boolean) => Promise<CustomerDTO[] | { error: AppError }>;
  getCustomer: (id: number) => Promise<CustomerDTO | null | { error: AppError }>;
  createCustomer: (input: {
    name: string;
    phone?: string;
    notes?: string;
  }) => Promise<CustomerDTO | { error: AppError }>;
  updateCustomer: (
    id: number,
    input: Partial<{ name: string; phone: string; notes: string; active: boolean }>,
  ) => Promise<void | { error: AppError }>;
  recordCustomerPayment: (input: {
    customerId: number;
    amountMinor: number;
    currency: 'USD' | 'LBP';
    settleRemainder?: boolean;
    notes?: string;
  }) => Promise<CustomerDTO | { error: AppError }>;
  listCustomerTxns: (customerId: number) => Promise<unknown[] | { error: AppError }>;

  getSalesReport: (range: DateRange) => Promise<SalesReport | { error: AppError }>;
  getBestSelling: (range: DateRange, limit?: number) => Promise<BestSellingProductDTO[] | { error: AppError }>;
  getSalesByCategory: (range: DateRange) => Promise<unknown[] | { error: AppError }>;
  getDashboard: () => Promise<{ today: SalesReport; yesterday: SalesReport } | { error: AppError }>;
  getCurrentCustomerDebt: () => Promise<number | { error: AppError }>;
  getCashBalance: () => Promise<CashBalanceDTO | { error: AppError }>;
  setCashOpeningBalance: (amountUsdCents: number) => Promise<void | { error: AppError }>;
  zeroCashBalance: () => Promise<void | { error: AppError }>;
  getInventoryReport: (range: DateRange) => Promise<InventoryMovementsReport | { error: AppError }>;

  printReceipt: (saleId: number) => Promise<PrintResult | { error: AppError }>;
  listPrinters: () => Promise<Array<{ name: string; displayName: string; isDefault: boolean }> | { error: AppError }>;
  testPrint: () => Promise<PrintResult | { error: AppError }>;
  getPrinterSettings: () => Promise<PrinterSettings | { error: AppError }>;
  savePrinterSettings: (s: PrinterSettings) => Promise<PrinterSettings | { error: AppError }>;

  listBackups: () => Promise<BackupInfo[] | { error: AppError }>;
  createBackup: () => Promise<{ fileName: string; filePath: string; sizeBytes: number } | { error: AppError }>;
  getBackupStatus: () => Promise<BackupStatus | { error: AppError }>;
  restoreBackup: (fileName: string) => Promise<{ safetyBackupPath: string } | { error: AppError }>;
  restoreFromFile: () => Promise<{ safetyBackupPath: string } | { canceled: true } | { error: AppError }>;
  backupToPath: () => Promise<{ fileName: string; filePath: string; sizeBytes: number } | { canceled: true } | { error: AppError }>;

  listAudit: (limit?: number) => Promise<unknown[] | { error: AppError }>;

  onMenuNavigate: (callback: (route: string) => void) => () => void;
  onMenuAbout: (callback: () => void) => () => void;
}

declare global {
  interface Window {
    posApi: PosApiSurface;
  }
}

export {};
