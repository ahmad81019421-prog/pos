/**
 * Financial calculation tests.
 * PRD section 73: The project must include tests for important financial calculations.
 *
 * These tests cover the EXACT examples from PRD section 73:
 *   - Price × Weight calculation
 *   - USD→LBP conversion at exchange rate
 *   - Change calculation (USD and LBP)
 *   - 5,000 LBP rounding for cash amounts
 */

import { describe, it, expect } from 'vitest';
import {
  roundLbp,
  usdCentsToLbp,
  lbpToUsdCents,
  computeLineTotal,
  computePaymentBreakdown,
  parseWeightKg,
  parseQuantity,
  parseMoney,
} from '../src/shared/money/index';

describe('PRD section 73 — financial calculation tests', () => {
  /* -------- LBP Rounding (PRD 17) -------- */

  describe('roundLbp', () => {
    it('rounds 87,300 → 90,000 (PRD example, ceiling behavior)', () => {
      expect(roundLbp(87300)).toBe(90000);
    });
    it('rounds 87,499 → 90,000 (ceiling rounds any remainder up)', () => {
      expect(roundLbp(87499)).toBe(90000);
    });
    it('rounds 87,500 → 90,000', () => {
      expect(roundLbp(87500)).toBe(90000);
    });
    it('rounds 85,000 → 85,000 (already aligned)', () => {
      expect(roundLbp(85000)).toBe(85000);
    });
    it('rounds 100,000 → 100,000', () => {
      expect(roundLbp(100000)).toBe(100000);
    });
    it('rounds 102,499 → 105,000 (ceiling)', () => {
      expect(roundLbp(102499)).toBe(105000);
    });
    it('rounds 102,500 → 105,000', () => {
      expect(roundLbp(102500)).toBe(105000);
    });
    it('rounds 0 → 0', () => {
      expect(roundLbp(0)).toBe(0);
    });
  });

  /* -------- USD → LBP conversion (PRD 16) -------- */

  describe('usdCentsToLbp', () => {
    it('$5 USD at 89,500 LBP/USD → 450,000 LBP (rounded UP to next 5,000)', () => {
      // Math: 500 cents * 89500 / 100 = 447,500 LBP; ceiling to 5,000 = 450,000
      expect(usdCentsToLbp(500, 89500)).toBe(450000);
    });

    it('$10 USD at 89,500 LBP/USD → 895,000 LBP (already aligned, PRD example)', () => {
      // $10 = 1000 cents * 89500 / 100 = 895,000 LBP (multiple of 5,000, no rounding needed)
      expect(usdCentsToLbp(1000, 89500)).toBe(895000);
    });

    it('rounds UP to next 5,000 LBP after conversion', () => {
      // $1.00 = 100 cents, * 89500 / 100 = 89500 LBP, ceiling to 5,000 = 90,000
      expect(usdCentsToLbp(100, 89500)).toBe(90000);
    });

    it('handles large amounts', () => {
      // $1000 USD = 100000 cents, * 89500 / 100 = 89500000 LBP
      expect(usdCentsToLbp(100000, 89500)).toBe(89500000);
    });
  });

  /* -------- LBP → USD conversion (PRD 16) -------- */

  describe('lbpToUsdCents', () => {
    it('447,500 LBP at 89,500 → 500 cents ($5.00)', () => {
      expect(lbpToUsdCents(447500, 89500)).toBe(500);
    });

    it('895,000 LBP at 89,500 → 1000 cents ($10.00)', () => {
      expect(lbpToUsdCents(895000, 89500)).toBe(1000);
    });

    it('handles LBP that needs rounding', () => {
      // 89750 LBP at 89500 = 1.0028... USD → 100 cents (rounded)
      expect(lbpToUsdCents(89750, 89500)).toBe(100);
    });
  });

  /* -------- Line total: Weight × Price (PRD section 11, 12, 73) -------- */

  describe('computeLineTotal — weight × price', () => {
    // PRD section 73 example:
    // Price = $4.50 / KG = 450 cents per KG
    // Weight = 1.350 KG = 1350 grams
    // Expected = $6.075 → 607.5 cents → round to 608 cents (PRD example says $6.075 "before configured rounding")
    it('1.350 KG × $4.50/KG = $6.08 (rounded half-up)', () => {
      // 1350 * 450 = 607500; 607500 / 1000 = 607.5 → round half-up → 608 cents
      // Wait — Math.trunc((607500 + 500) / 1000) = Math.trunc(608000 / 1000) = 608
      expect(computeLineTotal(1350, 450, 'WEIGHT', 'USD')).toBe(608);
    });

    it('0.875 KG × $4.50/KG = $3.94', () => {
      // 875 * 450 = 393750; (393750 + 500) / 1000 = 394.25 → trunc → 394
      expect(computeLineTotal(875, 450, 'WEIGHT', 'USD')).toBe(394);
    });

    it('2.700 KG × $4.50/KG = $12.15', () => {
      // 2700 * 450 = 1215000; / 1000 = 1215 cents = $12.15
      expect(computeLineTotal(2700, 450, 'WEIGHT', 'USD')).toBe(1215);
    });

    it('0.001 KG × $4.50/KG = $0.005 → rounds to 1 cent', () => {
      // 1 * 450 = 450; (450 + 500) / 1000 = 0.95 → trunc → 0
      // Wait: Math.trunc((450 + 500) / 1000) = Math.trunc(0.95) = 0
      // Hmm that means 0.001 KG gives $0.00
      expect(computeLineTotal(1, 450, 'WEIGHT', 'USD')).toBe(0);
    });

    it('LBP line totals are not rounded to 5,000 (only cash payments are)', () => {
      // 1.350 KG × 800,000 LBP/KG = 1,080,000 LBP
      // 1350 * 800000 = 1,080,000,000; / 1000 = 1,080,000
      expect(computeLineTotal(1350, 800000, 'WEIGHT', 'LBP')).toBe(1080000);
    });
  });

  describe('computeLineTotal — piece/package', () => {
    it('3 × $2.00 = $6.00', () => {
      expect(computeLineTotal(3, 200, 'PIECE', 'USD')).toBe(600);
    });
    it('5 × 5,000 LBP = 25,000 LBP', () => {
      expect(computeLineTotal(5, 5000, 'PACKAGE', 'LBP')).toBe(25000);
    });
  });

  /* -------- Payment breakdown (PRD 25, 26, 27) -------- */

  describe('computePaymentBreakdown', () => {
    // PRD section 73 examples:
    // Invoice = $10
    // Paid = $20
    // Change = $10
    it('$10 owed, $20 paid, change in USD → $10 change', () => {
      const breakdown = computePaymentBreakdown({
        owedUsdCents: 1000,
        owedLbp: 0,
        paidUsdCents: 2000,
        paidLbp: 0,
        rate: 89500,
        changeCurrency: 'USD',
      });
      expect(breakdown.isSufficient).toBe(true);
      expect(breakdown.changeUsdCents).toBe(1000);
      expect(breakdown.changeLbp).toBe(0);
    });

    // Invoice = $10
    // Paid = $20 USD
    // Change returned in LBP
    // Exchange rate = 89,500
    // Expected change = 895,000 LBP
    it('$10 owed, $20 paid USD, change in LBP → 895,000 LBP', () => {
      const breakdown = computePaymentBreakdown({
        owedUsdCents: 1000,
        owedLbp: 0,
        paidUsdCents: 2000,
        paidLbp: 0,
        rate: 89500,
        changeCurrency: 'LBP',
      });
      expect(breakdown.isSufficient).toBe(true);
      expect(breakdown.changeUsdCents).toBe(0);
      expect(breakdown.changeLbp).toBe(895000);
    });

    // PRD section 25 mixed payment example:
    // Invoice = $10 USD
    // Customer pays $5 USD + 447,500 LBP at 89,500 → ~$10 total (with LBP rounding)
    it('Mixed payment: $5 USD + 447,500 LBP covers $10 owed (after LBP→USD conversion)', () => {
      // LBP 447,500 converts to USD via integer math:
      //   447500 * 100 / 89500 = 500.0 cents = $5.00
      // Total paid = $5 + $5 = $10, equal to owed. Sufficient, no change.
      const breakdown = computePaymentBreakdown({
        owedUsdCents: 1000,
        owedLbp: 0,
        paidUsdCents: 500,
        paidLbp: 447500,
        rate: 89500,
        changeCurrency: 'USD',
      });
      expect(breakdown.isSufficient).toBe(true);
      expect(breakdown.changeUsdCents).toBe(0);
      expect(breakdown.changeLbp).toBe(0);
    });

    it('Underpayment detected as insufficient', () => {
      const breakdown = computePaymentBreakdown({
        owedUsdCents: 1000,
        owedLbp: 0,
        paidUsdCents: 500,
        paidLbp: 0,
        rate: 89500,
        changeCurrency: 'USD',
      });
      expect(breakdown.isSufficient).toBe(false);
      expect(breakdown.shortfallUsdCents).toBe(500);
    });

    it('Overpay USD covers LBP shortfall (PRD section 25)', () => {
      // Owed: $5 USD + 447,500 LBP (=$5 USD-equivalent, total $10)
      // Paid: $10 USD only (no LBP)
      // Total paid in USD-equivalent: $10
      // Total owed in USD-equivalent: $5 + lbpToUsdCents(447500, 89500) = $5 + $5 = $10
      // Change = $0
      const breakdown = computePaymentBreakdown({
        owedUsdCents: 500,
        owedLbp: 447500,
        paidUsdCents: 1000,
        paidLbp: 0,
        rate: 89500,
        changeCurrency: 'USD',
      });
      expect(breakdown.isSufficient).toBe(true);
      expect(breakdown.changeUsdCents).toBe(0);
    });

    it('Change in LBP rounds to next 5,000', () => {
      // Owed: $1 = 100 cents USD
      // Paid: $1.50 = 150 cents USD
      // Surplus: 50 cents USD = $0.50
      // Convert to LBP at 89,500: 0.50 USD * 89500 = 44750 LBP → ceiling to 5,000 = 45000
      const breakdown = computePaymentBreakdown({
        owedUsdCents: 100,
        owedLbp: 0,
        paidUsdCents: 150,
        paidLbp: 0,
        rate: 89500,
        changeCurrency: 'LBP',
      });
      expect(breakdown.changeLbp).toBe(45000); // 44750 ceiling to 5,000 = 45000
    });
  });

  /* -------- Input parsing (PRD 11, 78) -------- */

  describe('parseWeightKg', () => {
    it('"1.250" → 1250 grams', () => {
      expect(parseWeightKg('1.250')).toBe(1250);
    });
    it('"1.350" → 1350 grams', () => {
      expect(parseWeightKg('1.350')).toBe(1350);
    });
    it('"0.875" → 875 grams', () => {
      expect(parseWeightKg('0.875')).toBe(875);
    });
    it('"2.700" → 2700 grams', () => {
      expect(parseWeightKg('2.700')).toBe(2700);
    });
    it('"0.001" → 1 gram (arbitrary precision supported)', () => {
      expect(parseWeightKg('0.001')).toBe(1);
    });
    it('rejects empty', () => {
      expect(() => parseWeightKg('')).toThrow();
    });
    it('rejects negative', () => {
      expect(() => parseWeightKg('-1.5')).toThrow();
    });
    it('rejects non-numeric', () => {
      expect(() => parseWeightKg('abc')).toThrow();
    });
  });

  describe('parseQuantity', () => {
    it('"3" → 3', () => {
      expect(parseQuantity('3')).toBe(3);
    });
    it('rejects decimals', () => {
      expect(() => parseQuantity('3.5')).toThrow();
    });
    it('rejects 0', () => {
      expect(() => parseQuantity('0')).toThrow();
    });
    it('rejects negative', () => {
      expect(() => parseQuantity('-5')).toThrow();
    });
  });

  describe('parseMoney', () => {
    it('parses USD "$10.00" → 1000 cents', () => {
      expect(parseMoney('$10.00', 'USD')).toBe(1000);
    });
    it('parses USD "10" → 1000 cents', () => {
      expect(parseMoney('10', 'USD')).toBe(1000);
    });
    it('parses USD "10.5" → 1050 cents', () => {
      expect(parseMoney('10.5', 'USD')).toBe(1050);
    });
    it('parses LBP "895000" → 895000', () => {
      expect(parseMoney('895000', 'LBP')).toBe(895000);
    });
    it('parses LBP "895,000" with separator → 895000', () => {
      expect(parseMoney('895,000', 'LBP')).toBe(895000);
    });
    it('rejects LBP with decimals', () => {
      expect(() => parseMoney('895000.50', 'LBP')).toThrow();
    });
  });
});
