import { useState } from 'react';
import { useI18n } from '../../i18n';
import { useApi, unwrap, isError } from '../../hooks/useApi';
import {
  formatUsd,
  formatLbp,
  formatWeightKg,
  parseWeightKg,
  mulDivRound,
} from '@shared/money/index';
import { SELLING_UNIT_LABELS } from '@shared/constants/index';
import type { SaleDTO, ReturnDTO } from '@shared/types/index';

export default function InvoicesPage() {
  const { t, isRtl } = useI18n();
  const [search, setSearch] = useState('');
  const [printMsg, setPrintMsg] = useState<string | null>(null);
  const { data: sales, reload } = useApi<SaleDTO[]>(
    () => window.posApi.listSales({ limit: 200, search: search.trim() || undefined }),
    [search],
  );
  const [selectedSale, setSelectedSale] = useState<SaleDTO | null>(null);
  const [returnFor, setReturnFor] = useState<SaleDTO | null>(null);

  const filtered = unwrap(sales) || [];

  return (
    <div>
      <div className="page-header">
        <h1>{t('invoices.title')}</h1>
      </div>

      <input
        className="form-control mb-16"
        placeholder={t('invoices.search')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="icon">🧾</div>
          <div>{t('common.noData')}</div>
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('invoices.number')}</th>
              <th>{t('invoices.date')}</th>
              <th>{t('invoices.status')}</th>
              <th>{t('invoices.total')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((sale) => (
              <tr key={sale.id}>
                <td>
                  <strong>{sale.invoiceNumber}</strong>
                </td>
                <td>{new Date(sale.createdAt * 1000).toLocaleString()}</td>
                <td>
                  <span
                    className={`text-${sale.status === 'COMPLETED' ? 'success' : sale.status === 'RETURNED' ? 'danger' : 'muted'}`}
                    style={{ fontWeight: 600 }}
                  >
                    {t(`invoices.${sale.status.toLowerCase()}`)}
                  </span>
                </td>
                <td>
                  {sale.totalUsdCents > 0 && formatUsd(sale.totalUsdCents)}
                  {sale.totalUsdCents > 0 && sale.totalLbp > 0 && ' + '}
                  {sale.totalLbp > 0 && formatLbp(sale.totalLbp)}
                </td>
                <td>
                  <div className="flex gap-8">
                    <button
                      className="btn btn-small"
                      onClick={() => setSelectedSale(sale)}
                    >
                      {t('invoices.view')}
                    </button>
                    {sale.status === 'COMPLETED' && (
                      <button
                        className="btn btn-small btn-danger"
                        onClick={() => setReturnFor(sale)}
                      >
                        {t('invoices.return')}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selectedSale && (
        <InvoiceDetailDialog
          sale={selectedSale}
          onClose={() => setSelectedSale(null)}
          onPrint={async () => {
            setPrintMsg(null);
            const r = await window.posApi.printReceipt(selectedSale.id);
            if (isError(r)) setPrintMsg(r.error.userMessage);
            else if (r.skipped) setPrintMsg(t('settings.printingDisabled'));
            else if (!r.success) setPrintMsg(r.error || t('common.error'));
          }}
        />
      )}
      {printMsg && <div className="alert alert-error">{printMsg}</div>}

      {returnFor && (
        <ReturnDialog
          sale={returnFor}
          onClose={() => setReturnFor(null)}
          onDone={() => {
            setReturnFor(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function InvoiceDetailDialog({
  sale,
  onClose,
  onPrint,
}: {
  sale: SaleDTO;
  onClose: () => void;
  onPrint: () => Promise<void>;
}) {
  const { t, isRtl } = useI18n();
  const returnedTotals = sale.items.reduce(
    (totals, item) => {
      const returnedQty = item.returnedQuantityMinor ?? 0;
      if (returnedQty === 0) return totals;
      const returnedAmount = mulDivRound(
        returnedQty,
        item.lineTotalMinor,
        item.quantityMinor,
      );
      if (item.priceCurrencySnapshot === 'USD') totals.usd += returnedAmount;
      else totals.lbp += returnedAmount;
      return totals;
    },
    { usd: 0, lbp: 0 },
  );
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            {t('invoices.number')}: {sale.invoiceNumber}
          </h2>
          <button className="btn btn-small" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="text-muted mb-16">
          {new Date(sale.createdAt * 1000).toLocaleString()}
        </div>

        <table className="data-table">
          <thead>
            <tr>
              <th>{t('pos.product')}</th>
              <th>{t('pos.qty')}</th>
              <th>{t('pos.price')}</th>
              <th style={{ textAlign: 'end' }}>{t('pos.total')}</th>
            </tr>
          </thead>
          <tbody>
            {sale.items.map((item) => {
              const unit = SELLING_UNIT_LABELS[item.sellingUnitSnapshot];
              const qtyDisplay =
                item.sellingUnitSnapshot === 'WEIGHT'
                  ? `${formatWeightKg(item.quantityMinor)} KG`
                  : `${item.quantityMinor} ${unit.short}`;
              const returnedQty = item.returnedQuantityMinor ?? 0;
              const returnedAmount = returnedQty > 0
                ? mulDivRound(returnedQty, item.lineTotalMinor, item.quantityMinor)
                : 0;
              const priceStr =
                item.priceCurrencySnapshot === 'USD'
                  ? formatUsd(item.unitPriceMinor)
                  : formatLbp(item.unitPriceMinor);
              const totalStr =
                item.priceCurrencySnapshot === 'USD'
                  ? formatUsd(item.lineTotalMinor)
                  : formatLbp(item.lineTotalMinor);
              const name = isRtl && item.productNameArSnapshot
                ? item.productNameArSnapshot
                : item.productNameSnapshot;
              return (
                <tr key={item.id}>
                  <td>{name}</td>
                  <td>
                    {qtyDisplay}
                    {returnedQty > 0 && (
                      <div className="text-muted" style={{ fontSize: 11 }}>
                        {t('returns.returnedSoFar')}:{' '}
                        {item.sellingUnitSnapshot === 'WEIGHT'
                          ? `${formatWeightKg(returnedQty)} KG`
                          : `${returnedQty} ${unit.short}`}
                      </div>
                    )}
                  </td>
                  <td>{priceStr}</td>
                  <td style={{ textAlign: 'end' }}>
                    {totalStr}
                    {returnedQty > 0 && (
                      <div className="text-muted" style={{ fontSize: 11 }}>
                        {t('returns.refundedSoFar')}:{' '}
                        {item.priceCurrencySnapshot === 'USD'
                          ? formatUsd(returnedAmount)
                          : formatLbp(returnedAmount)}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="mt-16">
          <div className="text-muted" style={{ fontSize: 12, marginBottom: 8 }}>
            {t('invoices.originalTotal')}
          </div>
          {sale.totalUsdCents > 0 && (
            <div className="flex-between">
              <span>USD {t('pos.total')}</span>
              <strong>{formatUsd(sale.totalUsdCents)}</strong>
            </div>
          )}
          {sale.totalLbp > 0 && (
            <div className="flex-between">
              <span>LBP {t('pos.total')}</span>
              <strong>{formatLbp(sale.totalLbp)}</strong>
            </div>
          )}
          {(returnedTotals.usd > 0 || returnedTotals.lbp > 0) && (
            <div className="flex-between text-danger mt-8">
              <span>{t('returns.refundedSoFar')}</span>
              <strong>
                {returnedTotals.usd > 0 && formatUsd(returnedTotals.usd)}
                {returnedTotals.usd > 0 && returnedTotals.lbp > 0 && ' + '}
                {returnedTotals.lbp > 0 && formatLbp(returnedTotals.lbp)}
              </strong>
            </div>
          )}
          {sale.payment && (
            <>
              <div className="flex-between mt-8">
                <span>{t('payment.paid')}</span>
                <span>
                  {sale.payment.paidUsdCents > 0 && formatUsd(sale.payment.paidUsdCents)}
                  {sale.payment.paidLbp > 0 && ' + '}
                  {sale.payment.paidLbp > 0 && formatLbp(sale.payment.paidLbp)}
                </span>
              </div>
              {(sale.payment.changeUsdCents > 0 || sale.payment.changeLbp > 0) && (
                <div className="flex-between text-success">
                  <span>{t('payment.change')}</span>
                  <span>
                    {sale.payment.changeUsdCents > 0 && formatUsd(sale.payment.changeUsdCents)}
                    {sale.payment.changeLbp > 0 && formatLbp(sale.payment.changeLbp)}
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onPrint}>
            🖨️ {t('pos.printReceipt')}
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReturnDialog({
  sale,
  onClose,
  onDone,
}: {
  sale: SaleDTO;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, isRtl } = useI18n();
  const [returnType, setReturnType] = useState<'FULL' | 'PARTIAL'>('FULL');
  const [partialQty, setPartialQty] = useState<Record<number, string>>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const getPartialQuantity = (item: SaleDTO['items'][number]): number | null => {
    const str = partialQty[item.id] ?? '';
    if (!str.trim()) return null;
    if (item.sellingUnitSnapshot === 'WEIGHT') {
      try {
        return parseWeightKg(str);
      } catch {
        return null;
      }
    }
    return /^\d+$/.test(str.trim()) ? Number(str.trim()) : null;
  };

  const getPartialRefund = (item: SaleDTO['items'][number]): number | null => {
    const qty = getPartialQuantity(item);
    const returnedQty = item.returnedQuantityMinor ?? 0;
    const remaining = item.quantityMinor - returnedQty;
    if (qty === null || !Number.isSafeInteger(qty) || qty <= 0 || qty > remaining) {
      return null;
    }
    const refundAfter = returnedQty + qty === item.quantityMinor
      ? item.lineTotalMinor
      : mulDivRound(returnedQty + qty, item.lineTotalMinor, item.quantityMinor);
    const refundedBefore = mulDivRound(returnedQty, item.lineTotalMinor, item.quantityMinor);
    return Math.max(0, refundAfter - refundedBefore);
  };

  const handleConfirm = async () => {
    setError(null);
    const remaining = (it: SaleDTO['items'][number]) =>
      it.quantityMinor - (it.returnedQuantityMinor ?? 0);
    let invalidQuantity = false;
    const items =
      returnType === 'FULL'
        ? sale.items
            .filter((it) => remaining(it) > 0)
            .map((it) => ({
              saleItemId: it.id,
              quantityReturnedMinor: remaining(it),
            }))
        : sale.items
            .map((it) => {
              const qty = getPartialQuantity(it);
              if (qty === null && !(partialQty[it.id] ?? '').trim()) return null;
              if (
                qty === null ||
                !Number.isSafeInteger(qty) ||
                qty <= 0 ||
                qty > remaining(it)
              ) {
                invalidQuantity = true;
                return null;
              }
              return { saleItemId: it.id, quantityReturnedMinor: qty };
            })
            .filter(Boolean) as Array<{ saleItemId: number; quantityReturnedMinor: number }>;

    if (invalidQuantity) {
      setError(t('validation.invalidNumber'));
      return;
    }
    if (items.length === 0) {
      setError(t('validation.required'));
      return;
    }

    const result = await window.posApi.createReturn({
      originalSaleId: sale.id,
      returnType,
      items,
      reason: reason.trim() || undefined,
    });
    if (result && 'error' in result) {
      setError(result.error.userMessage);
      return;
    }
    onDone();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            {t('returns.title')} — {sale.invoiceNumber}
          </h2>
          <button className="btn btn-small" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <div className="form-group">
          <label>{t('returns.original')}</label>
          <div className="flex gap-8">
            <button
              className={`btn ${returnType === 'FULL' ? 'btn-primary' : ''}`}
              onClick={() => setReturnType('FULL')}
              style={{ flex: 1 }}
            >
              {t('returns.full')}
            </button>
            <button
              className={`btn ${returnType === 'PARTIAL' ? 'btn-primary' : ''}`}
              onClick={() => setReturnType('PARTIAL')}
              style={{ flex: 1 }}
            >
              {t('returns.partial')}
            </button>
          </div>
        </div>

        {returnType === 'PARTIAL' && (
          <table className="data-table mb-16">
            <thead>
              <tr>
                <th>{t('pos.product')}</th>
                <th>{t('pos.qty')} ({t('common.edit')})</th>
                <th style={{ textAlign: 'end' }}>{t('returns.refundForEnteredQty')}</th>
              </tr>
            </thead>
            <tbody>
              {sale.items.map((item) => {
                const unit = SELLING_UNIT_LABELS[item.sellingUnitSnapshot];
                const name = isRtl && item.productNameArSnapshot
                  ? item.productNameArSnapshot
                  : item.productNameSnapshot;
                const left = item.quantityMinor - (item.returnedQuantityMinor ?? 0);
                const placeholder =
                  item.sellingUnitSnapshot === 'WEIGHT'
                    ? formatWeightKg(left)
                    : String(left);
                const estimatedRefund = getPartialRefund(item);
                return (
                  <tr key={item.id}>
                    <td>{name}</td>
                    <td>
                      <input
                        className="form-control"
                        style={{ width: 120 }}
                        value={partialQty[item.id] ?? ''}
                        onChange={(e) =>
                          setPartialQty({
                            ...partialQty,
                            [item.id]: e.target.value,
                          })
                        }
                        placeholder={placeholder}
                        inputMode={item.sellingUnitSnapshot === 'WEIGHT' ? 'decimal' : 'numeric'}
                      />
                      <div className="text-muted" style={{ fontSize: 11 }}>
                        {t('returns.remaining')}: {item.sellingUnitSnapshot === 'WEIGHT' ? `${formatWeightKg(left)} KG` : `${left} ${unit.short}`}
                      </div>
                    </td>
                    <td style={{ textAlign: 'end' }}>
                      {estimatedRefund === null
                        ? '—'
                        : item.priceCurrencySnapshot === 'USD'
                          ? formatUsd(estimatedRefund)
                          : formatLbp(estimatedRefund)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div className="form-group">
          <label>{t('returns.reason')}</label>
          <input
            className="form-control"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-danger" onClick={handleConfirm}>
            {t('returns.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
