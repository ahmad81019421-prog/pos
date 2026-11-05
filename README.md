# Local POS — Offline-first Windows desktop POS for small food shops

An Electron + React + TypeScript + SQLite POS application for small local food shops (chicken, cheese, dairy, fish, etc.) that currently rely on paper notebooks.

Built entirely offline-first. No cloud, no internet, no subscription.

## Quick start

```bash
# Install dependencies (also rebuilds better-sqlite3 native module for Node)
npm install

# Run all tests (52 tests: 46 financial + 6 database integration)
npm test

# Launch the app in dev mode (Vite + Electron)
npm run dev

# Package as Windows installer (NSIS, .exe)
npm run package:win
```

The Windows installer will be output to `../download/installer/`.

## Tech stack

- **Electron 31** — desktop shell, secure IPC, context isolation, no Node.js in renderer
- **React 18 + TypeScript 5** — renderer with strict types
- **Vite 5** — fast dev server + production renderer bundling
- **better-sqlite3 11** — synchronous native SQLite driver (very fast for desktop)
- **Drizzle ORM** — strongly-typed schema, query builder
- **Zustand** — lightweight cart state (no Redux boilerplate)
- **React Router 6** — HashRouter (works with `file://` in packaged app)
- **electron-builder** — Windows NSIS installer

## Architecture

```
React Renderer (no Node access)
    │
    ▼  (window.posApi.* via contextBridge)
Preload Layer (contextIsolation = true)
    │
    ▼  (ipcRenderer.invoke → ipcMain.handle)
Electron Main Process
    │
    ├──► Services (settings / products / inventory / sales / payments / returns / expenses / customers / reports / backup / printing)
    │
    ▼
SQLite Data Layer (local file in %APPDATA%/LocalPOS/local-pos.db)
```

The renderer NEVER touches Node.js APIs directly. All privileged operations go through typed IPC handlers in main.

## Money correctness (PRD sections 17, 18, 73)

All money is stored as integer minor units — **no floating-point arithmetic anywhere** for accounting:

| Currency  | Storage             | Display                |
|-----------|---------------------|------------------------|
| USD       | integer cents       | `$10.00` (2 decimals)   |
| LBP       | integer LBP         | `895,000 LBP`          |
| Weight    | integer grams       | `1.350 KG` (3 decimals)|

LBP rounding: ceiling to next 5,000 LBP step (matches PRD example 87,300 → 90,000).

Weight sales use integer grams internally (1.350 KG = 1350 g), so 0.001 KG works without floating-point error.

## Tests

Run with `npm test` (rebuilds better-sqlite3 for Node automatically).

- **`tests/financial.test.ts`** — 46 tests covering every PRD section 73 example
  - LBP rounding (87,300 → 90,000)
  - USD→LBP conversion at exchange rate
  - LBP→USD conversion
  - Weight × Price line total (1.350 KG × $4.50/KG = $6.08)
  - Mixed currency payment ($5 USD + 447,500 LBP → covers $10)
  - Change in USD vs LBP
  - Input parsing (weights, quantities, money)

- **`tests/database.test.ts`** — 6 integration tests
  - Schema creates all 17 tables
  - CRUD on shop_settings, categories, products
  - Foreign key enforcement
  - Atomic sale transaction with inventory decrement
  - Historical preservation (changing product price doesn't mutate historical sale_items)

## Project structure

```
pos-app/
├── src/
│   ├── main/                      # Electron main process
│   │   ├── main.ts                # App entry, window creation, menu
│   │   ├── ipc/index.ts           # All IPC handlers (typed wrappers)
│   │   └── services/
│   │       ├── database/          # SQLite + Drizzle services
│   │       │   ├── connection.ts   # init/close/migrations/invoice numbers
│   │       │   ├── schema.ts      # Drizzle schema (17 tables)
│   │       │   ├── settingsService.ts
│   │       │   ├── exchangeRate.ts
│   │       │   ├── productsService.ts
│   │       │   ├── inventoryService.ts
│   │       │   ├── salesService.ts
│   │       │   ├── returnsService.ts
│   │       │   ├── expensesService.ts
│   │       │   ├── customersService.ts
│   │       │   ├── reportsService.ts
│   │       │   └── backupService.ts
│   │       └── printing/printingService.ts
│   ├── preload/
│   │   ├── preload.ts             # contextBridge.exposeInMainWorld('posApi', ...)
│   │   └── types.ts              # Type declarations for window.posApi
│   ├── renderer/                  # React renderer (no Node access)
│   │   ├── main.tsx               # React root, HashRouter
│   │   ├── app/App.tsx            # Routes, initialization check
│   │   ├── components/
│   │   │   ├── layout/Layout.tsx
│   │   │   └── pos/{PaymentDialog, SaleCompletedDialog}.tsx
│   │   ├── pages/
│   │   │   ├── SetupWizard.tsx
│   │   │   ├── pos/PosPage.tsx
│   │   │   ├── products/ProductsPage.tsx
│   │   │   ├── inventory/InventoryPage.tsx
│   │   │   ├── invoices/InvoicesPage.tsx
│   │   │   ├── reports/ReportsPage.tsx
│   │   │   ├── expenses/ExpensesPage.tsx
│   │   │   ├── settings/SettingsPage.tsx
│   │   │   └── backup/BackupPage.tsx
│   │   ├── hooks/useApi.ts
│   │   ├── stores/cartStore.ts
│   │   ├── i18n/                  # Externalized strings
│   │   │   ├── index.ts
│   │   │   ├── en.ts              # 160+ keys
│   │   │   └── ar.ts              # full Arabic translation
│   │   └── styles/global.css
│   └── shared/                    # Imported by both main & renderer
│       ├── types/index.ts         # DTOs
│       ├── constants/index.ts     # IPC channels, default categories, units
│       ├── money/index.ts         # Integer money math (no floats)
│       └── validation/index.ts    # Input validation
├── tests/
│   ├── financial.test.ts          # 46 financial tests
│   └── database.test.ts           # 6 DB integration tests
├── package.json
├── tsconfig.json                  # Renderer tsconfig
├── electron.tsconfig.json         # Main tsconfig (CommonJS)
├── vite.config.ts
└── vitest.config.ts
```

## Key features mapped to PRD sections

| PRD § | Feature | Implementation |
|-------|---------|----------------|
| 4     | Secure Electron architecture | preload.ts contextBridge, contextIsolation=true, nodeIntegration=false |
| 7     | First-run setup wizard | `SetupWizard.tsx` + `completeFirstRun()` |
| 8     | Arabic RTL + English LTR | `i18n/` with 160+ externalized strings; setLanguage flips `document.dir` |
| 9     | Product system | Products CRUD, activation/deactivation, optional images |
| 10    | Weight/Package/Piece units | `sellingUnit` enum; integer minor units (grams / count) |
| 11    | Arbitrary decimal weights | `parseWeightKg("1.350")` → 1350 grams |
| 12    | Two weight workflows | "Weight × Price" mode + "Direct Final Price" mode in AddToCartDialog |
| 14    | Daily pricing | Update `currentPrice` without affecting historical snapshots |
| 15-17 | USD/LBP currencies + LBP rounding | Money library; ceiling to 5,000 LBP step |
| 18    | Financial precision | All money stored as integer minor units, no floats |
| 19    | POS screen layout | Categories sidebar + product grid + cart, 3-column layout |
| 24    | Suspended invoice | `status='SUSPENDED'`; only one allowed at a time |
| 25-27 | Payment (USD/LBP/Mixed) + Change in chosen currency | `computePaymentBreakdown()` USD-equivalent aggregation |
| 28    | Customers / credit | Simple customer CRUD + record payment toward balance |
| 29-31 | Inventory + Add Stock + Purchase cost | Auto-decrement on sale; Add Stock with cost snapshot |
| 32    | Profit calculation | Reports: revenue - cost - expenses - waste = net profit |
| 36    | Waste recording | Reason (Expired/Damaged/Spoiled/Other); reduces inventory |
| 37    | Returns (full + partial) | `returnsService.createReturn()` with proportional refund |
| 38    | Invoice editing control | After payment: returns only (no silent mutation) |
| 40    | Reports | Sales by range, best-selling, by category, financial KPIs |
| 43-44 | Printing | Isolated service; never crashes POS; 80mm thermal receipt |
| 45-46 | Backup + Restore | VACUUM INTO; safety backup before restore; retention |
| 47    | DB in app-data dir | `app.getPath('userData')/local-pos.db` |
| 48    | Atomic transactions | `db.transaction()` wraps every sale/return/waste |
| 50    | Historical preservation | All sale_items / payments / expenses store snapshot values |
| 51    | Soft delete products | `active=false`; never physically delete |
| 53    | Input validation | All IPC handlers wrap with `wrapHandler()` |
| 55    | Windows installer | `npm run package:win` produces NSIS .exe |
| 56    | Forward-only migrations | `schema_version` table tracks applied migrations |
| 57    | Human-readable errors | `friendlyMessage()` strips SQLite internals |
| 72-73 | Automated tests | 52 tests, all passing |
| 81    | Phase-by-phase build | All 10 phases implemented |

## Currency behavior

PRD section 17 example: `87,300 LBP` rounds to `90,000 LBP`. This is "ceiling to next 5,000 LBP step" — the customer always pays UP to the next LBP note they can physically hand over (Lebanon's smallest common note is 5,000 LBP).

```typescript
roundLbp(87300)   // → 90000  (remainder rounded UP)
roundLbp(85000)   // → 85000  (already aligned)
roundLbp(87499)   // → 90000  (any remainder rounds UP)
```

## Exchange rate

Set during first-run setup, changeable from Settings (PRD §16 — not on POS screen to prevent accidents).

Each change appends to `exchange_rate_history` with `effective_from` timestamp. Historical transactions preserve the rate snapshot at their time of completion.

## Backup behavior

- Automatic daily backup on app startup (if a backup doesn't exist for today)
- Stored in `%APPDATA%/LocalPOS/backups/backup-YYYY-MM-DD.db`
- Default retention: 7 days (configurable)
- Manual backup button on Backup page
- "Backup to USB / External folder" opens a folder picker
- Restore: creates a safety backup of the current DB before overwriting (PRD §46)

## Development notes

**Switching between `npm test` and `npm run dev`:**
- `npm test` runs `npm rebuild better-sqlite3` first (rebuilds for Node)
- `npm run dev` runs `electron-rebuild -f -w better-sqlite3` first (rebuilds for Electron)
- The two rebuilds are necessary because better-sqlite3 is a native module that must match the JavaScript runtime

**Path aliases (`@shared/*`, `@renderer/*`, `@main/*`):**
- Renderer (Vite) resolves them at build time via `vite.config.ts` `resolve.alias`
- Main (tsc) resolves them via `tsconfig.json` `paths`, then `tsc-alias` rewrites the JS output to relative paths at build time

## Out of scope (PRD §63)

Cloud, SaaS, multi-tenant, subscription, online payments, employee management, payroll, tax system, advanced accounting, multi-warehouse, multi-branch, advanced CRM, supplier management, barcode, electronic scale integration, recipe/composite products, batch/lot tracking, complex expiry management, online exchange-rate API, mobile app, web app, customer-facing website, online ordering, delivery management.
