# TESTING REPORT (updated after the final hardening pass)

## Commands (run in this session)
```
npm test                              # vitest run — 8 files, 130 tests
npm run typecheck                     # tsc --noEmit (renderer) + tsc --noEmit (main/preload)
npm run build                         # vite build (CSP injected) + tsc + tsc-alias + esbuild preload
npx electron-builder --linux dir      # packaging smoke test of the Electron 44 app (NOT the Windows installer)
node e2e/suite.cjs                    # 22 real-UI scenarios against the packaged app (needs xvfb; see e2e/harness.cjs)
npm audit / npm audit --omit=dev      # dependency advisories
```

## Results
- `npm test`: **8 files, 130 tests, 130 passed, 0 failed, 0 skipped.**
- `npm run typecheck`: clean. `npm run build`: succeeds.
- **E2E (real packaged app, Electron 44.7.0, Xvfb): 22/22 scenarios passed** twice (before and after the dependency upgrades). Raw results: `e2e/RESULTS.json`, `e2e/RESULTS-electron44.json`; screenshots: `e2e/shots/`.
  Scenarios: first-run wizard; create products (weight/piece/LBP); price edit; add stock; weight sale 1.350 kg → $6.08 with $3.92 change; direct final price; LBP-only 87,300 → 90,000 (87,300 refused); mixed $5 + 447,500 LBP; change in LBP and USD; insufficient-stock warnings (cart-aware); suspend/resume; double-click duplicate prevention; empty-cart/disabled controls; invalid input messages; partial, partial, then remaining return (stock restored exactly, refunds sum to sale); expenses + reports match API; waste via UI → waste report $1.50; backup + restore through the UI; crash (kill -9) draft recovery restored once with no double sale; discard draft; Arabic RTL on all 9 screens (sidebar right, no horizontal overflow) and back to English LTR.
- Runtime security probe of the packaged app: no `require/process/Buffer/module` in the renderer, `window.open` blocked, external navigation blocked, external `fetch` blocked, CSP present, 63 API methods exposed.

## Test inventory (automated, `npm test`)
| File | Tests | Covers |
|------|------:|--------|
| `financial.test.ts` (existing, unchanged) | 46 | money helpers, PRD §73 examples |
| `lbp-policy.test.ts` | 15 | D1: rounding boundaries around 5,000, LBP-only vs mixed vs USD tender, underpayment, overpayment, USD/LBP change, exact stored totals and reports |
| `misc.test.ts` | 13 | IPC error mapping, receipt HTML, exact parsing, property test, date ranges, stock rule D3 (`findStockProblems`) |
| `sales.test.ts` | 21 | Workflow A/B, atomicity, idempotency, history stability, credit, suspended, search |
| `returns-reports.test.ts` | 12 | returns, report reconciliation, waste snapshot/D5 report, add-stock conversion, customers |
| `backup-migration.test.ts` | 9 | backup/restore failure paths, migrations, newer-DB refusal |
| `draft.test.ts` | 9 | restart recovery, re-pricing, no stored prices/PII, invalid/corrupt drafts, cancellation, atomic removal on sale, committed-sale draft discarded, double-submit → one sale |
| `smoke.test.ts` | 1 | harness |
(Counts per file from the vitest JSON reporter; the first four rows sum with the rest to 130.)

## Not verified (blocked or not done)
- **Windows**: installer build/install/upgrade/uninstall, running without Node, real thermal printer, USB backup drive — **not run** (no Windows/printer in this environment; `electron-builder --win` fails here with `spawn wine ENOENT`).
- Visual audit covered the Arabic screens listed above plus the English POS/payment/reports screenshots; not every dialog in both languages, and keyboard-only operation was not audited.
- Performance (§58) not measured. No component-level (React) unit tests; UI is covered by the e2e suite instead.
- Regression tests were written against the fixed code (not re-run against the original code).
- CSP enforcement itself was not exercised (DevTools evaluation bypasses CSP); only its presence was checked.
