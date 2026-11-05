import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { isError, useApi, unwrap } from '../../hooks/useApi';
import { formatLbp, formatUsd } from '@shared/money/index';
import { InventoryReportTab, ReturnsReportTab } from './InventoryReportTab';
import { getRange, getCustomRange } from '@shared/dates/index';
import type {
  SalesReport,
  DateRange,
  BestSellingProductDTO,
  CashBalanceDTO,
} from '@shared/types/index';

type RangeKey = 'today' | 'yesterday' | 'week' | 'month' | 'custom';

function parseUsdCents(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(value.trim());
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

export default function ReportsPage() {
  const { t } = useI18n();
  const [rangeKey, setRangeKey] = useState<RangeKey>('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  // Single shared implementation (same one the tests cover): Monday-first week, full last day.
  const range: DateRange | null =
    rangeKey === 'custom'
      ? customFrom && customTo
        ? getCustomRange(customFrom, customTo)
        : null
      : getRange(rangeKey);
  const [tab, setTab] = useState<'sales' | 'inventory' | 'returns'>('sales');
  const rangeError = rangeKey === 'custom' && customFrom && customTo && !range;

  const { data: reportData, loading, error: reportError } = useApi<SalesReport>(
    async () => (range ? window.posApi.getSalesReport(range) : Promise.resolve({} as SalesReport)),
    [range?.from, range?.to],
  );
  const {
    data: currentCustomerDebt,
    loading: debtLoading,
    error: debtError,
  } = useApi<number>(() => window.posApi.getCurrentCustomerDebt());
  const {
    data: cashBalance,
    loading: cashLoading,
    error: cashError,
    reload: reloadCashBalance,
  } = useApi<CashBalanceDTO>(() => window.posApi.getCashBalance());
  const [openingCashInput, setOpeningCashInput] = useState('');
  const [cashSaving, setCashSaving] = useState(false);
  const [cashSaveError, setCashSaveError] = useState<string | null>(null);
  const [confirmZeroCash, setConfirmZeroCash] = useState(false);
  useEffect(() => {
    if (cashBalance) {
      setOpeningCashInput((cashBalance.openingBalanceUsdCents / 100).toFixed(2));
    }
  }, [cashBalance?.openingBalanceUsdCents]);

  async function saveOpeningCashBalance(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountUsdCents = parseUsdCents(openingCashInput);
    if (amountUsdCents === null) {
      setCashSaveError(t('reports.cashOpeningBalanceInvalid'));
      return;
    }
    setCashSaving(true);
    setCashSaveError(null);
    try {
      const result = await window.posApi.setCashOpeningBalance(amountUsdCents);
      if (isError(result)) {
        setCashSaveError(result.error.userMessage);
        return;
      }
      reloadCashBalance();
    } catch (error) {
      setCashSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setCashSaving(false);
    }
  }
  async function handleZeroCashBalance() {
    setCashSaving(true);
    setCashSaveError(null);
    try {
      if (typeof window.posApi.zeroCashBalance !== 'function') {
        setCashSaveError(t('reports.updateRequired'));
        setConfirmZeroCash(false);
        return;
      }
      const result = await window.posApi.zeroCashBalance();
      if (isError(result)) {
        setCashSaveError(result.error.userMessage);
        return;
      }
      setConfirmZeroCash(false);
      reloadCashBalance();
    } catch (error) {
      setCashSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setCashSaving(false);
    }
  }
  const { data: bestSelling } = useApi<BestSellingProductDTO[]>(
    async () => (range ? window.posApi.getBestSelling(range, 10) : Promise.resolve([])),
    [range?.from, range?.to],
  );

  const { data: byCategory } = useApi<Array<{ categoryName: string; totalUsdEquivalentCents: number }>>(
    async () =>
      (range ? window.posApi.getSalesByCategory(range) : Promise.resolve([])) as Promise<
        Array<{ categoryName: string; totalUsdEquivalentCents: number }> | { error: import('@shared/types/index').AppError }
      >,
    [range?.from, range?.to],
  );
  const report = unwrap(reportData);

  return (
    <div>
      <div className="page-header">
        <h1>{t('reports.title')}</h1>
      </div>

      {debtError && <div className="alert alert-error">{debtError.userMessage}</div>}
      {cashError && <div className="alert alert-error">{cashError.userMessage}</div>}
      {reportError && <div className="alert alert-error">{reportError.userMessage}</div>}
      <div className="stat-grid mb-16">
        <div className="stat-card">
          <div className="label">{t('reports.currentCustomerDebt')}</div>
          <div className="value">
            {debtLoading || currentCustomerDebt === null
              ? t('common.loading')
              : formatUsd(currentCustomerDebt)}
          </div>
        </div>
        <div className="stat-card">
          <div className="label">{t('reports.cashBalance')}</div>
          <div className="value">
            {cashLoading
              ? t('common.loading')
              : cashBalance
                ? formatUsd(cashBalance.currentBalanceUsdCents)
                : t('common.error')}
          </div>
          {cashBalance && (
            <>
              <div className="label">{formatLbp(cashBalance.currentBalanceLbp)}</div>
              <form onSubmit={saveOpeningCashBalance} className="mt-8">
                <label className="label" htmlFor="cash-opening-balance">
                  {t('reports.cashOpeningBalance')}
                </label>
                <div className="flex gap-8">
                  <input
                    id="cash-opening-balance"
                    type="number"
                    min="0"
                    step="0.01"
                    className="form-control"
                    value={openingCashInput}
                    onChange={(event) => setOpeningCashInput(event.target.value)}
                    disabled={cashSaving}
                  />
                  <button className="btn btn-small" type="submit" disabled={cashSaving}>
                    {t('reports.saveCashOpeningBalance')}
                  </button>
                </div>
                {cashSaveError && <div className="alert alert-error">{cashSaveError}</div>}
                <button
                  className="btn btn-small btn-danger mt-8"
                  type="button"
                  onClick={() => setConfirmZeroCash(true)}
                  disabled={cashSaving}
                >
                  {t('reports.zeroCashBalance')}
                </button>
              </form>
            </>
          )}
        </div>
      </div>

      {/* Range selector */}
      <div className="flex gap-8 mb-16" style={{ flexWrap: 'wrap' }}>
        <button
          className={`btn btn-small ${rangeKey === 'today' ? 'btn-primary' : ''}`}
          onClick={() => setRangeKey('today')}
        >
          {t('reports.today')}
        </button>
        <button
          className={`btn btn-small ${rangeKey === 'yesterday' ? 'btn-primary' : ''}`}
          onClick={() => setRangeKey('yesterday')}
        >
          {t('reports.yesterday')}
        </button>
        <button
          className={`btn btn-small ${rangeKey === 'week' ? 'btn-primary' : ''}`}
          onClick={() => setRangeKey('week')}
        >
          {t('reports.thisWeek')}
        </button>
        <button
          className={`btn btn-small ${rangeKey === 'month' ? 'btn-primary' : ''}`}
          onClick={() => setRangeKey('month')}
        >
          {t('reports.thisMonth')}
        </button>
        <button
          className={`btn btn-small ${rangeKey === 'custom' ? 'btn-primary' : ''}`}
          onClick={() => setRangeKey('custom')}
        >
          {t('reports.customRange')}
        </button>
      </div>

      {rangeKey === 'custom' && (
        <div className="form-row mb-16">
          <div className="form-group">
            <label>{t('reports.from')}</label>
            <input
              type="date"
              className="form-control"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>{t('reports.to')}</label>
            <input
              type="date"
              className="form-control"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
            />
          </div>
        </div>
      )}

      <div className="tabs">
        {(['sales', 'inventory', 'returns'] as const).map((k) => (
          <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
            {t(`reports.tab.${k}`)}
          </button>
        ))}
      </div>
      {tab === 'inventory' && <InventoryReportTab range={range} />}
      {tab === 'returns' && <ReturnsReportTab range={range} />}
      {rangeError && <div className="alert alert-error">{t('reports.badRange')}</div>}
      {tab === 'sales' && loading && <div className="empty-state">{t('common.loading')}</div>}

      {tab === 'sales' && !loading && range && report && (
        <>
          {/* KPI cards */}
          <div className="stat-grid">
            <div className="stat-card success">
              <div className="label">{t('reports.grossSales')}</div>
              <div className="value">{formatUsd(report.totalUsdEquivalentCents)}</div>
            </div>
            <div className="stat-card success">
              <div className="label">{t('reports.netSales')}</div>
              <div className="value">{formatUsd(report.netSalesUsdEquivalentCents)}</div>
            </div>
            <div className="stat-card">
              <div className="label">{t('reports.cost')}</div>
              <div className="value">{formatUsd(report.costUsdCents)}</div>
            </div>
            <div className="stat-card success">
              <div className="label">{t('reports.grossProfit')}</div>
              <div className="value">{formatUsd(report.grossProfitUsdCents)}</div>
            </div>
            <div className="stat-card">
              <div className="label">{t('reports.expenses')}</div>
              <div className="value">{formatUsd(report.expensesUsdCents)}</div>
            </div>
            <div className="stat-card">
              <div className="label">{t('expenses.paidFromCash')}</div>
              <div className="value">{formatUsd(report.expensesCashUsdCents)}</div>
            </div>
            <div className="stat-card">
              <div className="label">{t('expenses.paidByOwner')}</div>
              <div className="value">{formatUsd(report.expensesOwnerUsdCents)}</div>
            </div>
            {report.expensesUnclassifiedUsdCents > 0 && (
              <div className="stat-card">
                <div className="label">{t('expenses.legacySourceUnknown')}</div>
                <div className="value">{formatUsd(report.expensesUnclassifiedUsdCents)}</div>
              </div>
            )}
            <div className="stat-card">
              <div className="label">{t('reports.waste')}</div>
              <div className="value">{formatUsd(report.wasteUsdCents)}</div>
            </div>
            <div className="stat-card">
              <div className="label">{t('reports.returns')}</div>
              <div className="value">{formatUsd(report.returnsUsdCents)}</div>
            </div>
            <div className={`stat-card ${report.netProfitUsdCents < 0 ? 'danger' : 'success'}`}>
              <div className="label">{t('reports.netProfit')}</div>
              <div className="value">{formatUsd(report.netProfitUsdCents)}</div>
            </div>
            <div className="stat-card">
              <div className="label">{t('reports.invoiceCount')}</div>
              <div className="value">{report.invoiceCount}</div>
            </div>
          </div>

          <h2 className="mt-16 mb-8">{t('reports.salesByCategory')}</h2>
          {unwrap(byCategory)?.length ? (
            <table className="data-table">
              <tbody>
                {unwrap(byCategory)!.map((c) => (
                  <tr key={c.categoryName}>
                    <td>{c.categoryName}</td>
                    <td style={{ textAlign: 'end' }}>{formatUsd(c.totalUsdEquivalentCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-state">{t('common.noData')}</div>
          )}

          {/* Best-selling products */}
          <h2 className="mt-16 mb-8">{t('reports.bestSelling')}</h2>
          {unwrap(bestSelling)?.length ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('pos.product')}</th>
                  <th>{t('pos.qty')}</th>
                  <th style={{ textAlign: 'end' }}>{t('pos.total')}</th>
                  <th style={{ textAlign: 'end' }}>{t('reports.invoiceCount')}</th>
                </tr>
              </thead>
              <tbody>
                {unwrap(bestSelling)!.map((p, i) => (
                  <tr key={p.productId}>
                    <td>{i + 1}</td>
                    <td>{p.productName}</td>
                    <td>
                      {p.sellingUnit === 'WEIGHT'
                        ? `${(p.quantitySoldMinor / 1000).toFixed(3)} KG`
                        : p.quantitySoldMinor}
                    </td>
                    <td style={{ textAlign: 'end' }}>
                      {formatUsd(p.lineTotalUsdEquivalentCents)}
                    </td>
                    <td style={{ textAlign: 'end' }}>{p.saleCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-state">{t('common.noData')}</div>
          )}
        </>
      )}

      {confirmZeroCash && (
        <div
          className="modal-overlay"
          onClick={() => !cashSaving && setConfirmZeroCash(false)}
        >
          <div
            className="modal modal-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="zero-cash-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="zero-cash-title">{t('reports.zeroCashBalance')}</h2>
            </div>
            <p>{t('reports.confirmZeroCashBalance')}</p>
            <div className="modal-footer">
              <button
                className="btn"
                type="button"
                onClick={() => setConfirmZeroCash(false)}
                disabled={cashSaving}
              >
                {t('common.cancel')}
              </button>
              <button
                className="btn btn-danger"
                type="button"
                onClick={handleZeroCashBalance}
                disabled={cashSaving}
              >
                {cashSaving ? t('common.loading') : t('reports.zeroCashBalance')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
