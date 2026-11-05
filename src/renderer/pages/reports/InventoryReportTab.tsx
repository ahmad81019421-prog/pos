import { useI18n } from '../../i18n';
import { useApi } from '../../hooks/useApi';
import { formatUsd, formatLbp, formatWeightKg } from '@shared/money/index';
import type { DateRange, InventoryDTO, ReturnDTO } from '@shared/types/index';
import type { InventoryMovementsReport } from '../../../preload/types';

const qty = (minor: number, unit: string) =>
  unit === 'WEIGHT' ? `${formatWeightKg(minor)} KG` : String(minor);
const when = (ts: number) => new Date(ts * 1000).toLocaleString();

function State({ loading, error, empty }: { loading: boolean; error: string | null; empty: boolean }) {
  const { t } = useI18n();
  if (loading) return <div className="empty-state">{t('common.loading')}</div>;
  if (error) return <div className="alert alert-error">{error}</div>;
  if (empty) return <div className="empty-state">{t('common.noData')}</div>;
  return null;
}

/** Inventory & waste report: current stock, low stock, stock additions and waste in a date range. */
export function InventoryReportTab({ range }: { range: DateRange | null }) {
  const { t, isRtl } = useI18n();
  const stock = useApi<InventoryDTO[]>(() => window.posApi.listInventory());
  const low = useApi<InventoryDTO[]>(() => window.posApi.listLowStock());
  const mv = useApi<InventoryMovementsReport>(
    async () =>
      range
        ? window.posApi.getInventoryReport(range)
        : Promise.resolve({ additions: [], waste: [] } as InventoryMovementsReport),
    [range?.from, range?.to],
  );
  const name = (p: { productName: string; productNameAr?: string | null }) =>
    isRtl && p.productNameAr ? p.productNameAr : p.productName;
  const report = mv.data;
  const wasteTotal = (report?.waste ?? []).reduce((a, w) => a + w.costUsdCents, 0);
  const unknownCost = (report?.waste ?? []).some((w) => !w.costKnown);

  return (
    <div data-testid="inventory-report">
      <h2 className="mt-16 mb-8">{t('reports.currentStock')}</h2>
      <State loading={stock.loading} error={stock.error?.userMessage ?? null} empty={!stock.loading && !stock.error && !(stock.data?.length)} />
      {!!stock.data?.length && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('pos.product')}</th>
              <th style={{ textAlign: 'end' }}>{t('inventory.stock')}</th>
            </tr>
          </thead>
          <tbody>
            {stock.data.map((s) => (
              <tr key={s.productId}>
                <td>{name(s)}</td>
                <td style={{ textAlign: 'end' }}>{qty(s.quantityMinor, s.sellingUnit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="mt-16 mb-8">{t('reports.lowStock')}</h2>
      <State loading={low.loading} error={low.error?.userMessage ?? null} empty={!low.loading && !low.error && !(low.data?.length)} />
      {!!low.data?.length && (
        <table className="data-table">
          <tbody>
            {low.data.map((s) => (
              <tr key={s.productId}>
                <td>{name(s)}</td>
                <td style={{ textAlign: 'end' }} className="text-danger">
                  {qty(s.quantityMinor, s.sellingUnit)} / {s.lowStockThreshold != null ? qty(s.lowStockThreshold, s.sellingUnit) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="mt-16 mb-8">{t('reports.stockAdditions')}</h2>
      <State loading={mv.loading} error={mv.error?.userMessage ?? null} empty={!mv.loading && !mv.error && !(report?.additions.length)} />
      {!!report?.additions.length && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('backup.date')}</th>
              <th>{t('pos.product')}</th>
              <th>{t('pos.qty')}</th>
              <th style={{ textAlign: 'end' }}>{t('reports.unitCost')}</th>
            </tr>
          </thead>
          <tbody>
            {report.additions.map((a, i) => (
              <tr key={i}>
                <td>{when(a.createdAt)}</td>
                <td>{a.productName}</td>
                <td>{qty(a.quantityMinor, a.sellingUnit)}</td>
                <td style={{ textAlign: 'end' }}>
                  {a.unitCost == null ? '—' : a.currency === 'LBP' ? formatLbp(a.unitCost) : formatUsd(a.unitCost)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="mt-16 mb-8">{t('reports.waste')}</h2>
      <State loading={mv.loading} error={null} empty={!mv.loading && !mv.error && !(report?.waste.length)} />
      {!!report?.waste.length && (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('backup.date')}</th>
                <th>{t('pos.product')}</th>
                <th>{t('pos.qty')}</th>
                <th>{t('returns.reason')}</th>
                <th style={{ textAlign: 'end' }}>{t('reports.wasteCost')}</th>
              </tr>
            </thead>
            <tbody>
              {report.waste.map((w, i) => (
                <tr key={i}>
                  <td>{when(w.createdAt)}</td>
                  <td>{w.productName}</td>
                  <td>{qty(w.quantityMinor, w.sellingUnit)}</td>
                  <td>{w.reason}</td>
                  <td style={{ textAlign: 'end' }}>{w.costKnown ? formatUsd(w.costUsdCents) : t('reports.costUnknown')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex-between mt-8">
            <strong>{t('reports.wasteTotal')}</strong>
            <strong data-testid="waste-total">{formatUsd(wasteTotal)}</strong>
          </div>
          {unknownCost && <div className="text-muted">{t('reports.costUnknownNote')}</div>}
        </>
      )}
    </div>
  );
}

/** Returns made in the selected range (recorded separately from sales, PRD 37). */
export function ReturnsReportTab({ range }: { range: DateRange | null }) {
  const { t } = useI18n();
  const r = useApi<ReturnDTO[]>(
    async () => (range ? window.posApi.listReturns({ from: range.from, to: range.to, limit: 500 }) : Promise.resolve([])),
    [range?.from, range?.to],
  );
  return (
    <div data-testid="returns-report">
      <State loading={r.loading} error={r.error?.userMessage ?? null} empty={!r.loading && !r.error && !(r.data?.length)} />
      {!!r.data?.length && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('returns.title')}</th>
              <th>{t('backup.date')}</th>
              <th>{t('returns.reason')}</th>
              <th style={{ textAlign: 'end' }}>{t('returns.refundTotal')}</th>
            </tr>
          </thead>
          <tbody>
            {r.data.map((x) => (
              <tr key={x.id}>
                <td>{x.returnNumber}</td>
                <td>{when(x.createdAt)}</td>
                <td>{x.reason}</td>
                <td style={{ textAlign: 'end' }}>
                  {x.refundUsdCents > 0 && formatUsd(x.refundUsdCents)}
                  {x.refundUsdCents > 0 && x.refundLbp > 0 && ' + '}
                  {x.refundLbp > 0 && formatLbp(x.refundLbp)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
