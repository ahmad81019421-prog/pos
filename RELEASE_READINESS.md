# RELEASE READINESS (updated after the final hardening pass)

## Classification: **CONDITIONALLY READY — supervised PILOT on Windows, after the Windows gates below pass.**
Not ready for general release. No P0 defect is known to be open; two P1 verification gaps remain (installer, printer), both blocked by missing Windows/printer hardware.

## Gates
| Gate | Description | Status | How verified |
|------|-------------|--------|--------------|
| A | Typecheck + production build | **PASS** | `npm run typecheck`, `npm run build` (automated) |
| B | Automated tests | **PASS** 126/126 | `npm test` (8 files) |
| B2 | Real-app UI workflows (packaged Electron 44 on Linux/Xvfb) | **PASS** 22/22 | `node e2e/suite.cjs` (automated UI, real DB, screenshots in `e2e/shots/`) |
| C | Windows NSIS installer built, installed, upgraded, uninstalled | **NOT DONE — blocked** | An NSIS build attempted on Linux produced only a 183 KB stub and failed (`spawn wine ENOENT`); discarded. Must be built on Windows |
| D | Real thermal printer | **NOT DONE — no hardware** | Receipt HTML unit-tested only |
| E | Manual Windows acceptance in English and Arabic | **NOT DONE** | Checklist below |

## What changed in this pass
D1 rounding policy documented and tested; D3 stock rule enforced in UI+server; D5 waste/profit reports and UI; draft-cart crash recovery; Inventory & Waste and Returns report tabs; **Electron 31 → 44.7.0**, better-sqlite3 11 → 13.0.3 (N-API prebuilds, so no native rebuild step and the Windows binary ships in the package), drizzle-orm 0.36 → 0.45.4, react-router-dom 6 → 7.18, electron-builder 24 → 26; real UI test suite; stale-stock-warning bug and the printer `isDefault` API removal fixed.

## Unresolved issues
| Sev | Issue |
|-----|-------|
| P1 (verification) | Windows installer/upgrade/uninstall not built or run (gate C) |
| P1 (verification) | Thermal printing not tested on hardware, incl. Arabic text (gate D) |
| P2 | No code signing → SmartScreen warning on first install |
| P2 | Performance targets (PRD §58) not measured |
| P3 | Report category labels are English-only/not snapshotted; "Last updated" label in Settings and some bidi snippets (e.g. "KG 5.100") not localized |
| P3 | Keyboard-only operation not audited |

## Dependency / security status (`npm audit`, after upgrades)
- **Production dependencies: 0 advisories** reported (`npm audit --omit=dev`). This is the scanner's result, not proof of security; Electron 44 is within the supported window (42–44 at the time of this pass) but will age out.
- **Development-only: 25 advisories remain** (4 critical, 7 high, 14 moderate) in build/test tooling: vitest/@vitest/mocker/tinypool/vite-node (arbitrary file read / RCE only when the Vitest UI or dev server is exposed, or with untrusted worker options), vite + esbuild dev-server issues (only while `npm run dev` runs, reachable from a hostile web page on the same machine), `concurrently`→`shell-quote` (command injection needs attacker-controlled input to the dev script), `tsc-alias`→`braces/micromatch/fast-glob` (DoS on crafted patterns), `electron-builder` transitive (`@electron/get`/`global-agent`/`sprintf-js`: build-time only), `drizzle-kit`→esbuild-kit. **None ships in the installer**; exposure is the developer/CI machine. Upgrading them needs major jumps (vite 8, vitest 5, drizzle-kit 0.31) and was deliberately not forced; do it as a separate, tested change. Rule: don't run `npm run dev` or the Vitest UI on an untrusted network.
- drizzle-orm SQL-identifier injection (fixed in 0.45.4, applied): the app only uses fixed schema identifiers, so it was not exploitable here.
- Not re-run after the upgrade: dynamic CSP-enforcement tests (CDP evaluation bypasses CSP); runtime checks done: renderer has no `require/process/Buffer/module`, `window.open` blocked, navigation to external URL blocked, external `fetch` blocked, CSP meta present.

## Business decisions still requiring your approval
1. **LBP change rounding** – rounded UP to 5,000 (customer-favouring). Alternative: round down, or nearest.
2. **LBP-only cash due rounding** – rounded UP (87,300 → 90,000, per PRD example). The shop therefore receives up to 4,999 LBP more than invoiced on LBP-only payments; that difference is *not* revenue in reports (reports use exact totals). Confirm this is acceptable accounting.
3. **Returned goods are restocked** – confirm; damaged returns need a manual waste entry.
4. Category names in historical reports follow the *current* category name.
(D2, D3, D5, D7 are resolved in PRD_ADDENDUM.md from the PRD text.)

## Windows pilot checklist (do on a clean Windows 10/11 machine without Node/npm)
Build: `npm ci` → `npm run package:win` (on Windows; output `release/Local POS Setup 1.0.0.exe`).
1. Copy the installer to the clean machine; confirm it installs without Node.js; note the SmartScreen prompt.
2. Launch; first-run wizard; confirm `%APPDATA%\Local POS\local-pos.db` exists; close and relaunch (data kept).
3. Create products (weight/piece/LBP), add stock; run the sale matrix: 1.350 kg × $4.50 = $6.08; direct final price; USD; LBP-only 87,300 → must ask 90,000; mixed $5 + 447,500 LBP on $10; change in USD and LBP; one-cent-short refused.
4. Try to sell more than stock → warning, Complete Sale disabled.
5. Double-click Complete Sale → one invoice. Suspend/resume. Add items, kill the app in Task Manager, relaunch → "Unfinished cart recovered" → Restore → complete once.
6. Full return; partial return twice then the remainder; stock and reports reconcile.
7. Expenses, waste (with and without cost), Reports tabs (Sales, Inventory & Waste, Returns) match the invoices.
8. Backup now; backup to USB; make a change; restore from list and from file; try restoring a renamed text file (must refuse).
9. **Upgrade test**: install this version, create data, install the next build over it → data and settings intact; a `pre-upgrade-*.db` appears in `backups` if the schema changed.
10. **Uninstall** → `%APPDATA%\Local POS` must still exist (config sets `deleteAppDataOnUninstall: false`).
11. Printer: set the printer in Settings → Test print; print a receipt in English and Arabic on 58 mm and 80 mm paper; unplug the printer → the sale still completes with a visible notice.
12. Switch to Arabic: RTL on every screen, numbers/currency readable, long product names, payment dialog; switch back.
13. Windows Defender/AV scan of the installer; record the result.
Record pass/fail per step with screenshots; any failure in 2, 5, 8, 9, 10 blocks the pilot.
