# POS corrective patch — 2026-10-15

This patch is based on the static audit of `pos-app-pilot.zip`.

## Code changes

1. **Returns / customer debt (POS-01):** return processing now caps the debt reduction at the customer's current non-negative aggregate balance and records only the amount actually removed. This prevents a return from making the balance negative. **Limitation:** customer payments are not allocated to individual invoices, so the app cannot prove which invoice's credit remains unpaid when a customer has multiple invoices. A refund settlement method (cash / debt offset / customer credit) is also not yet modelled. Do not treat this as a complete invoice-level refund-accounting solution.
2. **Return quantity input (POS-02):** piece/package quantities now require a whole-number digit string and a safe integer. Invalid non-empty values stop the return instead of being silently truncated or ignored. Weight quantities continue through the strict kg parser.
3. **Payment dialog LBP display (POS-03):** the dialog now displays `breakdown.cashDueLbp`, the same computed field used by the payment calculation, instead of unconditionally rounding the exact owed amount.
4. **Return settlement (POS-04):** not fully implemented. The required business policy is not defined in the project: cash refund, debt offset, customer credit, or a supported combination. The database currently records return value but not how the refund was settled.
5. **Customer LBP debt payments (POS-05):** because V1 has no non-cash settlement method for customer debt payments, LBP payments are validated as cash and must be a multiple of 5,000.
6. **Audit log (POS-06):** customer updates, category edits, and category active/inactive changes are recorded transactionally with before/after values where applicable.
7. **Return query performance:** added `return_item_sale_item_idx` to the Drizzle schema and migration v3.

## Not changed / requires separate verification or a business decision

- SQLite database and backup files remain unencrypted. Encryption needs a device/key/recovery threat model and must not be bolted on without a safe recovery design.
- The local audit log is not tamper-proof against a person with direct access to the database file.
- Historical category names in reports still resolve through the current category table; a category-name snapshot requires a schema migration and a decision about historical display semantics.
- Report performance, long-session memory use, and large-dataset responsiveness have not been measured.
- Windows installer build, clean install/upgrade/uninstall, thermal printer behavior, USB removal, disk-full behavior, power-loss recovery, and real Windows backup/restore remain unverified in this environment.
- CSP enforcement and hostile IPC behavior were not independently penetration-tested in this patch.

## Verification status

- Source edits and migration were reviewed after modification.
- Automated tests, TypeScript typecheck, renderer build, Electron build, Windows packaging, and E2E suite were **not run**: dependencies are not installed in this environment and offline `npm ci` could not retrieve a required package from the local cache.
- Existing test reports inside the supplied archive are historical reports, not evidence that this patched version passes.

## Recommended next verification on a machine with package access

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run package:win
```

Then test the generated Windows installer on a clean Windows account and a real shop device, including the return/payment cases described above.
