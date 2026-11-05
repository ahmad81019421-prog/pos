/**
 * Post-sale confirmation dialog — shows invoice number, totals, and print button.
 */

import { useI18n } from '../../i18n';
import {
  formatUsd,
  formatLbp,
  formatWeightKg,
} from '@shared/money/index';
import { SELLING_UNIT_LABELS } from '@shared/constants/index';
import type { SaleDTO } from '@shared/types/index';

interface Props {
  sale: SaleDTO;
  onClose: () => void;
  onPrint: () => Promise<void>;
}

export default function SaleCompletedDialog({ sale, onClose, onPrint }: Props) {
  const { t, isRtl } = useI18n();
  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <div className="modal-header">
          <h2>✓ {t('pos.saleCompleted')}</h2>
        </div>

        <div style={{ textAlign: 'center', margin: '12px 0' }}>
          <div className="text-muted" style={{ fontSize: 11 }}>
            {t('invoices.number')}
          </div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{sale.invoiceNumber}</div>
        </div>

        <table className="data-table" style={{ marginBottom: 12 }}>
          <thead>
            <tr>
              <th>{t('pos.product')}</th>
              <th>{t('pos.qty')}</th>
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
                  <td>{qtyDisplay}</td>
                  <td style={{ textAlign: 'end' }}>{totalStr}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div
          style={{
            padding: 12,
            background: 'var(--color-success-light)',
            borderRadius: 'var(--radius-md)',
            marginBottom: 12,
          }}
        >
          {sale.totalUsdCents > 0 && (
            <div className="flex-between">
              <span>USD</span>
              <strong>{formatUsd(sale.totalUsdCents)}</strong>
            </div>
          )}
          {sale.totalLbp > 0 && (
            <div className="flex-between">
              <span>LBP</span>
              <strong>{formatLbp(sale.totalLbp)}</strong>
            </div>
          )}
          {sale.payment && (
            <>
              {sale.payment.changeUsdCents > 0 && (
                <div className="flex-between mt-8 text-success">
                  <span>{t('payment.change')} (USD)</span>
                  <strong>{formatUsd(sale.payment.changeUsdCents)}</strong>
                </div>
              )}
              {sale.payment.changeLbp > 0 && (
                <div className="flex-between mt-8 text-success">
                  <span>{t('payment.change')} (LBP)</span>
                  <strong>{formatLbp(sale.payment.changeLbp)}</strong>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onPrint}>
            🖨️ {t('pos.printReceipt')}
          </button>
          <button className="btn btn-primary btn-large" onClick={onClose}>
            {t('pos.newSale')}
          </button>
        </div>
      </div>
    </div>
  );
}
