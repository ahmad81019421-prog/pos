/**
 * Money & currency utilities — the financial correctness core of the application.
 *
 * PRD requirements addressed:
 *   - Section 17: LBP rounding to nearest 5,000 LBP
 *   - Section 18: NO floating-point arithmetic for money; deterministic integer math
 *   - Section 73: Centralized, tested financial calculations
 *
 * Storage convention:
 *   - USD is stored as integer cents (1 USD = 100 cents)
 *   - LBP is stored as integer LBP (1 LBP = 1 unit; LBP has no practical subdivision)
 *   - Weight (KG) is stored as integer grams (1 KG = 1000 g) → exact decimal weights
 *
 * Conversion:
 *   - USD → LBP at the current exchange rate, then rounded to nearest 5,000 LBP
 *   - LBP → USD at the current exchange rate, rounded to nearest cent
 */

import type { Currency } from '@shared/types';

export const LBP_ROUND_STEP = 5000; // LBP rounds to nearest 5,000
export const USD_CENTS_PER_DOLLAR = 100;
export const GRAMS_PER_KG = 1000;

/**
 * Hard safety limits. They keep every intermediate product below 2^53 so integer
 * arithmetic stays exact (PRD 18) and reject absurd values typed by mistake.
 */
export const MAX_WEIGHT_GRAMS = 1_000_000; // 1,000 kg per line
export const MAX_PIECE_QUANTITY = 100_000;
// Chosen so that usd*rate + lbp*100 (see computePaymentBreakdown) stays < 2^53:
//   1e9 cents * 1e6 rate = 1e15 ; 5e13 LBP * 100 = 5e15 ; sum 6e15 < 9.007e15.
export const MAX_USD_CENTS = 1_000_000_000; // $10,000,000.00
export const MAX_LBP = 50_000_000_000_000; // 50 trillion LBP
export const MAX_RATE = 1_000_000; // LBP per USD
export const MAX_UNIT_PRICE_USD_CENTS = 100_000_000; // $1,000,000 per unit
export const MAX_UNIT_PRICE_LBP = 1_000_000_000; // 1 billion LBP per unit

export function isSafeMoney(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/**
 * Round a non-negative integer LBP amount to the nearest 5,000 LBP step.
 *
 * PRD section 17 example: 87,300 → 90,000.
 * This matches "ceiling to next 5,000 LBP step" semantics, which is the
 * practical convention in Lebanon where the smallest common note is 5,000 LBP:
 * if a customer owes a non-aligned amount of LBP cash, they always pay UP to
 * the next 5,000 multiple (the merchant never rounds down on what they receive).
 *
 * Change given back to a customer, however, is also rounded using this same
 * function — the customer always gets at least what they are owed, rounded up
 * to the nearest 5,000 LBP note they can physically receive.
 *
 * 87,300 → 90,000 ; 85,000 → 85,000 ; 0 → 0.
 */
export function roundLbp(lbp: number): number {
  if (!Number.isInteger(lbp)) {
    throw new Error(`roundLbp expected integer, got ${lbp}`);
  }
  if (lbp < 0) {
    return -roundLbp(-lbp);
  }
  // Ceiling to next 5,000 step (unless already aligned).
  const remainder = lbp % LBP_ROUND_STEP;
  if (remainder === 0) return lbp;
  return lbp + (LBP_ROUND_STEP - remainder);
}

/**
 * Round to nearest USD cent (half-up). Useful when converting from LBP.
 */
export function roundUsd(usdCents: number): number {
  if (!Number.isInteger(usdCents)) {
    throw new Error(`roundUsd expected integer cents, got ${usdCents}`);
  }
  return usdCents; // already integer; kept for symmetry / future hook point
}

/**
 * Convert USD cents to LBP at the given exchange rate (LBP per 1 USD),
 * then round to nearest 5,000 LBP.
 *
 *   usdCents=1000 (=$10.00), rate=89500 → 895,000 LBP → roundLbp → 895,000
 */
export function usdCentsToLbp(usdCents: number, rate: number): number {
  if (rate <= 0) {
    throw new Error(`usdCentsToLbp: rate must be positive, got ${rate}`);
  }
  if (usdCents < 0) {
    return -usdCentsToLbp(-usdCents, rate);
  }
  // total_cents * rate / 100 = total LBP
  // We use integer arithmetic: usdCents * rate first (no rounding loss), then /100.
  const rawLbp = Math.trunc((usdCents * rate + 50) / 100); // round to nearest LBP
  return roundLbp(rawLbp);
}

/**
 * Convert LBP to USD cents at the given exchange rate (LBP per 1 USD).
 * Result rounded to nearest cent.
 *
 *   lbp=447500, rate=89500 → 447500/89500 = 5.00 USD → 500 cents
 */
export function lbpToUsdCents(lbp: number, rate: number): number {
  if (rate <= 0) {
    throw new Error(`lbpToUsdCents: rate must be positive, got ${rate}`);
  }
  if (lbp < 0) {
    return -lbpToUsdCents(-lbp, rate);
  }
  // lbp * 100 / rate = usd cents, rounded half-up
  return Math.trunc((lbp * 100 + Math.trunc(rate / 2)) / rate);
}

/**
 * Convert a USD-cent balance to its exact LBP equivalent without cash rounding.
 * The result may include a fraction of one LBP when the balance is not an exact
 * whole-LBP amount.
 */
export function usdCentsToLbpExact(usdCents: number, rate: number): number {
  if (!Number.isSafeInteger(usdCents) || usdCents < 0) {
    throw new Error('usdCentsToLbpExact: invalid USD cents');
  }
  if (!Number.isSafeInteger(rate) || rate <= 0) {
    throw new Error('usdCentsToLbpExact: rate must be a positive integer');
  }
  return (usdCents * rate) / 100;
}

/**
 * Compute line total for Workflow A (weight × unit price).
 *
 * Inputs are all integer minor units.
 *   - quantityMinor: grams for WEIGHT, integer count for PIECE/PACKAGE
 *   - unitPriceMinor: price per KG for WEIGHT, price per unit for PIECE/PACKAGE
 *
 * For WEIGHT:
 *   total = (quantity_grams / 1000) * price_per_kg_minor
 *         = (quantity_grams * price_per_kg_minor) / 1000
 *
 * For PIECE/PACKAGE:
 *   total = quantity * unit_price_minor
 *
 * Result rounded half-up to nearest minor unit. For LBP currency result is NOT yet
 * rounded to 5,000 (rounding happens only at payment boundaries — PRD section 17
 * applies to cash calculations, not internal line totals). Callers may call roundLbp
 * explicitly when computing a cash payment amount.
 */
export function computeLineTotal(
  quantityMinor: number,
  unitPriceMinor: number,
  sellingUnit: 'WEIGHT' | 'PACKAGE' | 'PIECE',
  currency: Currency,
): number {
  if (!Number.isSafeInteger(quantityMinor) || !Number.isSafeInteger(unitPriceMinor)) {
    throw new Error('computeLineTotal: quantity and price must be integers');
  }
  if (quantityMinor < 0 || unitPriceMinor < 0) {
    throw new Error(
      `computeLineTotal: negative values not allowed (qty=${quantityMinor}, price=${unitPriceMinor})`,
    );
  }
  const maxPrice = currency === 'USD' ? MAX_UNIT_PRICE_USD_CENTS : MAX_UNIT_PRICE_LBP;
  const maxMaxTotal = currency === 'USD' ? MAX_USD_CENTS : MAX_LBP;
  const maxQty = sellingUnit === 'WEIGHT' ? MAX_WEIGHT_GRAMS : MAX_PIECE_QUANTITY;
  if (unitPriceMinor > maxPrice) throw new Error('Unit price is too large');
  if (quantityMinor > maxQty) throw new Error('Quantity is too large');

  // WEIGHT: (grams * price_per_kg) / 1000 ; PIECE/PACKAGE: qty * price.
  // Rounded half-up to the nearest minor unit (PRD 12). LBP line totals are NOT
  // rounded to 5,000 here: that only applies to the cash due (see roundLbp for change).
  const totalMinor =
    sellingUnit === 'WEIGHT'
      ? Math.floor((quantityMinor * unitPriceMinor + 500) / GRAMS_PER_KG)
      : quantityMinor * unitPriceMinor;
  if (totalMinor > maxMaxTotal) throw new Error('Line total is too large');
  return totalMinor;
}

/**
 * round(a * b / c) half-up using BigInt so the intermediate product can never lose
 * precision (a*b can exceed 2^53 for large LBP amounts). Used for proportional
 * refunds and cost reversals on partial returns.
 */
export function mulDivRound(a: number, b: number, c: number): number {
  if (![a, b, c].every((n) => Number.isSafeInteger(n)) || c <= 0 || a < 0 || b < 0) {
    throw new Error('mulDivRound: invalid arguments');
  }
  const num = BigInt(a) * BigInt(b);
  const den = BigInt(c);
  return Number((num * 2n + den) / (2n * den));
}

/**
 * Cost of a quantity at a per-unit cost (same rounding as computeLineTotal).
 */
export function computeLineCost(
  quantityMinor: number,
  unitCostMinor: number,
  sellingUnit: 'WEIGHT' | 'PACKAGE' | 'PIECE',
): number {
  return sellingUnit === 'WEIGHT'
    ? Math.floor((quantityMinor * unitCostMinor + 500) / GRAMS_PER_KG)
    : quantityMinor * unitCostMinor;
}

/**
 * Convert a per-unit COST between currencies WITHOUT cash rounding (5,000 rounding is
 * only for cash). Result is rounded half-up to the target minor unit.
 */
export function convertMinor(
  amountMinor: number,
  from: Currency,
  to: Currency,
  rate: number,
): number {
  if (from === to) return amountMinor;
  if (!Number.isSafeInteger(rate) || rate <= 0) throw new Error('convertMinor: invalid rate');
  if (from === 'USD') {
    // cents * rate / 100 = LBP
    return Math.floor((amountMinor * rate + 50) / 100);
  }
  return lbpToUsdCents(amountMinor, rate);
}

/**
 * Add two money amounts in the same currency (no conversion). Pure integer addition.
 */
export function addMoney(a: number, b: number): number {
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    throw new Error(`addMoney expected integers, got ${a} and ${b}`);
  }
  return a + b;
}

/**
 * Cash due when an LBP-denominated amount is settled with LBP cash only (PRD §17):
 * rounded UP to the next 5,000 (87,300 -> 90,000). Never applied to stored totals.
 */
export function lbpCashDue(totalLbp: number): number {
  return roundLbp(totalLbp);
}

/**
 * Payment breakdown (PRD 25, 26, 27).
 *
 * All comparisons are EXACT. Every amount is converted to a common integer unit,
 * "LBP x 100" (so 1 USD cent = `rate` units and 1 LBP = 100 units), which needs no
 * rounding and cannot drift:
 *
 *   value(usdCents, lbp) = usdCents * rate + lbp * 100
 *
 * Rounding happens only at two clearly defined boundaries:
 *   - LBP cash due   : roundLbp(owed LBP)            (PRD 17)
 *   - LBP change     : roundLbp(exact surplus in LBP) (PRD 17)
 *   - USD change     : surplus floored to whole cents (never give more than owed)
 */
export interface PaymentBreakdown {
  paidUsdCents: number;
  paidLbp: number;
  changeUsdCents: number;
  changeLbp: number;
  /** Exact amount owed expressed in LBP, rounded up to a whole pound (informational). */
  exactOwedLbp: number;
  /**
   * True when the customer tenders LBP cash only. Only then is the cash due rounded
   * (see `cashDueLbp`); mixed or USD tenders are compared exactly (policy D1).
   */
  lbpOnlyTender: boolean;
  /** Cash the customer must hand over: rounded up to 5,000 for LBP-only tenders, else exact. */
  cashDueLbp: number;
  // Informational USD-equivalents (rounded half-up to cents) for display only.
  totalPaidUsdEquivalentCents: number;
  totalOwedUsdEquivalentCents: number;
  isSufficient: boolean;
  /** Shortfall in USD cents, rounded UP so a tiny shortfall is never shown as $0.00. */
  shortfallUsdCents: number;
  /** Exact shortfall expressed in LBP, rounded up (display / credit helper). */
  shortfallLbp: number;
}

export function computePaymentBreakdown(params: {
  owedUsdCents: number;
  owedLbp: number;
  paidUsdCents: number;
  paidLbp: number;
  rate: number;
  changeCurrency: Currency;
}): PaymentBreakdown {
  const { owedUsdCents, owedLbp, paidUsdCents, paidLbp, rate, changeCurrency } =
    params;

  if (!Number.isSafeInteger(rate) || rate <= 0 || rate > MAX_RATE) {
    throw new Error(`computePaymentBreakdown: invalid rate ${rate}`);
  }
  for (const [name, v] of [
    ['owedUsdCents', owedUsdCents],
    ['owedLbp', owedLbp],
    ['paidUsdCents', paidUsdCents],
    ['paidLbp', paidLbp],
  ] as const) {
    if (!isSafeMoney(v)) throw new Error(`computePaymentBreakdown: invalid ${name}`);
  }
  if (owedUsdCents > MAX_USD_CENTS || paidUsdCents > MAX_USD_CENTS ||
      owedLbp > MAX_LBP || paidLbp > MAX_LBP) {
    throw new Error('computePaymentBreakdown: amount exceeds the supported maximum');
  }

  // POLICY D1 (see PRD §17):
  //  * Stored invoice totals and the internal balance are always EXACT.
  //  * The 5,000 LBP cash rounding applies only when the customer pays with LBP cash alone
  //    (87,300 LBP owed -> 90,000 LBP cash due). Payments that include USD are compared
  //    exactly, so nobody is overcharged because of rounding they did not choose.
  //  * LBP change handed back is rounded up to 5,000 (cash has no smaller notes).
  const owedUnits = owedUsdCents * rate + owedLbp * 100;
  const paidUnits = paidUsdCents * rate + paidLbp * 100;
  const exactOwedLbp = Math.ceil(owedUnits / 100);
  const lbpOnlyTender = paidUsdCents === 0 && paidLbp > 0;
  const cashDueLbp = lbpOnlyTender ? lbpCashDue(exactOwedLbp) : exactOwedLbp;
  const effectiveOwedUnits = lbpOnlyTender ? cashDueLbp * 100 : owedUnits;

  const isSufficient = paidUnits >= effectiveOwedUnits;
  const surplusUnits = Math.max(0, paidUnits - effectiveOwedUnits);
  // Debt / shortfall is always measured against the EXACT amount owed.
  const deficitUnits = Math.max(0, owedUnits - paidUnits);

  let changeUsdCents = 0;
  let changeLbp = 0;
  if (changeCurrency === 'USD') {
    changeUsdCents = Math.floor(surplusUnits / rate);
  } else {
    changeLbp = surplusUnits > 0 ? roundLbp(Math.floor(surplusUnits / 100)) : 0;
  }

  return {
    paidUsdCents,
    paidLbp,
    changeUsdCents,
    changeLbp,
    exactOwedLbp,
    lbpOnlyTender,
    cashDueLbp,
    totalPaidUsdEquivalentCents: Math.floor((paidUnits + Math.floor(rate / 2)) / rate),
    totalOwedUsdEquivalentCents: Math.floor((owedUnits + Math.floor(rate / 2)) / rate),
    isSufficient,
    shortfallUsdCents: Math.ceil(deficitUnits / rate),
    shortfallLbp: Math.ceil(deficitUnits / 100),
  };
}

/* ------------------------------------------------------------------ */
/* Display helpers                                                    */
/* ------------------------------------------------------------------ */

export function formatUsd(usdCents: number, locale = 'en-US'): string {
  const dollars = usdCents / 100;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(dollars);
}

export function formatLbp(lbp: number, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, {
    style: 'decimal',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(lbp) + ' LBP';
}

export function formatMoney(
  amountMinor: number,
  currency: Currency,
  locale = 'en-US',
): string {
  return currency === 'USD'
    ? formatUsd(amountMinor, locale)
    : formatLbp(amountMinor, locale);
}

/**
 * Format a weight given in grams as a KG decimal string.
 * Example: 1350 → "1.350"
 */
export function formatWeightKg(grams: number): string {
  if (!Number.isInteger(grams)) {
    throw new Error(`formatWeightKg expected integer grams, got ${grams}`);
  }
  const kg = grams / 1000;
  return kg.toFixed(3);
}

/**
 * Parse a user-entered decimal KG string into integer grams.
 * Accepts arbitrary precision (e.g. "1.350", "0.875", "10.750", "0.001").
 * Returns integer grams (e.g. 1350, 875, 10750, 1).
 *
 * Throws if input is invalid or negative.
 */
export function parseWeightKg(input: string): number {
  const trimmed = input.trim().replace(',', '.');
  if (!trimmed) {
    throw new Error('Weight is required');
  }
  // At most 3 decimals: the scale resolution is 1 gram. More digits are rejected
  // instead of silently rounded.
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(trimmed);
  if (!m) {
    throw new Error(`Invalid weight: ${input}`);
  }
  const grams = parseInt(m[1], 10) * GRAMS_PER_KG + parseInt((m[2] ?? '').padEnd(3, '0') || '0', 10);
  if (grams <= 0) {
    throw new Error('Weight must be positive');
  }
  if (grams > MAX_WEIGHT_GRAMS) {
    throw new Error('Weight is too large');
  }
  return grams;
}

/**
 * Parse a user-entered positive integer count (for PACKAGE / PIECE).
 */
export function parseQuantity(input: string): number {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Quantity is required');
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid quantity: ${input}`);
  }
  const q = parseInt(trimmed, 10);
  if (q <= 0) {
    throw new Error('Quantity must be positive');
  }
  if (q > MAX_PIECE_QUANTITY) {
    throw new Error('Quantity is too large');
  }
  return q;
}

/**
 * Parse a user-entered decimal money string in a given currency into minor units.
 *   USD: "$10.00" or "10.00" or "10" → 1000 cents
 *   LBP: "895000" or "895,000" → 895000 LBP
 */
export function parseMoney(input: string, currency: Currency): number {
  const trimmed = input.replace(/[,$\s]/g, '');
  if (!trimmed) {
    throw new Error('Amount is required');
  }
  if (currency === 'USD') {
    const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
    if (!m) {
      throw new Error(`Invalid USD amount: ${input}`);
    }
    const cents = parseInt(m[1], 10) * 100 + parseInt((m[2] ?? '').padEnd(2, '0') || '0', 10);
    if (!Number.isSafeInteger(cents) || cents > MAX_USD_CENTS) {
      throw new Error('Amount is too large');
    }
    return cents;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid LBP amount: ${input}`);
  }
  const lbp = parseInt(trimmed, 10);
  if (!Number.isSafeInteger(lbp) || lbp > MAX_LBP) {
    throw new Error('Amount is too large');
  }
  return lbp;
}

/**
 * Parse a decimal price-per-KG or per-unit string into minor units.
 *   USD: "4.50" → 450 cents per KG
 *   LBP: "800000" → 800000 LBP per KG
 */
export function parsePrice(input: string, currency: Currency): number {
  return parseMoney(input, currency);
}
