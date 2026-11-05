# BUGS AND FIXES

Severity: **P0** data loss / wrong money / security hole · **P1** wrong behaviour in normal use · **P2** robustness / UX · **P3** polish.
"Test" = automated test that now covers the fix. "Manual" = needs the manual checklist (RELEASE_READINESS.md).

| # | Sev | Area | Defect (original code) | Fix | Verified by |
|---|-----|------|------------------------|-----|-------------|
| 1 | P0 | Payments | Sufficiency compared in lossy USD cents (LBP→cents rounding): a payment short by up to ~half a cent could pass; change drifted. | Exact comparison in common "LBP×100" units, safe-integer limits, rejects NaN/negative/oversize. Change: USD floored, LBP ceiling to 5,000. | Test (property test 2,000 random cases + boundaries) |
| 2 | P0 | Sales | No duplicate-sale protection (double click / retry created 2 sales and deducted stock twice). | `clientRequestId` idempotency key (unique partial index, migration 2); POS busy-guard + one key per attempt. | Test |
| 3 | P0 | Sales | Client-supplied unit price / line total trusted for Workflow A. | Server recomputes from the **stored** product price; client total ignored. | Test (found by new test) |
| 4 | P0 | Backup | Restore copied a file over the open WAL database; renderer supplied an arbitrary path. | Restore takes a listed backup *name* or a native dialog (main process); validate → safety backup → close → swap with rollback → reopen → full integrity check. | Test (corrupt, non-DB, newer-schema, missing, traversal names, rollback) |
| 5 | P0 | Returns | Full return after a partial return failed / double-counted; partial returns did not reduce revenue or profit. | Cumulative proportional refunds (BigInt `mulDivRound`), per-line returned qty, cost reversed from sale snapshot, status RETURNED only when fully returned, customer-debt reversal. | Test |
| 6 | P0 | Reports | LBP refunds converted with `refund_lbp * rate / 100` (wrong by orders of magnitude). | Refund USD-equivalent stored at the *original sale rate*; reports reconcile (gross − returns, COGS net of returned cost). | Test |
| 7 | P0 | Data access | Several services cast raw `SELECT *` rows (snake_case) to Drizzle camelCase types → `undefined` fields (currency checks, customers, returns, inventory, shop settings, products list). TypeScript could not see it. | `rowOf()` mapper in `connection.ts`; all raw casts removed. | Test + packaged-app run |
| 8 | P0 | DB | Opening a database written by a NEWER app version was allowed. | `DatabaseTooNewError`, friendly startup dialog, data untouched. | Test (found by new test) |
| 9 | P1 | Waste/profit | Waste valued at *current* cost/rate at report time. | Cost snapshotted at waste time (`inventory_movements.cost_usd_cents`, backfilled). Net profit = gross − expenses − waste. | Test |
| 10 | P1 | Stock | Add-stock cost in a different currency than the product was stored unconverted. | Converted to product currency (`convertMinor`), original kept on the movement. | Test |
| 11 | P1 | Sales | Zero-total lines, wrong-currency lines, inactive products, Workflow B on piece items were accepted. | Validated server-side. | Test |
| 12 | P1 | Products | Changing selling unit after stock/history existed corrupted stock meaning. | Blocked once stock or history exists; price changes audited (old/new). | Code review (no dedicated test) |
| 13 | P1 | Numbering | Invoice/return numbers broke beyond 99,999 (string MAX). | Numeric MAX(CAST(SUBSTR…)). | Code review (no dedicated test) |
| 14 | P1 | Suspended sale | Suspended sale consumed an invoice number; resume merged into non-empty cart; cancel not awaited. | Fixed number `SUSPENDED`, no stock/sequence effect, resume only into empty cart, awaited. | Test (service) / Manual (UI) |
| 15 | P1 | Electron | `window.open` allow-all, free navigation, no permission handling, no single-instance lock, sandbox off, IPC not sender-checked. | Hardened BrowserWindow (sandbox, contextIsolation, webSecurity), nav/window.open/webview denied, permissions denied, single-instance, IPC sender check, preload bundled with esbuild (only `require("electron")`). | Packaged-app run (`require/process/Buffer` undefined in renderer) |
| 16 | P1 | IPC | Unvalidated payloads, stack traces returned to the UI. | Service-level validation everywhere; `toAppError` returns friendly text only; details to `logs/app.log`. | Test |
| 17 | P1 | Printing | Receipt printed from renderer-supplied data; window leaked on error. | Printed from persisted sale by id; never throws; window destroyed in `finally`; 30 s timeout. | Test (HTML) / **real printer not verified** |
| 18 | P1 | Backup | Automatic backup failures silent; retention could delete user files. | Failure recorded and shown on Backup page; prune only `backup-YYYY-MM-DD(-n).db`; pre-upgrade backup before migrations. | Test (partial) |
| 19 | P2 | Rate | Rate tie-break non-deterministic; change not atomic with audit. | `effective_from DESC, id DESC`; transaction with previous rate in audit. | Test |
| 20 | P2 | Reports UI | Own date logic (week/month) duplicated and untested. | Shared `getRange` / `getCustomRange` (Monday-first, last day to 23:59:59). | Test |
| 21 | P2 | Payment UI | Fallback hard-coded rate 89,500 when rate failed to load. | Blocks payment until the real rate loads; "On account" option with customer picker. | Manual |
| 22 | P2 | CSP | No Content-Security-Policy. | Injected at build time only (`script-src 'self'`, `img-src 'self' data:`, …). | Packaged-app run (meta present) |
| 23 | P2 | Packaging | `resources/icon.ico` missing; output dir outside the project. | Icon created; output `release/`. | Linux `--dir` package built; **Windows NSIS not built** |
| 24 | P2 | Tests | Old DB tests ran against a copy-pasted SQL schema, so they could not detect real migration/service bugs. | Replaced by service tests on real migrations; electron mocked in `tests/setup.ts`. | — |
| 25 | P3 | UI | Hard-coded English strings (restore alert, "Sold:", etc.). | Moved to i18n (en/ar) in the pages touched. | Manual (RTL review pending) |

## Pass 2 — final hardening (this pass)
| # | Sev | Area | Defect / change | Fix | Verified by |
|---|-----|------|-----------------|-----|-------------|
| 26 | P1 | Money (D1) | LBP-only payment compared against exact total; PRD example 87,300→90,000 not honored. | Policy in `shared/money`: LBP-only cash due rounded up to 5,000, USD tenders exact, stored totals exact; UI shows owed / received / cash due / change. | `lbp-policy.test.ts` (15) + e2e |
| 27 | P1 | Stock (D3) | Overselling allowed to reach negative-stock path with weak warning. | `findStockProblems` (cart-aware, sums split lines); warning, Complete disabled, server atomic refusal. | tests + e2e |
| 28 | P1 | UI | Stale product list after a sale gave a wrong stock warning. | `reloadProducts()` after sale. | e2e (found by it) |
| 29 | P1 | Cart (G2) | Cart lost on crash/reload. | `draftService` + restore banner; re-priced; invalid dropped; removed in the sale transaction; committed-sale draft discarded. | `draft.test.ts` (9) + kill -9 e2e |
| 30 | P1 | Reports (G3/D5) | No inventory/waste UI; waste cost unknown flag missing. | Inventory/Waste/Returns tabs, `costKnown`. | test + e2e |
| 31 | P1 | Dependencies (G6) | Electron 31 EOL, audit advisories. | Electron 44.7.0, better-sqlite3 13, drizzle 0.45.4, router 7.18, builder 26; no `--force`. | typecheck/tests/e2e; prod audit 0 |
| 32 | P1 | Printing | `PrinterInfo.isDefault` removed in Electron 44. | Read `options['is-default']`. | typecheck (real printer not verified) |
| 33 | P3 | i18n/RTL | Rate header garbled in RTL. | `<bdi dir="ltr">`. | e2e screenshot |
| 34 | P3 | Tests | TESTING_REPORT count wrong. | Corrected (lbp-policy 15; total 126). | vitest JSON |
| 35 | P1 | Credit + LBP rounding | LBP 87,300 of a 90,000 cash due could be settled "on account" with 0 debt (external review). | LBP cash must be a multiple of 5,000 (smallest note) when the sale is accepted; closes the gap. | `lbp-policy.test.ts` |
| 36 | P1 | Products | Changing product currency reinterpreted old price/cost numbers (3 USD cost → 3 LBP). | Service requires new price (and cost or null) on currency change; UI clears both fields. | `misc.test.ts` |
| 37 | P2 | Electron | Trusted-page check used `startsWith`. | Exact page (protocol + pathname) / dev origin match. | typecheck; not re-run in e2e |
| 38 | P3 | Packaging | `allowScripts` pinned to old Electron / better-sqlite3. | Updated to 44.7.0 / 13.0.3. | not re-tested with npm install |
| 39 | Policy | Product money | Owner decision: store money in USD only. | Price/cost typed in LBP are converted once at the current rate and stored as USD cents (`storeAsUsd`); UI shows a note; old LBP records still work. | `misc.test.ts` |

## Decisions and their status
- D1 (LBP rounding), D3 (insufficient stock), D5 (waste) are implemented as documented in PRD_ADDENDUM §85–90 and **need business approval** (see RELEASE_READINESS).
- Not fixed / blocked: Windows NSIS build and install tests, physical thermal printer, performance, keyboard-only audit, code signing.

- Owner-confirmed (2026-10-12): LBP rounds up to 5,000 because no smaller note exists; returned goods go back to stock unchanged (waste is entered by the owner at day end).
