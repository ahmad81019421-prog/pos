# PRD ADDENDUM — decisions resolved during hardening (applies on top of PRD §1–84)

Each item cites the PRD text it is derived from. Items marked **NEEDS OWNER APPROVAL** are implemented in the most conservative reading and are listed again in RELEASE_READINESS.md.

## 85. LBP rounding (clarifies §17, §25–27)
Four different numbers are kept apart everywhere (service, payment dialog, receipt, reports):
1. **Amount owed (exact)** – invoice total as stored; never rounded. Reports use only this.
2. **Cash due in LBP** – shown only for LBP-only tenders: the exact LBP-equivalent rounded **up** to the next 5,000 (87,300 → 90,000, the §17 example). Payments that include any USD are compared **exactly**, so no customer is overcharged by a rounding they did not choose.
3. **Amount received** – what the customer handed over, stored as entered (USD cents + LBP).
4. **Change** – USD change is floored to whole cents; LBP change is rounded up to the next 5,000 (**NEEDS OWNER APPROVAL**: favours the customer; the PRD only specifies the 87,300 → 90,000 example).
Debt/credit is always measured against the exact amount owed. Rounding is never applied to stored totals, cost, profit or reports.

## 86. Selling beyond recorded stock (§29, §64) — rule D3
A sale can **never** take stock below zero. The POS warns before it happens (product dialog shows available/requested including what is already in the cart; "Complete Sale" is disabled while the cart exceeds stock) and the server refuses it atomically. The owner fixes the stock first (Add Stock / Adjust). Rationale: simplest consistent rule, keeps stock movements and cost reports trustworthy.

## 87. Waste and profit (§36, §32, §50) — rule D5
Waste records quantity, reason (Expired/Damaged/Spoiled/Other) and a **cost snapshot at the time of waste** (USD cents). Net profit = gross profit − expenses − waste cost. Waste is not part of COGS, so it is deducted exactly once. Later cost or rate changes never alter historical waste. Waste on a product with no recorded cost counts as $0.00 and is flagged "cost not recorded".

## 88. Resolved without new business rules
- **D2 costing** – latest purchase cost snapshotted per sale; no FIFO/LIFO (§31, §33 forbid advanced costing; §31 forbids overwriting historical cost).
- **D7 menu language** – the native menu exists only in development builds; the packaged app has none, and all UI text is localized (§8).

## 89. Draft cart recovery (new, supports §23, §69, §77)
An unfinished cart is saved locally (product ids, quantities, weight final price only – no prices, customer or payment data). After an unexpected restart the cashier is offered **Restore / Discard**; a draft is clearly labelled "not an invoice". Restoring re-prices from the current price list and uses the exchange rate current at completion. Each draft carries the sale's idempotency key, so a draft whose sale already committed is discarded and a draft can never be sold twice. Items that are no longer sellable are dropped and reported.

## 90. Still open — NEEDS OWNER APPROVAL
- D4: returned goods are restocked (§37 "inventory updated appropriately"); damaged returns must be recorded as waste afterwards.
- D6 / §85.4: LBP change rounded up.
- Report category names are not snapshotted per sale.
