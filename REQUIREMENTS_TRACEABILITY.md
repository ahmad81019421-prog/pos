# REQUIREMENTS TRACEABILITY (PRD sections 1–84)

Legend: **V** implemented and verified by automated test · **P** implemented, verified only by run/inspection (no dedicated test) · **M** needs manual verification · **O** open decision · **N/A** descriptive/process section.
Evidence: T = automated test file, R = packaged-app run, C = code review.

| § | Topic | Status | Evidence / note |
|---|-------|:-----:|-----------------|
| 1 | Overview | N/A | — |
| 2 | Business model (weight/piece/package, USD+LBP) | V | sales/returns tests |
| 3 | Tech stack (Electron, React, TS, Vite, SQLite, Drizzle) | P | R, `npm run build` |
| 4 | Critical architecture rule (renderer has no Node/DB) | V | R: `require/process/Buffer` undefined; preload bundle only requires electron; contextIsolation+sandbox |
| 5 | Product philosophy / speed of sale | M | — |
| 6 | Navigation | P | Customers page added; M for RTL |
| 7 | First-run setup | V | settings: once-only, rate validated (R: wizard renders); M for full wizard flow |
| 8 | Language EN/AR, RTL | P/M | i18n keys added; receipt RTL tested (misc); **UI RTL not visually audited**; menu English-only (dev only) |
| 9 | Product system | V | create/update validated; unit-change block (C) |
| 10 | Product units | V | piece/package/weight in sales tests |
| 11 | Weight-based selling (grams) | V | 0.125, 1.350 tests; exact parsing |
| 12 | Two weight workflows A/B | V | sales.test (A recompute server-side, B final price, rejects ≤0, piece rejected) |
| 13 | Package/piece selling | V | sales/returns tests |
| 14 | Daily pricing | P | price change audited; history stable (T) |
| 15 | Currency system | V | currency-mismatch validation, mixed totals |
| 16 | Exchange rate | V | rate history, tie-break, atomic audit, rate-after-sale (T) |
| 17 | LBP rounding to 5,000 | V (policy needs approval) | D1 resolved: LBP-only tender → cash due rounded UP to 5,000 (87,300→90,000); any USD in tender → exact; stored totals/reports exact; change USD floor / LBP ceiling. `lbp-policy.test.ts` (15). PRD_ADDENDUM §85 |
| 18 | Financial precision | V | integer cents/grams, limits < 2⁵³, BigInt returns, property test |
| 19 | Sales screen | M | — |
| 20 | POS design requirements | M | — |
| 21 | Product search | P | name/Arabic name filter (C) |
| 22 | Quick selection | M | — |
| 23 | Cart | V | draft persisted (`app_settings.draft_cart`), restored with banner, re-priced, invalid lines dropped, idempotent vs committed sale (`draft.test.ts` 9; e2e kill -9 recovery). G2 closed |
| 24 | Suspended invoice | V/M | service tested; UI banner M |
| 25 | Payment | V | breakdown tests, mixed payment, credit option |
| 26 | Change | V | USD floor / LBP ceiling 5,000 |
| 27 | Payment UX | M | quick-fill buttons, live preview |
| 28 | Customers / credit | V (service) / P (UI) | credit sale, payment ≤ balance, return reversal; Customers page minimal |
| 29 | Inventory | V | decrement/restore, insufficient stock hard-block: UI warning, Complete disabled, server refuses atomically (D3 resolved; tests + e2e) |
| 30 | Stock addition | V | currency conversion |
| 31 | Purchase cost | V/O | latest-cost method (D2) |
| 32 | Profit | V | report reconciliation |
| 33 | Inventory complexity (no FIFO) | V | latest cost only |
| 34 | Low stock | P | `listLowStock` (C) |
| 35 | Stocktake | P | `adjustStock` validated; no dedicated UI test |
| 36 | Waste | V | reason required, ≤ stock, cost snapshot, shown separately with `costKnown`, deducted once from net profit (D5 resolved) |
| 37 | Returns | V | partial/full/over-return/rate/cost |
| 38 | Invoice editing (not allowed) | V | no edit API; returns separate rows |
| 39 | Expenses | V (service) | create/delete audit; report |
| 40 | Reports | V | KPI definitions in `SalesReport` doc; by-category and best-sellers; Inventory/Waste/Returns report tabs added (stock, low stock, additions, waste+cost, date filters; e2e). G3 closed |
| 41 | Dashboard | P | `getDashboard` (C) |
| 42 | Invoices | V/M | search server-side, escaped LIKE |
| 43 | Printing | P/M | HTML tested; **real thermal printer not verified** |
| 44 | Printing architecture | V | from persisted sale, never throws, window destroyed, timeout |
| 45 | Backup | V | create, daily auto (never throws), retention, status/error shown |
| 46 | Restore | V | all failure paths tested; M for UI + Windows |
| 47 | Database location (userData) | R | DB created in userData under packaged run |
| 48 | Database safety (WAL, FK, integrity) | V | pragmas, quick_check at start, full check after restore |
| 49 | Entities | P | schema + migration 2 |
| 50 | Historical data rule | V | snapshots for name/price/cost/rate/category |
| 51 | Product deletion (deactivate) | P | `toggleProductActive`; inactive products unsellable (T) |
| 52 | Auditability | P | audit_log entries for price, rate, expense delete, etc. |
| 53 | Security | V/P | see AUDIT_REPORT §Electron; Electron 44.7.0; prod audit 0 findings, dev-only 25 documented; runtime probe in e2e (G6 mitigated, not 'secure' claim) |
| 54 | No internet | P | CSP `connect-src 'self'`; no network code (C) |
| 55 | Installation / distribution | **Blocked** | NSIS config reviewed; Linux `--dir` package built and run; Windows installer NOT built (no wine) — G1 |
| 56 | Updates / migrations | V | v1→v2 with data, pre-upgrade backup, newer-DB refusal |
| 57 | Error handling | V | friendly errors, log file, no stack leak |
| 58 | POS performance | **Not measured** | G4 |
| 59 | UI requirements | M | — |
| 60 | Accessibility / usability | M | — |
| 61 | Product images (data URL, validated) | P | `requireOptionalImage` (C) |
| 62 | Keyboard support | M / partial | not audited |
| 63 | Out of scope | V | no cloud/server added |
| 64 | Business edge cases | V (most) | duplicate sale, partial returns, rate change, over-stock, tiny weights; M for the rest |
| 65 | Main screens | P | Customers page added |
| 66 | Product creation UX | M | — |
| 67 | Add stock UX | M | — |
| 68 | Sale workflow | V (service) / R | end-to-end through packaged IPC |
| 69 | Suspended sale workflow | V/M | — |
| 70 | Return workflow | V/M | UI uses remaining quantities |
| 71 | Reporting philosophy | V | KPI definitions documented and reconciled |
| 72 | Testing requirements | Partial | see TESTING_REPORT gaps |
| 73 | Automated financial examples | V | `financial.test.ts` (one pre-existing expectation now passes under exact policy) |
| 74 | Database integrity | V | atomicity/rollback tests, FK on |
| 75 | Code quality | P | typecheck clean |
| 76 | Project structure | P | unchanged (+ `shared/dates`, `logging`, `printing/receipt`) |
| 77 | State management | P | zustand cart + persisted draft (G2 closed) |
| 78 | Validation | V | shared validators, service-level |
| 79 | Don't overengineer | V | no scope expansion |
| 80 | Agent development rules | N/A | followed |
| 81 | Development strategy | N/A | — |
| 82 | Acceptance criteria | see below | |
| 83 | Final product definition | N/A | — |
| 84 | Final instruction | N/A | — |

## §82 Acceptance criteria (summary)
Sell weight/piece items with exact money — **met (tests)** · mixed USD/LBP payment and change — **met (tests)** · stock updates — **met** · returns/reports consistent — **met** · backup/restore safe — **met (Linux/temp dirs)** · Arabic/English — **partly (not visually audited)** · printing — **not verified on hardware** · Windows installer — **not verified**.

## Gaps referenced
Open: G1 Windows installer/install/upgrade/uninstall + real thermal printer (blocked here) · G4 performance not measured · keyboard-only audit · some P3 i18n (category labels English-only, a few bidi snippets). Closed this pass: G2, G3, G6 (mitigated). See RELEASE_READINESS.md and TESTING_REPORT.md.
