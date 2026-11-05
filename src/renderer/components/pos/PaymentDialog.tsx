/**
 * Payment dialog.
 *
 * PRD sections 25, 26, 27.
 *
 * UX flow:
 *   1. Show total owed (USD portion + LBP portion).
 *   2. Cashier enters USD paid and/or LBP paid.
 *   3. Selects change currency: USD or LBP.
 *   4. Live preview of change due.
 *   5. "Complete Sale" calls onComplete.
 */

import { useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import {
  formatUsd,
  formatLbp,
  parseMoney,
  computePaymentBreakdown,
  usdCentsToLbp,
  lbpToUsdCents,
  roundLbp,
  lbpCashDue,
} from '@shared/money/index';
import type { Currency } from '@shared/types/index';
import { useApi, unwrap } from '../../hooks/useApi';

interface Props {
  totals: { usdCents: number; lbp: number };
  onComplete: (payment: {
    paidUsdCents: number;
    paidLbp: number;
    changeCurrency: Currency;
    customerId?: number | null;
    allowCredit?: boolean;
  }) => void;
  busy?: boolean;
  onClose: () => void;
}

export default function PaymentDialog({ totals, onComplete, onClose, busy }: Props) {
  const { t } = useI18n();
  const { data: rateInfo } = useApi(() => window.posApi.getCurrentRate());
  const rate = unwrap(rateInfo)?.currentRate ?? 0;
  const { data: customersData } = useApi(() => window.posApi.listCustomers(true));
  const customers = unwrap(customersData) || [];
  const [onAccount, setOnAccount] = useState(false);
  const [customerId, setCustomerId] = useState<number | null>(null);

  const [paidUsdStr, setPaidUsdStr] = useState('');
  const [paidLbpStr, setPaidLbpStr] = useState('');
  const [changeCurrency, setChangeCurrency] = useState<Currency>('USD');
  const [error, setError] = useState<string | null>(null);

  const breakdown = useMemo(() => {
    let paidUsdCents = 0;
    let paidLbp = 0;
    try {
      if (paidUsdStr.trim()) {
        paidUsdCents = parseMoney(paidUsdStr, 'USD');
      }
      if (paidLbpStr.trim()) {
        paidLbp = parseMoney(paidLbpStr, 'LBP');
      }
    } catch {
      return null;
    }
    if (rate <= 0) return null;
    return computePaymentBreakdown({
      owedUsdCents: totals.usdCents,
      owedLbp: totals.lbp,
      paidUsdCents,
      paidLbp,
      rate,
      changeCurrency,
    });
  }, [paidUsdStr, paidLbpStr, changeCurrency, totals, rate]);

  // Quick-fill buttons: exact amount, rounded-up USD, rounded-up LBP
  const quickFillExact = () => {
    setPaidUsdStr((totals.usdCents / 100).toFixed(2));
    setPaidLbpStr(String(totals.lbp));
  };
  const quickFillRoundUsd = () => {
    // Total in USD equivalent, rounded up to next whole dollar
    const totalUsd = totals.usdCents + lbpToUsdCents(totals.lbp, rate);
    const roundedUp = Math.ceil(totalUsd / 100) * 100;
    setPaidUsdStr((roundedUp / 100).toFixed(2));
    setPaidLbpStr('');
  };
  const quickFillRoundLbp = () => {
    // Exact total in LBP, cash due rounded UP to 5,000 (policy D1)
    const exactLbp = breakdown?.exactOwedLbp ?? totals.lbp + usdCentsToLbp(totals.usdCents, rate);
    setPaidLbpStr(String(lbpCashDue(exactLbp)));
    setPaidUsdStr('');
  };

  const handleComplete = () => {
    setError(null);
    if (!breakdown) {
      setError(t('validation.invalidNumber'));
      return;
    }
    if (!breakdown.isSufficient && !(onAccount && customerId)) {
      setError(onAccount ? t('payment.selectCustomer') : t('payment.insufficient'));
      return;
    }
    let paidUsdCents = 0;
    let paidLbp = 0;
    try {
      if (paidUsdStr.trim()) paidUsdCents = parseMoney(paidUsdStr, 'USD');
      if (paidLbpStr.trim()) paidLbp = parseMoney(paidLbpStr, 'LBP');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    onComplete({
      paidUsdCents,
      paidLbp,
      changeCurrency,
      customerId: onAccount ? customerId : null,
      allowCredit: onAccount && !!customerId,
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <div className="modal-header">
          <h2>{t('payment.title')}</h2>
          <button className="btn btn-small" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        {/* Total owed */}
        <div
          style={{
            padding: 16,
            background: 'var(--color-primary-light)',
            borderRadius: 'var(--radius-md)',
            marginBottom: 16,
            textAlign: 'center',
          }}
        >
          <div className="text-muted" style={{ fontSize: 12, textTransform: 'uppercase' }}>
            {t('payment.total')}
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, marginTop: 4 }}>
            {totals.usdCents > 0 && formatUsd(totals.usdCents)}
            {totals.usdCents > 0 && totals.lbp > 0 && ' + '}
            {totals.lbp > 0 && formatLbp(totals.lbp)}
          </div>
        </div>

        {/* Quick-fill buttons */}
        <div className="flex gap-8 mb-16">
          <button className="btn btn-small" onClick={quickFillExact}>
            {t('payment.exact')}
          </button>
          <button className="btn btn-small" onClick={quickFillRoundUsd}>
            Round $↑
          </button>
          <button className="btn btn-small" onClick={quickFillRoundLbp}>
            Round LBP↑
          </button>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>{t('payment.paidUsd')}</label>
            <input
              className="form-control"
              value={paidUsdStr}
              onChange={(e) => setPaidUsdStr(e.target.value)}
              placeholder="$0.00"
              inputMode="decimal"
            />
          </div>
          <div className="form-group">
            <label>{t('payment.paidLbp')}</label>
            <input
              className="form-control"
              value={paidLbpStr}
              onChange={(e) => setPaidLbpStr(e.target.value)}
              placeholder="0"
              inputMode="numeric"
            />
          </div>
        </div>

        {/* Change currency selector */}
        <div className="form-group">
          <label>{t('payment.returnIn')}</label>
          <div className="flex gap-8">
            <button
              className={`btn ${changeCurrency === 'USD' ? 'btn-primary' : ''}`}
              onClick={() => setChangeCurrency('USD')}
              style={{ flex: 1 }}
            >
              {t('payment.usd')}
            </button>
            <button
              className={`btn ${changeCurrency === 'LBP' ? 'btn-primary' : ''}`}
              onClick={() => setChangeCurrency('LBP')}
              style={{ flex: 1 }}
            >
              {t('payment.lbp')}
            </button>
          </div>
        </div>

        {/* Amounts: exact owed, rounded LBP cash due, received, change */}
        {breakdown && (
          <div className="text-muted" style={{ fontSize: 13, marginBottom: 8 }}>
            <div className="flex-between">
              <span>{t('payment.owedExact')}</span>
              <span>{formatUsd(breakdown.totalOwedUsdEquivalentCents)} ≈ {formatLbp(breakdown.exactOwedLbp)} LBP</span>
            </div>
            <div className="flex-between">
              <span>{t('payment.cashDueLbp')}</span>
              <span>{formatLbp(breakdown.cashDueLbp)} LBP</span>
            </div>
            <div className="flex-between">
              <span>{t('payment.received')}</span>
              <span>
                {formatUsd(breakdown.paidUsdCents)} + {formatLbp(breakdown.paidLbp)} LBP
              </span>
            </div>
            <small>{t('payment.roundingNote')}</small>
          </div>
        )}

        {/* Change preview */}
        {breakdown && (
          <div
            style={{
              padding: 12,
              background: breakdown.isSufficient
                ? 'var(--color-success-light)'
                : 'var(--color-danger-light)',
              borderRadius: 'var(--radius-md)',
              marginBottom: 16,
            }}
          >
            <div className="flex-between" style={{ marginBottom: 6 }}>
              <span>{t('payment.change')}:</span>
              <strong>
                {breakdown.changeUsdCents > 0 && formatUsd(breakdown.changeUsdCents)}
                {breakdown.changeLbp > 0 && formatLbp(breakdown.changeLbp)}
                {breakdown.changeUsdCents === 0 && breakdown.changeLbp === 0 && '—'}
              </strong>
            </div>
            {!breakdown.isSufficient && (
              <div className="text-danger" style={{ fontSize: 12 }}>
                {t('payment.insufficient')} — {t('payment.shortfall')} {formatUsd(breakdown.shortfallUsdCents)}
              </div>
            )}
          </div>
        )}

        {breakdown && !breakdown.isSufficient && (
          <div className="form-group">
            <label>
              <input
                type="checkbox"
                checked={onAccount}
                onChange={(e) => setOnAccount(e.target.checked)}
              />{' '}
              {t('payment.onAccount')}
            </label>
            {onAccount && (
              <select
                className="form-control"
                value={customerId ?? ''}
                onChange={(e) => setCustomerId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">{t('payment.selectCustomer')}</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        <div className="modal-footer">
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-success btn-large"
            onClick={handleComplete}
            disabled={busy || !breakdown || (!breakdown.isSufficient && !(onAccount && customerId))}
          >
            {t('payment.completeSale')}
          </button>
        </div>
      </div>
    </div>
  );
}
