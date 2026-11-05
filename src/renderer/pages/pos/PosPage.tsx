import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { useApi, unwrap, isError } from '../../hooks/useApi';
import { useCart, cartToLineInputs, formatCartTotal } from '../../stores/cartStore';
import {
  formatUsd,
  formatLbp,
  formatWeightKg,
  parseWeightKg,
  parseQuantity,
  parseMoney,
  computeLineTotal,
  mulDivRound,
  convertMinor,
} from '@shared/money/index';
import { findStockProblems } from '@shared/stock/index';
import type { DraftCartDTO } from '../../../preload/types';
import { SELLING_UNIT_LABELS } from '@shared/constants/index';
import type { ProductDTO, SaleDTO, Currency } from '@shared/types/index';
import PaymentDialog from '../../components/pos/PaymentDialog';
import SaleCompletedDialog from '../../components/pos/SaleCompletedDialog';

export default function PosPage() {
  const { t, isRtl } = useI18n();
  const cart = useCart();
  const { data: products, reload: reloadProducts } = useApi<ProductDTO[]>(() =>
    window.posApi.listActiveProducts(),
  );
  const { data: categories } = useApi(() =>
    window.posApi.listCategories(true),
  );
  const { data: rateInfo } = useApi(() => window.posApi.getCurrentRate());
  const { data: suspendedSale, reload: reloadSuspended } = useApi(() => window.posApi.getSuspendedSale());

  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [search, setSearch] = useState('');

  const [addingProduct, setAddingProduct] = useState<ProductDTO | null>(null);
  const [editingCartIndex, setEditingCartIndex] = useState<number | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [completedSale, setCompletedSale] = useState<SaleDTO | null>(null);
  const [suspendLabel, setSuspendLabel] = useState('');
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // One idempotency key per sale attempt; reused on retry so a double submit cannot create two sales.
  const requestIdRef = useRef<string | null>(null);

  // Draft-cart recovery: an unfinished cart is saved locally and offered back after a crash.
  // A draft is NOT an invoice: no stock, payment or invoice number is involved.
  const [recovered, setRecovered] = useState<DraftCartDTO | null>(null);
  const [draftChecked, setDraftChecked] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      if (useCart.getState().items.length === 0) {
        const d = await window.posApi.getDraftCart();
        if (alive && d && !isError(d)) setRecovered(d);
      }
      if (alive) setDraftChecked(true);
    })();
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!draftChecked || recovered) return; // never overwrite a draft awaiting the cashier's decision
    const timer = setTimeout(() => {
      if (cart.items.length === 0) {
        requestIdRef.current = null;
        void window.posApi.clearDraftCart();
        return;
      }
      if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID();
      void window.posApi.saveDraftCart({
        requestId: requestIdRef.current,
        lines: cart.items.map((i) => ({
          productId: i.product.id,
          quantityMinor: i.quantityMinor,
          directFinalPrice: i.directFinalPrice,
          lineTotalMinor: i.lineTotalMinor,
          priceCurrency: i.priceCurrency,
        })),
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [cart.items, draftChecked, recovered]);
  const restoreDraft = () => {
    if (!recovered) return;
    recovered.items.forEach((i) =>
      cart.addItem({
        product: i.product,
        quantityMinor: i.quantityMinor,
        unitPriceMinor: i.unitPriceMinor,
        priceCurrency: i.priceCurrency,
        directFinalPrice: i.directFinalPrice,
        lineTotalMinor: i.lineTotalMinor,
      }),
    );
    requestIdRef.current = recovered.requestId;
    setRecovered(null);
  };
  const discardDraft = async () => {
    await window.posApi.clearDraftCart();
    setRecovered(null);
  };

  const filteredProducts = useMemo(() => {
    if (!products) return [];
    let list = products;
    if (selectedCategoryId !== null) {
      list = list.filter((p) => p.categoryId === selectedCategoryId);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.nameAr && p.nameAr.includes(q)),
      );
    }
    return list;
  }, [products, selectedCategoryId, search]);

  const totals = cart.totals();
  // Stock rule D3: the sale cannot proceed if it would take stock below zero.
  const stockProblems = useMemo(() => {
    const stock = new Map<number, number>((products ?? []).map((p) => [p.id, p.stockMinor ?? 0]));
    return findStockProblems(
      cart.items.map((i) => ({ productId: i.product.id, quantityMinor: i.quantityMinor })),
      stock,
    );
  }, [cart.items, products]);
  const stockQtyLabel = (productId: number, minor: number) => {
    const p = (products ?? []).find((x) => x.id === productId);
    return p?.sellingUnit === 'WEIGHT' ? `${formatWeightKg(minor)} KG` : String(minor);
  };

  const handleAddToCart = (
    product: ProductDTO,
    quantityMinor: number,
    unitPriceMinor: number,
    priceCurrency: Currency,
    directFinalPrice: boolean,
    lineTotalMinor: number,
  ) => {
    cart.addItem({
      product,
      quantityMinor,
      unitPriceMinor,
      priceCurrency,
      directFinalPrice,
      lineTotalMinor,
    });
    setAddingProduct(null);
  };

  const handleCompleteSale = async (payment: {
    paidUsdCents: number;
    paidLbp: number;
    changeCurrency: Currency;
    customerId?: number | null;
    allowCredit?: boolean;
  }) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID();
    try {
      const result = await window.posApi.completeSale({
        lines: cartToLineInputs(cart.items),
        payment,
        customerId: payment.customerId ?? null,
        allowCredit: payment.allowCredit ?? false,
        clientRequestId: requestIdRef.current,
      });
      if (isError(result)) {
        alert(result.error.userMessage);
        return;
      }
      const sale = result as SaleDTO;
      requestIdRef.current = null;
      cart.clear();
      reloadProducts(); // stock changed: keep the stock warnings accurate
      setPaymentOpen(false);
      setCompletedSale(sale);
      // Auto-print is best-effort and never blocks or undoes the sale.
      window.posApi
        .printReceipt(sale.id)
        .then((r) => {
          if (isError(r)) setNotice(r.error.userMessage);
          else if (!r.success && !r.skipped) setNotice(r.error || t('common.error'));
        })
        .catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const handleSuspend = async () => {
    if (cart.items.length === 0 || busy) return;
    setBusy(true);
    try {
      const result = await window.posApi.suspendSale(
        cartToLineInputs(cart.items),
        suspendLabel || undefined,
      );
      if (isError(result)) {
        alert(result.error.userMessage);
        return;
      }
      cart.clear();
      setSuspendOpen(false);
      setSuspendLabel('');
      reloadSuspended();
    } finally {
      setBusy(false);
    }
  };

  const handleResumeSuspended = async () => {
    const suspended = unwrap(suspendedSale);
    if (!suspended) return;
    if (cart.items.length > 0) {
      alert(t('pos.clearCartFirst'));
      return;
    }
    const restoredItems = suspended.items.map((item) => {
      const product = products?.find((p) => p.id === item.productId);
      const stubProduct: ProductDTO = product || {
        id: item.productId,
        name: item.productNameSnapshot,
        nameAr: item.productNameArSnapshot,
        categoryId: item.categoryIdSnapshot,
        sellingUnit: item.sellingUnitSnapshot,
        currentPrice: item.unitPriceMinor,
        priceCurrency: item.priceCurrencySnapshot,
        currentCost: item.unitCostSnapshot,
        lowStockThreshold: null,
        imageDataUrl: null,
        notes: null,
        active: false,
      };
      return {
        product: stubProduct,
        quantityMinor: item.quantityMinor,
        unitPriceMinor: item.unitPriceMinor,
        priceCurrency: item.priceCurrencySnapshot,
        directFinalPrice: item.directFinalPrice,
        lineTotalMinor: item.lineTotalMinor,
      };
    });
    const res = await window.posApi.cancelSuspendedSale();
    if (isError(res)) {
      alert(res.error.userMessage);
      return;
    }
    restoredItems.forEach((item) => cart.addItem(item));
    reloadSuspended();
  };

  return (
    <div>
      <div className="page-header">
        <h1>{t('pos.title')}</h1>
        {rateInfo && !('error' in rateInfo) && (
          <div className="text-muted" style={{ fontSize: 13 }}>
            {t('pos.exchangeRate')}:{' '}
            <bdi dir="ltr">
              1 USD = <strong>{rateInfo.currentRate.toLocaleString()} LBP</strong>
            </bdi>
          </div>
        )}
      </div>

      {notice && <div className="alert alert-error">{notice}</div>}
      {recovered && (
        <div className="alert alert-warning" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <strong>{t('pos.draftFound')}</strong> — {recovered.items.length} {t('pos.items')},{' '}
            {new Date(recovered.savedAt * 1000).toLocaleString()}
            <div style={{ fontSize: 12 }}>{t('pos.draftNote')}</div>
            {recovered.dropped.length > 0 && (
              <div style={{ fontSize: 12 }}>{t('pos.draftDropped')}: {recovered.dropped.length}</div>
            )}
          </div>
          <div className="flex gap-8">
            <button className="btn btn-small btn-primary" onClick={restoreDraft}>
              {t('pos.draftRestore')}
            </button>
            <button className="btn btn-small btn-danger" onClick={discardDraft}>
              {t('pos.draftDiscard')}
            </button>
          </div>
        </div>
      )}
      {suspendedSale && !isError(suspendedSale) && (
        <div
          className="alert alert-warning"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <div>
            <strong>{t('pos.suspendedSale')}</strong>
            {suspendedSale.items.length > 0 &&
              ` (${suspendedSale.items.length} ${t('pos.items')})`}
          </div>
          <div className="flex gap-8">
            <button className="btn btn-small" onClick={handleResumeSuspended}>
              {t('pos.resumeSuspended')}
            </button>
            <button
              className="btn btn-small btn-danger"
              onClick={async () => {
                if (confirm(t('pos.cancelSuspended') + '?')) {
                  await window.posApi.cancelSuspendedSale();
                  reloadSuspended();
                }
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      <div className="pos-grid">
        <div className="pos-categories">
          <button
            className={!selectedCategoryId ? 'active' : ''}
            onClick={() => setSelectedCategoryId(null)}
          >
            {t('pos.allCategories')}
          </button>
          {categories &&
            !('error' in categories) &&
            (categories as Array<{ id: number; name: string; nameAr: string | null }>).map(
              (cat) => (
                <button
                  key={cat.id}
                  className={selectedCategoryId === cat.id ? 'active' : ''}
                  onClick={() => setSelectedCategoryId(cat.id)}
                >
                  {isRtl && cat.nameAr ? cat.nameAr : cat.name}
                </button>
              ),
            )}
        </div>

        <div className="pos-products">
          <input
            className="form-control"
            placeholder={t('pos.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ marginBottom: 12 }}
          />
          {filteredProducts.length === 0 ? (
            <div className="empty-state">
              <div className="icon">📦</div>
              <div>{t('products.noProducts')}</div>
            </div>
          ) : (
            <div className="pos-products-grid">
              {filteredProducts.map((product) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  onClick={() => {
                    setEditingCartIndex(null);
                    setAddingProduct(product);
                  }}
                  isRtl={isRtl}
                />
              ))}
            </div>
          )}
        </div>

        <div className="pos-cart">
          <div className="pos-cart-header">
            {t('pos.cart')} ({cart.items.length})
          </div>
          <div className="pos-cart-items">
            {cart.items.length === 0 ? (
              <div className="empty-state">{t('pos.cartEmpty')}</div>
            ) : (
              cart.items.map((item, index) => (
                <CartLine
                  key={index}
                  item={item}
                  onRemove={() => cart.removeItem(index)}
                  onEdit={() => {
                    setEditingCartIndex(index);
                    setAddingProduct(item.product);
                  }}
                />
              ))
            )}
          </div>
          {cart.items.length > 0 && (
            <>
              <div className="cart-total">
                {totals.usdCents > 0 && (
                  <div className="cart-total-row">
                    <span>USD</span>
                    <span>{formatUsd(totals.usdCents)}</span>
                  </div>
                )}
                {totals.lbp > 0 && (
                  <div className="cart-total-row">
                    <span>LBP</span>
                    <span>{formatLbp(totals.lbp)}</span>
                  </div>
                )}
                <div className="cart-total-row grand">
                  <span>{t('pos.total')}</span>
                  <span>{formatCartTotal(totals.usdCents, totals.lbp)}</span>
                </div>
              </div>
              <div className="flex gap-8" style={{ marginTop: 8 }}>
                <button
                  className="btn"
                  onClick={() => setSuspendOpen(true)}
                  style={{ flex: 1 }}
                >
                  {t('pos.suspend')}
                </button>
                <button
                  className="btn btn-danger"
                  onClick={() => {
                    if (confirm(t('pos.clear') + '?')) cart.clear();
                  }}
                >
                  {t('pos.clear')}
                </button>
              </div>
              {stockProblems.length > 0 && (
                <div className="alert alert-error" style={{ marginTop: 8 }}>
                  {stockProblems.map((sp) => {
                    const name = (products ?? []).find((x) => x.id === sp.productId)?.name ?? '#' + sp.productId;
                    return (
                      <div key={sp.productId}>
                        {t('pos.notEnoughStock')}: {name} — {t('pos.available')} {stockQtyLabel(sp.productId, sp.availableMinor)},{' '}
                        {t('pos.requested')} {stockQtyLabel(sp.productId, sp.requestedMinor)}
                      </div>
                    );
                  })}
                </div>
              )}
              <button
                className="btn btn-success btn-large"
                style={{ width: '100%', marginTop: 8 }}
                disabled={stockProblems.length > 0 || busy}
                onClick={() => setPaymentOpen(true)}
              >
                {t('pos.completeSale')}
              </button>
            </>
          )}
        </div>
      </div>

      {addingProduct && (
        <AddToCartDialog
          product={addingProduct}
          initialItem={
            editingCartIndex === null ? undefined : cart.items[editingCartIndex]
          }
          inCartMinor={cart.items
            .filter(
              (i, index) =>
                i.product.id === addingProduct.id && index !== editingCartIndex,
            )
            .reduce((a, i) => a + i.quantityMinor, 0)}
          onAdd={(...args) => {
            if (editingCartIndex === null) {
              handleAddToCart(...args);
            } else {
              const [product, quantityMinor, unitPriceMinor, priceCurrency, directFinalPrice, lineTotalMinor] = args;
              cart.updateItem(editingCartIndex, {
                product,
                quantityMinor,
                unitPriceMinor,
                priceCurrency,
                directFinalPrice,
                lineTotalMinor,
              });
              setAddingProduct(null);
              setEditingCartIndex(null);
            }
          }}
          onClose={() => {
            setAddingProduct(null);
            setEditingCartIndex(null);
          }}
        />
      )}

      {paymentOpen && (
        <PaymentDialog
          totals={totals}
          busy={busy}
          onComplete={handleCompleteSale}
          onClose={() => setPaymentOpen(false)}
        />
      )}

      {suspendOpen && (
        <div className="modal-overlay" onClick={() => setSuspendOpen(false)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('pos.suspend')}</h2>
              <button className="btn btn-small" onClick={() => setSuspendOpen(false)}>
                ✕
              </button>
            </div>
            <div className="form-group">
              <label>{t('pos.suspendedSale')} </label>
              <input
                className="form-control"
                value={suspendLabel}
                onChange={(e) => setSuspendLabel(e.target.value)}
                placeholder={t('pos.suspendLabelPlaceholder')}
              />
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setSuspendOpen(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn btn-primary" onClick={handleSuspend}>
                {t('pos.suspend')}
              </button>
            </div>
          </div>
        </div>
      )}

      {completedSale && (
        <SaleCompletedDialog
          sale={completedSale}
          onClose={() => setCompletedSale(null)}
          onPrint={async () => {
            const result = await window.posApi.printReceipt(completedSale.id);
            if (isError(result)) alert(result.error.userMessage);
            else if (result.skipped) alert(t('settings.printingDisabled'));
            else if (!result.success) alert(result.error || t('common.error'));
          }}
        />
      )}
    </div>
  );
}

function ProductCard({
  product,
  onClick,
  isRtl,
}: {
  product: ProductDTO;
  onClick: () => void;
  isRtl: boolean;
}) {
  const { t } = useI18n();
  const unitLabel = SELLING_UNIT_LABELS[product.sellingUnit];
  const priceStr =
    product.priceCurrency === 'USD'
      ? formatUsd(product.currentPrice)
      : formatLbp(product.currentPrice);
  const unitSuffix =
    product.sellingUnit === 'WEIGHT' ? t('products.pricePerKg') : t('products.pricePerUnit');
  const displayName = isRtl && product.nameAr ? product.nameAr : product.name;

  return (
    <div
      className={`product-card ${!product.active ? 'inactive' : ''}`}
      onClick={onClick}
    >
      <div className="product-image">
        {product.imageDataUrl ? (
          <img src={product.imageDataUrl} alt={displayName} />
        ) : (
          <span>
            {unitLabel.short === 'KG' ? '⚖️' : unitLabel.short === 'BOX' ? '📦' : '🔹'}
          </span>
        )}
      </div>
      <div className="product-name">{displayName}</div>
      <div className="product-price">
        {priceStr} {unitSuffix}
      </div>
    </div>
  );
}

function CartLine({
  item,
  onRemove,
  onEdit,
}: {
  item: {
    product: ProductDTO;
    quantityMinor: number;
    unitPriceMinor: number;
    priceCurrency: Currency;
    directFinalPrice: boolean;
    lineTotalMinor: number;
  };
  onRemove: () => void;
  onEdit: () => void;
}) {
  const { t, isRtl } = useI18n();
  const unit = SELLING_UNIT_LABELS[item.product.sellingUnit];
  const qtyDisplay =
    item.product.sellingUnit === 'WEIGHT'
      ? `${formatWeightKg(item.quantityMinor)} KG`
      : `${item.quantityMinor} ${unit.short}`;
  const unitPriceStr =
    item.priceCurrency === 'USD'
      ? formatUsd(item.unitPriceMinor)
      : formatLbp(item.unitPriceMinor);
  const totalStr =
    item.priceCurrency === 'USD'
      ? formatUsd(item.lineTotalMinor)
      : formatLbp(item.lineTotalMinor);
  const displayName = isRtl && item.product.nameAr ? item.product.nameAr : item.product.name;

  return (
    <div className="cart-item">
      <div className="cart-item-row">
        <div className="cart-item-name" title={displayName}>
          {displayName}
        </div>
        <div className="cart-item-qty">{qtyDisplay}</div>
        <div className="cart-item-total">{totalStr}</div>
      </div>
      <div className="cart-item-row" style={{ marginTop: 4 }}>
        <div className="text-muted" style={{ fontSize: 11 }}>
          {item.directFinalPrice
            ? t('pos.directPriceMode')
            : `${unitPriceStr} ${item.product.sellingUnit === 'WEIGHT' ? t('products.pricePerKg') : t('products.pricePerUnit')}`}
        </div>
        <div className="cart-item-actions">
          <button onClick={onEdit}>{t('common.edit')}</button>
          <button onClick={onRemove}>✕</button>
        </div>
      </div>
    </div>
  );
}

function AddToCartDialog({
  product,
  initialItem,
  inCartMinor,
  onAdd,
  onClose,
}: {
  product: ProductDTO;
  initialItem?: {
    quantityMinor: number;
    priceCurrency: Currency;
    directFinalPrice: boolean;
    lineTotalMinor: number;
  };
  inCartMinor: number;
  onAdd: (
    product: ProductDTO,
    quantityMinor: number,
    unitPriceMinor: number,
    priceCurrency: Currency,
    directFinalPrice: boolean,
    lineTotalMinor: number,
  ) => void;
  onClose: () => void;
}) {
  const { t, isRtl } = useI18n();
  const { data: exchangeRateInfo } = useApi(() => window.posApi.getCurrentRate());
  const exchangeRate = unwrap(exchangeRateInfo)?.currentRate ?? 0;
  const isWeight = product.sellingUnit === 'WEIGHT';
  const [mode, setMode] = useState<'weight' | 'direct'>(
    initialItem?.directFinalPrice ? 'direct' : 'weight',
  );
  const [quantityStr, setQuantityStr] = useState(
    initialItem
      ? isWeight
        ? formatWeightKg(initialItem.quantityMinor)
        : String(initialItem.quantityMinor)
      : isWeight
        ? '1.000'
        : '1',
  );
  const [directPriceStr, setDirectPriceStr] = useState(
    initialItem?.directFinalPrice
      ? initialItem.priceCurrency === 'USD'
        ? (initialItem.lineTotalMinor / 100).toFixed(2)
        : String(initialItem.lineTotalMinor)
      : '',
  );
  const [directPriceCurrency, setDirectPriceCurrency] = useState<Currency>(
    initialItem?.priceCurrency ?? product.priceCurrency,
  );
  const [directUnitPrice, setDirectUnitPrice] = useState(() =>
    initialItem?.directFinalPrice
      ? mulDivRound(initialItem.lineTotalMinor, 1000, initialItem.quantityMinor)
      : product.currentPrice,
  );
  const [error, setError] = useState<string | null>(null);

  const displayName = isRtl && product.nameAr ? product.nameAr : product.name;
  const priceStr =
    product.priceCurrency === 'USD'
      ? formatUsd(product.currentPrice)
      : formatLbp(product.currentPrice);
  const unitSuffix =
    product.sellingUnit === 'WEIGHT' ? t('products.pricePerKg') : t('products.pricePerUnit');

  const fmt = (m: number) => (isWeight ? `${formatWeightKg(m)} KG` : String(m));
  const stockMsg = (wanted: number) =>
    `${t('pos.notEnoughStock')}: ${t('pos.available')} ${fmt(product.stockMinor ?? 0)}, ${t('pos.requested')} ${fmt(wanted)}`;
  const formatMoneyInput = (minor: number, currency: Currency) =>
    currency === 'USD' ? (minor / 100).toFixed(2) : String(minor);
  const suggestedDirectPrice = (
    quantity: string,
    unitPrice = directUnitPrice,
    currency = directPriceCurrency,
  ) => {
    const quantityMinor = parseWeightKg(quantity);
    return formatMoneyInput(
      computeLineTotal(quantityMinor, unitPrice, 'WEIGHT', currency),
      currency,
    );
  };

  const handleAdd = () => {
    setError(null);
    try {
      if (mode === 'direct') {
        const finalPriceMinor = parseMoney(directPriceStr, directPriceCurrency);
        if (finalPriceMinor <= 0) {
          setError(t('validation.positiveNumber'));
          return;
        }
        let qtyMinor: number;
        if (isWeight) {
          qtyMinor = parseWeightKg(quantityStr);
        } else {
          qtyMinor = parseQuantity(quantityStr);
        }
        if (qtyMinor + inCartMinor > (product.stockMinor ?? 0)) {
          setError(stockMsg(qtyMinor + inCartMinor));
          return;
        }
        onAdd(
          product,
          qtyMinor,
          finalPriceMinor,
          directPriceCurrency,
          true,
          finalPriceMinor,
        );
      } else {
        let qtyMinor: number;
        if (isWeight) {
          qtyMinor = parseWeightKg(quantityStr);
        } else {
          qtyMinor = parseQuantity(quantityStr);
        }
        if (qtyMinor + inCartMinor > (product.stockMinor ?? 0)) {
          setError(stockMsg(qtyMinor + inCartMinor));
          return;
        }
        const lineTotal = computeLineTotal(
          qtyMinor,
          product.currentPrice,
          product.sellingUnit,
          product.priceCurrency,
        );
        onAdd(
          product,
          qtyMinor,
          product.currentPrice,
          product.priceCurrency,
          false,
          lineTotal,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{displayName}</h2>
          <button className="btn btn-small" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="text-muted mb-16">
          {priceStr} {unitSuffix} · {product.priceCurrency} · {t('pos.inStock')}: {fmt(product.stockMinor ?? 0)}
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        {isWeight && (
          <div className="form-group">
            <label>
              {t('pos.weightMode')} / {t('pos.directPriceMode')}
            </label>
            <div className="flex gap-8">
              <button
                className={`btn ${mode === 'weight' ? 'btn-primary' : ''}`}
                onClick={() => setMode('weight')}
                style={{ flex: 1 }}
              >
                {t('pos.weightMode')}
              </button>
              <button
                className={`btn ${mode === 'direct' ? 'btn-primary' : ''}`}
                onClick={() => {
                  setMode('direct');
                  try {
                    setDirectPriceStr(suggestedDirectPrice(quantityStr));
                  } catch {
                    setDirectPriceStr('');
                  }
                }}
                style={{ flex: 1 }}
              >
                {t('pos.directPriceMode')}
              </button>
            </div>
          </div>
        )}

        <div className="form-group">
          <label>{isWeight ? t('pos.enterWeight') : t('pos.enterQuantity')}</label>
          <input
            className="form-control"
            value={quantityStr}
            onChange={(e) => {
              const nextQuantity = e.target.value;
              setQuantityStr(nextQuantity);
              if (mode === 'direct') {
                try {
                  setDirectPriceStr(suggestedDirectPrice(nextQuantity));
                } catch {
                  // Keep the last valid amount while the weight is being edited.
                }
              }
            }}
            autoFocus
            inputMode={isWeight ? 'decimal' : 'numeric'}
          />
        </div>

        {isWeight && mode === 'direct' && (
          <div className="form-group">
            <label>{t('pos.enterFinalPrice')}</label>
            <div className="form-row">
              <input
                className="form-control"
                value={directPriceStr}
                onChange={(e) => {
                  const nextPrice = e.target.value;
                  setDirectPriceStr(nextPrice);
                  try {
                    const priceMinor = parseMoney(nextPrice, directPriceCurrency);
                    const quantityMinor = mulDivRound(
                      priceMinor,
                      1000,
                      directUnitPrice,
                    );
                    if (quantityMinor > 0) {
                      setQuantityStr(formatWeightKg(quantityMinor));
                    }
                  } catch {
                    // Allow temporarily incomplete input without changing the weight.
                  }
                }}
                placeholder={directPriceCurrency === 'USD' ? '$6.08' : '550,000'}
                inputMode="decimal"
              />
              <select
                className="form-control"
                value={directPriceCurrency}
                onChange={(e) => {
                  const nextCurrency = e.target.value as Currency;
                  if (exchangeRate <= 0) {
                    setError(t('common.error'));
                    return;
                  }
                  try {
                    const convertedUnitPrice = convertMinor(
                      directUnitPrice,
                      directPriceCurrency,
                      nextCurrency,
                      exchangeRate,
                    );
                    setDirectUnitPrice(convertedUnitPrice);
                    setDirectPriceCurrency(nextCurrency);
                    setDirectPriceStr(
                      suggestedDirectPrice(quantityStr, convertedUnitPrice, nextCurrency),
                    );
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  }
                }}
                aria-label={t('products.currency')}
              >
                <option value="USD">{t('payment.usd')}</option>
                <option value="LBP">{t('payment.lbp')}</option>
              </select>
            </div>
            <small className="text-muted">{t('pos.finalPriceHint')}</small>
          </div>
        )}

        {isWeight && mode === 'weight' && (
          <div
            style={{
              padding: '10px 12px',
              background: 'var(--color-primary-light)',
              borderRadius: 'var(--radius-sm)',
              marginBottom: 12,
              fontSize: 14,
            }}
          >
            {(() => {
              try {
                const grams = parseWeightKg(quantityStr);
                const lt = computeLineTotal(
                  grams,
                  product.currentPrice,
                  product.sellingUnit,
                  product.priceCurrency,
                );
                const total = product.priceCurrency === 'USD' ? formatUsd(lt) : formatLbp(lt);
                return (
                  <div className="flex-between">
                    <span>{t('pos.total')}:</span>
                    <strong>{total}</strong>
                  </div>
                );
              } catch {
                return <span className="text-muted">—</span>;
              }
            })()}
          </div>
        )}

        <div className="modal-footer">
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-success" onClick={handleAdd}>
            {t('pos.addToCart')}
          </button>
        </div>
      </div>
    </div>
  );
}
