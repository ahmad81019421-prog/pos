import { useState } from 'react';
import { useI18n } from '../../i18n';
import { useApi, unwrap } from '../../hooks/useApi';
import {
  formatUsd,
  formatLbp,
  parseMoney,
} from '@shared/money/index';
import { EXPENSE_CATEGORIES } from '@shared/constants/index';
import type { ExpenseDTO, Currency, ExpensePaymentSource } from '@shared/types/index';

export default function ExpensesPage() {
  const { t } = useI18n();
  const { data, reload } = useApi<ExpenseDTO[]>(() =>
    window.posApi.listExpenses({ limit: 500 }),
  );
  const [adding, setAdding] = useState(false);

  const expenses = unwrap(data) || [];

  const totalUsd = expenses.reduce(
    (s, e) => s + e.amountUsdEquivalentCents,
    0,
  );
  const cashPaidUsd = expenses.reduce(
    (s, e) => s + (e.paymentSource === 'CASH' ? e.amountUsdEquivalentCents : 0),
    0,
  );
  const ownerPaidUsd = expenses.reduce(
    (s, e) => s + (e.paymentSource === 'OWNER' ? e.amountUsdEquivalentCents : 0),
    0,
  );
  const unclassifiedUsd = expenses.reduce(
    (s, e) => s + (e.paymentSource === null ? e.amountUsdEquivalentCents : 0),
    0,
  );

  return (
    <div>
      <div className="page-header">
        <h1>{t('expenses.title')}</h1>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          + {t('expenses.add')}
        </button>
      </div>

      <div className="alert alert-warning mb-16">
        <strong>{t('reports.expenses')}:</strong> {formatUsd(totalUsd)}
        <div>{t('expenses.paidFromCash')}: {formatUsd(cashPaidUsd)}</div>
        <div>{t('expenses.paidByOwner')}: {formatUsd(ownerPaidUsd)}</div>
        {unclassifiedUsd > 0 && (
          <div>{t('expenses.legacySourceUnknown')}: {formatUsd(unclassifiedUsd)}</div>
        )}
      </div>

      {expenses.length === 0 ? (
        <div className="empty-state">
          <div className="icon">💸</div>
          <div>{t('common.noData')}</div>
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('expenses.date')}</th>
              <th>{t('expenses.description')}</th>
              <th>{t('expenses.category')}</th>
              <th>{t('expenses.amount')}</th>
              <th>{t('expenses.paymentSource')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {expenses.map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.date * 1000).toLocaleDateString()}</td>
                <td>{e.description}</td>
                <td>
                  {EXPENSE_CATEGORIES.find((c) => c.value === e.category)?.enLabel || e.category}
                </td>
                <td>
                  {e.currency === 'USD'
                    ? formatUsd(e.amountMinor)
                    : formatLbp(e.amountMinor)}
                </td>
                <td>
                  {e.paymentSource === 'CASH'
                    ? t('expenses.paidFromCash')
                    : e.paymentSource === 'OWNER'
                      ? t('expenses.paidByOwner')
                      : t('expenses.legacySourceUnknown')}
                </td>
                <td>
                  <button
                    className="btn btn-small btn-danger"
                    onClick={async () => {
                      if (confirm(t('common.delete') + '?')) {
                        await window.posApi.deleteExpense(e.id);
                        reload();
                      }
                    }}
                  >
                    {t('common.delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {adding && (
        <AddExpenseDialog
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function AddExpenseDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [paymentSource, setPaymentSource] = useState<ExpensePaymentSource | ''>('');
  const [category, setCategory] = useState('OTHER');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    if (!description.trim()) {
      setError(t('validation.required'));
      return;
    }
    if (!paymentSource) {
      setError(t('expenses.paymentSourceRequired'));
      return;
    }
    try {
      const amountMinor = parseMoney(amount, currency);
      if (amountMinor <= 0) {
        setError(t('validation.positiveNumber'));
        return;
      }
      const result = await window.posApi.createExpense({
        date: Math.floor(new Date(date + 'T12:00:00').getTime() / 1000),
        description: description.trim(),
        amountMinor,
        currency,
        paymentSource,
        category,
        notes: notes.trim() || undefined,
      });
      if (result && 'error' in result) {
        setError(result.error.userMessage);
        return;
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('expenses.add')}</h2>
          <button className="btn btn-small" onClick={onClose}>
            ✕
          </button>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-group">
          <label>{t('expenses.date')}</label>
          <input
            type="date"
            className="form-control"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label>{t('expenses.description')} *</label>
          <input
            className="form-control"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            autoFocus
          />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>{t('expenses.amount')} *</label>
            <input
              className="form-control"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="50.00"
            />
          </div>
          <div className="form-group">
            <label>{t('expenses.currency')}</label>
            <select
              className="form-control"
              value={currency}
              onChange={(e) => setCurrency(e.target.value as Currency)}
            >
              <option value="USD">USD</option>
              <option value="LBP">LBP</option>
            </select>
          </div>
        </div>
        <fieldset className="form-group">
          <legend>{t('expenses.paymentSource')} *</legend>
          <label className="flex gap-8 mb-8">
            <input
              type="radio"
              name="expense-payment-source"
              value="CASH"
              checked={paymentSource === 'CASH'}
              onChange={() => setPaymentSource('CASH')}
            />
            {t('expenses.paidFromCash')}
          </label>
          <label className="flex gap-8">
            <input
              type="radio"
              name="expense-payment-source"
              value="OWNER"
              checked={paymentSource === 'OWNER'}
              onChange={() => setPaymentSource('OWNER')}
            />
            {t('expenses.paidByOwner')}
          </label>
        </fieldset>
        <div className="form-group">
          <label>{t('expenses.category')}</label>
          <select
            className="form-control"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.enLabel}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>{t('expenses.notes')}</label>
          <textarea
            className="form-control"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
          />
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={handleSave}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
