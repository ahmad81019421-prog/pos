# AUDIT REPORT — Local POS (Electron + React + TS + SQLite)

Scope: existing offline-first Windows POS audited against the 84-section PRD. Method: repository inventory → requirements trace → financial/DB/IPC/Electron/backup/printing review → fixes with tests → build and packaged-app run. Baseline is commit `9b1f594`; `git diff` shows every change.

## 1. Architecture summary
Main process: SQLite (better-sqlite3 + Drizzle) in `userData`, services per domain, IPC handlers with sender trust check, printing, backup, logging. Preload: bundled with esbuild, exposes `window.posApi` (60 methods). Renderer: React/Vite, zustand cart, en/ar dictionaries. Storage conventions: USD integer cents, LBP integers, weight integer grams.

## 2. Financial correctness
- Line total: `round-half-up(grams × price/kg ÷ 1000)`; piece = qty × price. Rounding only at defined boundaries.
- Payment sufficiency is **exact** (common unit `usdCents×rate + lbp×100`); all inputs bounded so intermediates stay < 2⁵³ (limits in `shared/money`).
- D1 policy: stored totals and reports always exact; LBP-only tender → cash due rounded up to 5,000 (87,300→90,000); any USD in tender → exact comparison; USD change floored; LBP change ceiling to 5,000; debt measured against exact owed. Owed / received / cash due / change are shown separately.
- Returns: cumulative proportional refunds (BigInt), cost reversed from the sale snapshot, refunds converted at the **original** sale rate.
- KPIs (documented in `SalesReport`): gross = COMPLETED+RETURNED invoices in range; returns reverse revenue; COGS net of returned cost; net profit = gross − expenses − waste (waste valued at the time of waste).
- Verified by 126 tests (8 files) including a 2,000-case property test and hand-derived PRD examples.

## 3. Database integrity
Sales are one `IMMEDIATE` transaction (sale, items, payment, stock, movements, credit, audit); injected-failure test proves full rollback. Idempotency key prevents duplicates. Migration 2 (additive, with backfill) is tested from a v1 DB with data, a pre-upgrade `VACUUM INTO` backup is taken first, and a DB from a newer app is refused. Foreign keys ON, WAL, `synchronous=NORMAL`, quick_check at start.

## 4. Electron / IPC security
Strengths now: contextIsolation, sandbox, webSecurity, no nodeIntegration; navigation, `window.open`, webview and all permission requests denied; single-instance lock; IPC sender must be the main window on the bundled page; every payload validated in services; errors returned as friendly text only; no file path ever supplied by the renderer for restore/backup; build-time CSP. Verified at runtime in the packaged app (no `require/process/Buffer`).
Electron upgraded 31 → 44.7.0 (supported line); better-sqlite3 13 (N-API prebuilds, no native rebuild); isolation, IPC trust, navigation, CSP re-verified at runtime in the real app. Production `npm audit`: 0 findings; 25 dev-only (build tooling) documented in RELEASE_READINESS — not claimed 'secure'. No code signing.

## 5. Backup / restore
Snapshot via `VACUUM INTO` (tmp → integrity check → rename); restore validates (open, full integrity, required tables, schema ≤ app) → safety backup → close DB → swap with `.before-restore` aside → reopen → full integrity → rollback on failure. Retention only prunes `backup-YYYY-MM-DD(-n).db`. Auto-backup never throws and records its last error, surfaced on the Backup page. Tested in isolated temp directories only (no production DB touched).

## 6. Printing
Receipt HTML is a pure function of the persisted sale (escaped, bilingual, RTL for Arabic, 58/80 mm). Printing never throws, window destroyed in `finally`, 30 s timeout, auto-print is non-blocking after the sale. **Not verified on a physical printer or on Windows.**

## 7. UI/UX (limited)
Fixed: double-submit guard, suspended-sale handling, remaining-quantity returns, credit ("on account") payment, Customers page, printer settings load/save, Backup restore by name/file with status, reports use shared date logic and show net sales + by-category. Added this pass: persisted draft cart with safe recovery, cart-aware stock warnings (D3), inventory/waste/returns report tabs, RTL-safe rate header. Real-app UI suite 22/22 with screenshots (`e2e/`). **Not done:** exhaustive RTL/LTR audit of every screen, keyboard-only audit, performance measurement, a few P3 i18n items (category labels English-only, some bidi snippets).

## 8. Reports reconciliation
Tested: sales − returns − COGS − expenses − waste = net profit (waste deducted once, cost snapshot, `costKnown` flag); fully returned invoice nets to zero; suspended sales excluded.

## 9. Known limitations / risks
See RELEASE_READINESS.md and PRD_ADDENDUM.md (decisions D1–D7). Windows installer and physical printer remain unverified (blocked in this environment).
