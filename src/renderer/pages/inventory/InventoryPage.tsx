import { useState } from 'react';
import { useI18n } from '../../i18n';
import { useApi, unwrap } from '../../hooks/useApi';
import {
  formatUsd,
  formatLbp,
  formatWeightKg,
  parseMoney,
  parseWeightKg,
  parseQuantity,
} from '@shared/money/index';
import { SELLING_UNIT_LABELS, WASTE_REASONS } from '@shared/constants/index';
import type {
  ProductDTO,
  InventoryDTO,
  Currency,
} from '@shared/types/index';

export default function InventoryPage() {
  const { t, isRtl } = useI18n();
  const { data: inventory, reload: reloadInv } = useApi<InventoryDTO[]>(() =>
    window.posApi.listInventory(),
  );
  const { data: lowStock, reload: reloadLow } = useApi<InventoryDTO[]>(() =>
    window.posApi.listLowStock(),
  );
  const [tab, setTab] = useState<'inventory' | 'lowstock' | 'movements'>('inventory');
  const [addStockFor, setAddStockFor] = useState<InventoryDTO | null>(null);
  const [wasteFor, setWasteFor] = useState<InventoryDTO | null>(null);

  const inv = unwrap(inventory) || [];
  const low = unwrap(lowStock) || [];

  return (
    <div>
      <div className="page-header">
        <h1>{t('inventory.title')}</h1>
      </div>

      {low.length > 0 && (
        <div className="alert alert-warning mb-16">
          <strong>{t('inventory.lowStockWarnings')}:</strong>{' '}
          {low
            .map((item) =>
              isRtl && item.productNameAr ? item.productNameAr : item.productName,
            )
            .join(', ')}
        </div>
      )}

      <div className="tabs">
        <button
          className={`tab ${tab === 'inventory' ? 'active' : ''}`}
          onClick={() => setTab('inventory')}
        >
          {t('inventory.title')}
        </button>
        <button
          className={`tab ${tab === 'lowstock' ? 'active' : ''}`}
          onClick={() => setTab('lowstock')}
        >
          {t('inventory.lowStock')} ({low.length})
        </button>
        <button
          className={`tab ${tab === 'movements' ? 'active' : ''}`}
          onClick={() => setTab('movements')}
        >
          {t('inventory.movements')}
        </button>
      </div>

      {tab === 'inventory' && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('inventory.product')}</th>
              <th>{t('products.sellingType')}</th>
              <th>{t('inventory.stock')}</th>
              <th>{t('products.cost')}</th>
              <th>{t('inventory.lowStock')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {inv.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty-state">
                  {t('common.noData')}
                </td>
              </tr>
            ) : (
              inv.map((item) => {
                const unit = SELLING_UNIT_LABELS[item.sellingUnit];
                const stockDisplay =
                  item.sellingUnit === 'WEIGHT'
                    ? `${(item.quantityMinor / 1000).toFixed(3)} KG`
                    : item.quantityMinor;
                const lowStock = item.lowStockThreshold !== null &&
                  item.quantityMinor < item.lowStockThreshold;
                return (
                  <tr key={item.productId}>
                    <td>
                      <strong>
                        {isRtl && item.productNameAr
                          ? item.productNameAr
                          : item.productName}
                      </strong>
                    </td>
                    <td>
                      {t(
                        `unit.${unit.short === 'KG' ? 'weight' : unit.short === 'BOX' ? 'package' : 'piece'}`,
                      )}
                    </td>
                    <td className={lowStock ? 'text-danger' : ''} style={{ fontWeight: lowStock ? 700 : 400 }}>
                      {stockDisplay}
                    </td>
                    <td>
                      {item.currentCost == null
                        ? '—'
                        : `${item.priceCurrency === 'LBP' ? formatLbp(item.currentCost) : formatUsd(item.currentCost)} / ${unit.short}`}
                    </td>
                    <td>
                      {item.lowStockThreshold == null
                        ? '—'
                        : item.sellingUnit === 'WEIGHT'
                          ? `${formatWeightKg(item.lowStockThreshold)} KG`
                          : item.lowStockThreshold}
                    </td>
                    <td>
                      <div className="flex gap-8">
                        <button
                          className="btn btn-small"
                          onClick={() => setAddStockFor(item)}
                        >
                          + {t('inventory.addStock')}
                        </button>
                        <button
                          className="btn btn-small btn-danger"
                          onClick={() => setWasteFor(item)}
                        >
                          {t('inventory.recordWaste')}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      )}

      {tab === 'lowstock' && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('inventory.product')}</th>
              <th>{t('inventory.stock')}</th>
              <th>{t('inventory.lowStock')}</th>
            </tr>
          </thead>
          <tbody>
            {low.length === 0 ? (
              <tr>
                <td colSpan={3} className="empty-state">
                  {t('inventory.noLowStock')}
                </td>
              </tr>
            ) : (
              low.map((item) => {
                const stockDisplay =
                  item.sellingUnit === 'WEIGHT'
                    ? `${(item.quantityMinor / 1000).toFixed(3)} KG`
                    : item.quantityMinor;
                return (
                  <tr key={item.productId}>
                    <td>
                      {isRtl && item.productNameAr ? item.productNameAr : item.productName}
                    </td>
                    <td className="text-danger" style={{ fontWeight: 700 }}>
                      {stockDisplay}
                    </td>
                    <td>
                      {item.lowStockThreshold == null
                        ? '—'
                        : item.sellingUnit === 'WEIGHT'
                          ? `${formatWeightKg(item.lowStockThreshold)} KG`
                          : item.lowStockThreshold}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      )}

      {tab === 'movements' && <MovementsTable />}

      {addStockFor && (
        <AddStockDialog
          item={addStockFor}
          onClose={() => setAddStockFor(null)}
          onSaved={() => {
            setAddStockFor(null);
            reloadInv();
            reloadLow();
          }}
        />
      )}

      {wasteFor && (
        <WasteDialog
          item={wasteFor}
          onClose={() => setWasteFor(null)}
          onSaved={() => {
            setWasteFor(null);
            reloadInv();
            reloadLow();
          }}
        />
      )}
    </div>
  );
}

function AddStockDialog({
  item,
  onClose,
  onSaved,
}: {
  item: InventoryDTO;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const isWeight = item.sellingUnit === 'WEIGHT';
  const [qtyStr, setQtyStr] = useState(isWeight ? '1.000' : '1');
  const [costStr, setCostStr] = useState('');
  const [currency, setCurrency] = useState<Currency>(item.priceCurrency);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    try {
      const qtyMinor = isWeight ? parseWeightKg(qtyStr) : parseQuantity(qtyStr);
      const costMinor = costStr.trim() ? parseMoney(costStr, currency) : null;
      const result = await window.posApi.addStock({
        productId: item.productId,
        quantityMinor: qtyMinor,
        unitCostMinor: costMinor,
        currency,
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
          <h2>{t('inventory.addStock')}</h2>
          <button className="btn btn-small" onClick={onClose}>
            ✕
          </button>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-group">
          <label>{t('inventory.product')}</label>
          <input className="form-control" value={item.productName} disabled />
        </div>
        <div className="form-group">
          <label>
            {isWeight ? t('pos.enterWeight') : t('inventory.quantity')}
          </label>
          <input
            className="form-control"
            value={qtyStr}
            onChange={(e) => setQtyStr(e.target.value)}
            inputMode={isWeight ? 'decimal' : 'numeric'}
            autoFocus
          />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>{t('inventory.unitCost')}</label>
            <input
              className="form-control"
              value={costStr}
              onChange={(e) => setCostStr(e.target.value)}
              inputMode="decimal"
              placeholder="3.50"
            />
          </div>
          <div className="form-group">
            <label>{t('inventory.currency')}</label>
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
        <div className="form-group">
          <label>{t('inventory.notes')}</label>
          <input
            className="form-control"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={handleSave}>
            {t('inventory.addStock')}
          </button>
        </div>
      </div>
    </div>
  );
}

function WasteDialog({
  item,
  onClose,
  onSaved,
}: {
  item: InventoryDTO;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const isWeight = item.sellingUnit === 'WEIGHT';
  const [qtyStr, setQtyStr] = useState(isWeight ? '0.500' : '1');
  const [reason, setReason] = useState(WASTE_REASONS[0]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    try {
      const qtyMinor = isWeight ? parseWeightKg(qtyStr) : parseQuantity(qtyStr);
      const result = await window.posApi.recordWaste({
        productId: item.productId,
        quantityMinor: qtyMinor,
        reason,
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
          <h2>{t('inventory.recordWaste')}</h2>
          <button className="btn btn-small" onClick={onClose}>
            ✕
          </button>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="form-group">
          <label>{t('inventory.product')}</label>
          <input className="form-control" value={item.productName} disabled />
        </div>
        <div className="form-group">
          <label>
            {isWeight ? t('pos.enterWeight') : t('inventory.quantity')}
          </label>
          <input
            className="form-control"
            value={qtyStr}
            onChange={(e) => setQtyStr(e.target.value)}
            inputMode={isWeight ? 'decimal' : 'numeric'}
            autoFocus
          />
        </div>
        <div className="form-group">
          <label>{t('inventory.reason')}</label>
          <select
            className="form-control"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          >
            {WASTE_REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`inventory.wasteReason.${r.toLowerCase()}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>{t('inventory.notes')}</label>
          <input
            className="form-control"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-danger" onClick={handleSave}>
            {t('inventory.recordWaste')}
          </button>
        </div>
      </div>
    </div>
  );
}

function MovementsTable() {
  const { t } = useI18n();
  const { data, loading } = useApi(() => window.posApi.listMovements(undefined, 500));
  const movements = (Array.isArray(data) ? data : []) as Array<{
    id: number;
    productId: number;
    productName: string;
    movementType: string;
    deltaMinor: number;
    resultingQuantityMinor: number;
    reason: string | null;
    createdAt: number;
  }>;

  if (loading) return <div className="empty-state">{t('common.loading')}</div>;
  if (movements.length === 0)
    return <div className="empty-state">{t('common.noData')}</div>;

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>{t('inventory.date')}</th>
          <th>{t('inventory.product')}</th>
          <th>{t('inventory.movementType')}</th>
          <th>{t('inventory.delta')}</th>
          <th>{t('inventory.resulting')}</th>
          <th>{t('inventory.reason')}</th>
        </tr>
      </thead>
      <tbody>
        {movements.map((m) => {
          const typeLabels: Record<string, string> = {
            SALE: '🛒 Sale',
            ADD_STOCK: '➕ Add Stock',
            WASTE: '🗑️ Waste',
            RETURN: '↩️ Return',
            ADJUSTMENT: '⚙️ Adjustment',
          };
          const delta = m.deltaMinor;
          const isPositive = delta > 0;
          return (
            <tr key={m.id}>
              <td>{new Date(m.createdAt * 1000).toLocaleString()}</td>
              <td>{m.productName}</td>
              <td>{typeLabels[m.movementType] || m.movementType}</td>
              <td className={isPositive ? 'text-success' : 'text-danger'}>
                {isPositive ? '+' : ''}
                {delta}
              </td>
              <td>{m.resultingQuantityMinor}</td>
              <td>{m.reason || '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
