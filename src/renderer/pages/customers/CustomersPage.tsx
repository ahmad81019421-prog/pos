import { useState } from 'react';
import { useI18n } from '../../i18n';
import { useApi, unwrap, isError } from '../../hooks/useApi';
import {
  formatLbp,
  formatUsd,
  parseMoney,
  roundLbp,
  usdCentsToLbpExact,
} from '@shared/money/index';
import type { CustomerDTO, Currency, ExchangeRateInfo } from '@shared/types/index';

export default function CustomersPage() {
  const { t } = useI18n();
  const { data, reload } = useApi<CustomerDTO[]>(() => window.posApi.listCustomers(false));
  const { data: rateData } = useApi<ExchangeRateInfo>(() => window.posApi.getCurrentRate());
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [payFor, setPayFor] = useState<CustomerDTO | null>(null);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [settleRemainder, setSettleRemainder] = useState(false);
  const customers = unwrap(data) || [];
  const rate = unwrap(rateData)?.currentRate ?? null;
  const exactDebtLbp =
    payFor && rate
      ? usdCentsToLbpExact(payFor.balanceUsdCents, rate)
      : null;
  const roundedDebtLbp =
    exactDebtLbp === null ? null : roundLbp(Math.ceil(exactDebtLbp));
  const roundingDifferenceLbp =
    exactDebtLbp === null || roundedDebtLbp === null
      ? null
      : roundedDebtLbp - Math.ceil(exactDebtLbp);

  const add = async () => {
    setError(null);
    const r = await window.posApi.createCustomer({ name, phone: phone || undefined });
    if (isError(r)) return setError(r.error.userMessage);
    setName('');
    setPhone('');
    reload();
  };

  const pay = async () => {
    if (!payFor) return;
    setError(null);
    let amountMinor: number;
    try {
      amountMinor = parseMoney(amount, currency);
    } catch (e) {
      return setError(e instanceof Error ? e.message : String(e));
    }
    const r = await window.posApi.recordCustomerPayment({
      customerId: payFor.id,
      currency,
      amountMinor,
      settleRemainder,
    });
    if (isError(r)) return setError(r.error.userMessage);
    setPayFor(null);
    setAmount('');
    reload();
  };

  return (
    <div>
      <div className="page-header">
        <h1>{t('nav.customers')}</h1>
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="form-row mb-16">
        <input className="form-control" placeholder={t('customers.name')} value={name} onChange={(e) => setName(e.target.value)} />
        <input className="form-control" placeholder={t('customers.phone')} value={phone} onChange={(e) => setPhone(e.target.value)} />
        <button className="btn btn-primary" onClick={add} disabled={!name.trim()}>
          {t('common.add')}
        </button>
      </div>
      {customers.length === 0 ? (
        <div className="empty-state">{t('common.noData')}</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('customers.name')}</th>
              <th>{t('customers.phone')}</th>
              <th style={{ textAlign: 'end' }}>{t('customers.balance')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.phone}</td>
                <td style={{ textAlign: 'end' }}>{formatUsd(c.balanceUsdCents)}</td>
                <td>
                  {c.balanceUsdCents > 0 && (
                    <button
                      className="btn btn-small"
                      onClick={() => {
                        setPayFor(c);
                        setAmount('');
                        setCurrency('USD');
                        setSettleRemainder(false);
                      }}
                    >
                      {t('customers.recordPayment')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {payFor && (
        <div className="modal-overlay" onClick={() => setPayFor(null)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>
                {t('customers.recordPayment')} — {payFor.name}
              </h2>
            </div>
            <div className="text-muted mb-16">
              {t('customers.balance')}: {formatUsd(payFor.balanceUsdCents)}
            </div>
            {currency === 'LBP' && (
              <div className="text-muted mb-16">
                {t('customers.exactDebtLbp')}:{' '}
                {exactDebtLbp === null
                  ? t('common.loading')
                  : `${exactDebtLbp.toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    })} LBP`}
              </div>
            )}
            <div className="form-group">
              <label>{t('customers.paymentAmount')}</label>
              <input
                className="form-control"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                autoFocus
                readOnly={settleRemainder}
              />
            </div>
            <div className="flex gap-8 mb-16">
              {(['USD', 'LBP'] as Currency[]).map((c) => (
                <button
                  key={c}
                  className={`btn ${currency === c ? 'btn-primary' : ''}`}
                  style={{ flex: 1 }}
                  onClick={() => {
                    setCurrency(c);
                    setAmount('');
                    setSettleRemainder(false);
                  }}
                >
                  {c}
                </button>
              ))}
            </div>
            {currency === 'LBP' && (
              <div className="form-group">
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={settleRemainder}
                    disabled={roundedDebtLbp === null || rate === null}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setSettleRemainder(checked);
                      setAmount(
                        checked && roundedDebtLbp !== null
                          ? String(roundedDebtLbp)
                          : '',
                      );
                    }}
                  />
                  {t('customers.settleRounded')}
                </label>
                {settleRemainder &&
                  roundedDebtLbp !== null &&
                  roundingDifferenceLbp !== null && (
                    <div className="text-muted" style={{ marginTop: 8 }}>
                      <div>
                        {t('customers.cashRequired')}: {formatLbp(roundedDebtLbp)}
                      </div>
                      <div>
                        {t('customers.roundingDifference')}:{' '}
                        {roundingDifferenceLbp.toLocaleString(undefined, {
                          maximumFractionDigits: 2,
                        })}{' '}
                        LBP
                      </div>
                    </div>
                  )}
              </div>
            )}
            <div className="modal-footer">
              <button className="btn" onClick={() => setPayFor(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn btn-success" onClick={pay}>
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
