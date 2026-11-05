import { useState } from 'react';
import { useI18n } from '../../i18n';
import { useApi, unwrap } from '../../hooks/useApi';
import {
  formatUsd,
  formatLbp,
  parseMoney,
  parseWeightKg,
} from '@shared/money/index';
import { SELLING_UNIT_LABELS, EXPENSE_CATEGORIES } from '@shared/constants/index';
import type { ProductDTO, CategoryDTO, Currency, SellingUnit } from '@shared/types/index';

export default function ProductsPage() {
  const { t, isRtl } = useI18n();
  const { data: products, reload: reloadProducts } = useApi<ProductDTO[]>(() =>
    window.posApi.listProducts(false),
  );
  const { data: categories } = useApi<CategoryDTO[]>(() =>
    window.posApi.listCategories(false),
  );
  const [editing, setEditing] = useState<ProductDTO | 'new' | null>(null);
  const [showCategories, setShowCategories] = useState(false);
  const [search, setSearch] = useState('');

  const items = unwrap(products) || [];
  const cats = unwrap(categories) || [];

  const filtered = items.filter((p) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return p.name.toLowerCase().includes(q) || (p.nameAr || '').includes(q);
  });

  return (
    <div>
      <div className="page-header">
        <h1>{t('products.title')}</h1>
        <div className="flex gap-8">
          <button className="btn" onClick={() => setShowCategories(true)}>
            ☰ {t('categories.title')}
          </button>
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            + {t('products.add')}
          </button>
        </div>
      </div>

      <input
        className="form-control mb-16"
        placeholder={t('products.searchPlaceholder')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="icon">📦</div>
          <div>{t('products.noProducts')}</div>
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('products.name')}</th>
              <th>{t('products.category')}</th>
              <th>{t('products.sellingType')}</th>
              <th>{t('products.price')}</th>
              <th>{t('products.stock')}</th>
              <th>{t('common.active')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((product) => {
              const unit = SELLING_UNIT_LABELS[product.sellingUnit];
              const priceStr =
                product.priceCurrency === 'USD'
                  ? formatUsd(product.currentPrice)
                  : formatLbp(product.currentPrice);
              const cat = cats.find((c) => c.id === product.categoryId);
              const categoryName = isRtl && cat?.nameAr ? cat.nameAr : cat?.name || '—';
              const stockMinor = product.stockMinor ?? 0;
              const stockDisplay =
                product.sellingUnit === 'WEIGHT'
                  ? `${(stockMinor / 1000).toFixed(3)} KG`
                  : stockMinor;
              return (
                <tr key={product.id}>
                  <td>
                    <strong>{isRtl && product.nameAr ? product.nameAr : product.name}</strong>
                    {isRtl && product.name && (
                      <div className="text-muted" style={{ fontSize: 11 }}>
                        {product.name}
                      </div>
                    )}
                  </td>
                  <td>{categoryName}</td>
                  <td>
                    {t(`unit.${unit.short === 'KG' ? 'weight' : unit.short === 'BOX' ? 'package' : 'piece'}`)}
                  </td>
                  <td>
                    {priceStr}
                    <div className="text-muted" style={{ fontSize: 11 }}>
                      {product.priceCurrency}
                      {product.sellingUnit === 'WEIGHT' ? ` / ${t('unit.kg')}` : ''}
                    </div>
                  </td>
                  <td>{stockDisplay}</td>
                  <td>
                    <span
                      className={`text-${product.active ? 'success' : 'danger'}`}
                      style={{ fontWeight: 600 }}
                    >
                      {product.active ? t('common.active') : t('common.inactive')}
                    </span>
                  </td>
                  <td>
                    <div className="flex gap-8">
                      <button
                        className="btn btn-small"
                        onClick={() => setEditing(product)}
                      >
                        {t('common.edit')}
                      </button>
                      <button
                        className="btn btn-small"
                        onClick={async () => {
                          await window.posApi.toggleProductActive(product.id);
                          reloadProducts();
                        }}
                      >
                        {product.active ? t('products.deactivate') : t('products.activate')}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {editing && (
        <ProductEditDialog
          product={editing === 'new' ? null : editing}
          categories={cats}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reloadProducts();
          }}
        />
      )}

      {showCategories && (
        <CategoriesDialog
          categories={cats}
          onClose={() => setShowCategories(false)}
          onSaved={() => setShowCategories(false)}
        />
      )}
    </div>
  );
}

function ProductEditDialog({
  product,
  categories,
  onClose,
  onSaved,
}: {
  product: ProductDTO | null;
  categories: CategoryDTO[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, isRtl } = useI18n();
  const [name, setName] = useState(product?.name ?? '');
  const [nameAr, setNameAr] = useState(product?.nameAr ?? '');
  const [categoryId, setCategoryId] = useState<number>(
    product?.categoryId ?? categories[0]?.id ?? 0,
  );
  const [sellingUnit, setSellingUnit] = useState<SellingUnit>(
    product?.sellingUnit ?? 'WEIGHT',
  );
  const [priceStr, setPriceStr] = useState(
    product ? (product.currentPrice / (product.priceCurrency === 'USD' ? 100 : 1)).toString() : '',
  );
  const [priceCurrency, setPriceCurrency] = useState<Currency>(
    product?.priceCurrency ?? 'USD',
  );
  const [costStr, setCostStr] = useState(
    product?.currentCost
      ? (product.currentCost / (product.priceCurrency === 'USD' ? 100 : 1)).toString()
      : '',
  );
  const [lowStockStr, setLowStockStr] = useState(
    product?.lowStockThreshold == null
      ? ''
      : product.sellingUnit === 'WEIGHT'
        ? (product.lowStockThreshold / 1000).toFixed(3)
        : product.lowStockThreshold.toString(),
  );
  const [notes, setNotes] = useState(product?.notes ?? '');
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(
    product?.imageDataUrl ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1_500_000) {
      setError('Image too large (max ~1MB)');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setImageDataUrl(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleSave = async () => {
    setError(null);
    if (!name.trim()) {
      setError(t('validation.required') + ': ' + t('products.name'));
      return;
    }
    if (!categoryId) {
      setError(t('validation.required') + ': ' + t('products.category'));
      return;
    }
    try {
      const priceMinor = parseMoney(priceStr, priceCurrency);
      const costMinor = costStr.trim()
        ? parseMoney(costStr, priceCurrency)
        : null;
      const lowStockInput = lowStockStr.trim();
      let lowStock: number | null = null;
      if (lowStockInput) {
        if (sellingUnit === 'WEIGHT') {
          lowStock = /^0+(?:[.,]0{1,3})?$/.test(lowStockInput)
            ? 0
            : parseWeightKg(lowStockInput);
        } else {
          if (!/^\d+$/.test(lowStockInput) || !Number.isSafeInteger(Number(lowStockInput))) {
            throw new Error(t('validation.positiveInteger'));
          }
          lowStock = Number(lowStockInput);
        }
      }

      setSaving(true);
      if (product) {
        await window.posApi.updateProduct(product.id, {
          name: name.trim(),
          nameAr: nameAr.trim(),
          categoryId,
          sellingUnit,
          currentPrice: priceMinor,
          priceCurrency,
          currentCost: costMinor,
          storeAsUsd: true,
          lowStockThreshold: lowStock,
          imageDataUrl,
          notes: notes.trim(),
        });
      } else {
        await window.posApi.createProduct({
          name: name.trim(),
          nameAr: nameAr.trim(),
          categoryId,
          sellingUnit,
          currentPrice: priceMinor,
          priceCurrency,
          currentCost: costMinor,
          storeAsUsd: true,
          lowStockThreshold: lowStock,
          imageDataUrl,
          notes: notes.trim(),
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{product ? t('products.edit') : t('products.add')}</h2>
          <button className="btn btn-small" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <div className="form-row">
          <div className="form-group">
            <label>{t('products.name')} *</label>
            <input
              className="form-control"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="form-group">
            <label>{t('products.nameAr')}</label>
            <input
              className="form-control"
              value={nameAr}
              onChange={(e) => setNameAr(e.target.value)}
              dir="rtl"
            />
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>{t('products.category')} *</label>
            <select
              className="form-control"
              value={categoryId}
              onChange={(e) => setCategoryId(parseInt(e.target.value, 10))}
            >
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {isRtl && cat.nameAr ? cat.nameAr : cat.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>{t('products.sellingType')}</label>
            <select
              className="form-control"
              value={sellingUnit}
              onChange={(e) => setSellingUnit(e.target.value as SellingUnit)}
            >
              <option value="WEIGHT">{t('products.weight')}</option>
              <option value="PACKAGE">{t('products.package')}</option>
              <option value="PIECE">{t('products.piece')}</option>
            </select>
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>{t('products.price')} *</label>
            <input
              className="form-control"
              value={priceStr}
              onChange={(e) => setPriceStr(e.target.value)}
              inputMode="decimal"
              placeholder="4.50"
            />
          </div>
          <div className="form-group">
            <label>{t('products.currency')}</label>
            <select
              className="form-control"
              value={priceCurrency}
              onChange={(e) => {
                const next = e.target.value as Currency;
                if (next !== priceCurrency) {
                  // Old numbers belong to the old currency: force re-entry instead of reinterpreting.
                  setPriceStr('');
                  setCostStr('');
                }
                setPriceCurrency(next);
              }}
            >
              <option value="USD">USD</option>
              <option value="LBP">LBP</option>
            </select>
            {priceCurrency === 'LBP' && (
              <div className="text-muted" style={{ fontSize: 12, marginTop: 4 }}>{t('products.lbpConvertNote')}</div>
            )}
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>{t('products.cost')}</label>
            <input
              className="form-control"
              value={costStr}
              onChange={(e) => setCostStr(e.target.value)}
              inputMode="decimal"
              placeholder="3.50"
            />
          </div>
          <div className="form-group">
            <label>{t('products.lowStock')}</label>
            <input
              className="form-control"
              value={lowStockStr}
              onChange={(e) => setLowStockStr(e.target.value)}
              inputMode={sellingUnit === 'WEIGHT' ? 'decimal' : 'numeric'}
              placeholder={sellingUnit === 'WEIGHT' ? '1.000' : '10'}
            />
            <div className="text-muted" style={{ fontSize: 12, marginTop: 4 }}>
              {sellingUnit === 'WEIGHT'
                ? 'KG'
                : t(sellingUnit === 'PACKAGE' ? 'products.package' : 'products.piece')}
            </div>
          </div>
        </div>

        <div className="form-group">
          <label>{t('products.image')}</label>
          <input type="file" accept="image/*" onChange={handleImage} />
          {imageDataUrl && (
            <div style={{ marginTop: 8 }}>
              <img
                src={imageDataUrl}
                alt="preview"
                style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 8 }}
              />
              <button
                className="btn btn-small"
                onClick={() => setImageDataUrl(null)}
                style={{ marginLeft: 8 }}
              >
                {t('common.delete')}
              </button>
            </div>
          )}
        </div>

        <div className="form-group">
          <label>{t('products.notes')}</label>
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
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? <span className="spinner" /> : t('products.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

function CategoriesDialog({
  categories,
  onClose,
  onSaved,
}: {
  categories: CategoryDTO[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [sortOrder, setSortOrder] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState(categories);

  const handleAdd = async () => {
    setError(null);
    if (!name.trim()) {
      setError(t('validation.required'));
      return;
    }
    const result = await window.posApi.createCategory({
      name: name.trim(),
      nameAr: nameAr.trim(),
      sortOrder: parseInt(sortOrder, 10) || 0,
    });
    if (result && 'error' in result) {
      setError(result.error.userMessage);
      return;
    }
    setItems([...items, result as CategoryDTO]);
    setName('');
    setNameAr('');
    setSortOrder('0');
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('categories.title')}</h2>
          <button className="btn btn-small" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <table className="data-table mb-16">
          <thead>
            <tr>
              <th>{t('categories.name')}</th>
              <th>{t('categories.nameAr')}</th>
              <th>{t('categories.sortOrder')}</th>
              <th>{t('common.active')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((cat) => (
              <tr key={cat.id}>
                <td>{cat.name}</td>
                <td dir="rtl">{cat.nameAr || '—'}</td>
                <td>{cat.sortOrder}</td>
                <td>
                  <button
                    className="btn btn-small"
                    onClick={async () => {
                      await window.posApi.toggleCategoryActive(cat.id);
                      setItems(
                        items.map((c) =>
                          c.id === cat.id ? { ...c, active: !c.active } : c,
                        ),
                      );
                    }}
                  >
                    {cat.active ? t('products.deactivate') : t('products.activate')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="form-row">
          <div className="form-group">
            <label>{t('categories.name')}</label>
            <input
              className="form-control"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>{t('categories.nameAr')}</label>
            <input
              className="form-control"
              value={nameAr}
              onChange={(e) => setNameAr(e.target.value)}
              dir="rtl"
            />
          </div>
        </div>

        <div className="form-group">
          <label>{t('categories.sortOrder')}</label>
          <input
            className="form-control"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            inputMode="numeric"
          />
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
          <button className="btn btn-primary" onClick={handleAdd}>
            {t('categories.add')}
          </button>
        </div>
      </div>
    </div>
  );
}
