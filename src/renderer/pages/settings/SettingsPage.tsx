import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { unwrap, isError } from '../../hooks/useApi';
import { setLanguage } from '../../i18n';
import type {
  ShopInfo,
  Currency,
  Language,
  ExchangeRateInfo,
} from '@shared/types/index';

export default function SettingsPage() {
  const { t, lang } = useI18n();
  const [shop, setShop] = useState<ShopInfo | null>(null);
  const [rate, setRate] = useState<ExchangeRateInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteDatabase, setConfirmDeleteDatabase] = useState(false);
  const [deletingDatabase, setDeletingDatabase] = useState(false);
  const [printerSettings, setPrinterSettings] = useState<{
    enabled: boolean;
    printerName: string | null;
    paperWidth: 80 | 58;
    silent: boolean;
  } | null>(null);
  const [printers, setPrinters] = useState<
    Array<{ name: string; displayName: string }>
  >([]);

  const loadAll = async () => {
    const shopInfo = await window.posApi.getShopInfo();
    if (shopInfo && !('error' in shopInfo)) {
      setShop(shopInfo as ShopInfo);
    }
    const rateInfo = await window.posApi.getCurrentRate();
    if (rateInfo && !('error' in rateInfo)) {
      setRate(rateInfo as ExchangeRateInfo);
    }
    const printersList = await window.posApi.listPrinters();
    if (Array.isArray(printersList)) {
      setPrinters(
        printersList as Array<{ name: string; displayName: string }>,
      );
    }
    const ps = await window.posApi.getPrinterSettings();
    if (ps && !('error' in ps)) setPrinterSettings(ps);
    else
      setPrinterSettings({ enabled: false, printerName: null, paperWidth: 80, silent: true });
  };

  useEffect(() => {
    loadAll();
  }, []);

  // Shop fields
  const [shopName, setShopName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [defaultCurrency, setDefaultCurrency] = useState<Currency>('USD');
  const [language, setLanguageState] = useState<Language>('en');
  const [receiptHeader, setReceiptHeader] = useState('');
  const [receiptFooter, setReceiptFooter] = useState('');

  // Rate field
  const [rateInput, setRateInput] = useState('');

  useEffect(() => {
    if (shop) {
      setShopName(shop.shopName);
      setPhone(shop.phone || '');
      setAddress(shop.address || '');
      setDefaultCurrency(shop.defaultCurrency);
      setReceiptHeader(shop.receiptHeader || '');
      setReceiptFooter(shop.receiptFooter || '');
    }
  }, [shop]);

  useEffect(() => {
    setLanguageState(lang);
  }, [lang]);

  useEffect(() => {
    if (rate) setRateInput(rate.currentRate.toString());
  }, [rate]);

  const handleSaveShop = async () => {
    setError(null);
    setSaving(true);
    const result = await window.posApi.saveShopInfo({
      shopName: shopName.trim(),
      phone: phone.trim(),
      address: address.trim(),
      defaultCurrency,
      language,
      receiptHeader: receiptHeader.trim(),
      receiptFooter: receiptFooter.trim(),
    });
    setSaving(false);
    if (result && typeof result === 'object' && 'error' in result) {
      setError((result as { error: { userMessage: string } }).error.userMessage);
    } else {
      setSavedMsg(t('settings.saved'));
      setTimeout(() => setSavedMsg(null), 3000);
    }
  };

  const handleUpdateRate = async () => {
    setError(null);
    const r = parseInt(rateInput, 10);
    if (!Number.isFinite(r) || r <= 0) {
      setError(t('validation.positiveInteger'));
      return;
    }
    const result = await window.posApi.updateRate(r);
    if (result && typeof result === 'object' && 'error' in result) {
      setError((result as { error: { userMessage: string } }).error.userMessage);
    } else {
      setSavedMsg(t('settings.saved'));
      setTimeout(() => setSavedMsg(null), 3000);
    }
  };

  const handleSavePrinter = async () => {
    if (!printerSettings) return;
    setError(null);
    const r = await window.posApi.savePrinterSettings(printerSettings);
    if ('error' in r) setError(r.error.userMessage);
    else {
      setPrinterSettings(r);
      setSavedMsg(t('settings.saved'));
      setTimeout(() => setSavedMsg(null), 3000);
    }
  };

  const handleTestPrint = async () => {
    setError(null);
    if (printerSettings) {
      const saved = await window.posApi.savePrinterSettings(printerSettings);
      if ('error' in saved) {
        setError(saved.error.userMessage);
        return;
      }
    }
    const result = await window.posApi.testPrint();
    if (isError(result)) {
      setError(result.error.userMessage);
    } else if (!result.success) {
      setError(result.error || t('common.error'));
    } else {
      setSavedMsg('Test print sent');
      setTimeout(() => setSavedMsg(null), 3000);
    }
  };

  const handleDeleteDatabase = async () => {
    setError(null);
    setDeletingDatabase(true);
    try {
      const result = await window.posApi.deleteDatabase();
      if (result && typeof result === 'object' && 'error' in result) {
        setError(result.error.userMessage);
        setConfirmDeleteDatabase(false);
        return;
      }
      window.location.reload();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
      setConfirmDeleteDatabase(false);
    } finally {
      setDeletingDatabase(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1>{t('settings.title')}</h1>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {savedMsg && <div className="alert alert-success">{savedMsg}</div>}

      {/* Shop info */}
      <div className="card mb-16">
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>{t('settings.shop')}</h2>
        <div className="form-row">
          <div className="form-group">
            <label>{t('settings.shopName')}</label>
            <input
              className="form-control"
              value={shopName}
              onChange={(e) => setShopName(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>{t('settings.language')}</label>
            <select
              className="form-control"
              value={language}
              onChange={(e) => {
                const lang = e.target.value as Language;
                setLanguageState(lang);
                setLanguage(lang); // live switch
              }}
            >
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </select>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>{t('settings.phone')}</label>
            <input
              className="form-control"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>{t('settings.defaultCurrency')}</label>
            <select
              className="form-control"
              value={defaultCurrency}
              onChange={(e) => setDefaultCurrency(e.target.value as Currency)}
            >
              <option value="USD">USD</option>
              <option value="LBP">LBP</option>
            </select>
          </div>
        </div>
        <div className="form-group">
          <label>{t('settings.address')}</label>
          <input
            className="form-control"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label>{t('settings.receiptHeader')}</label>
          <input
            className="form-control"
            value={receiptHeader}
            onChange={(e) => setReceiptHeader(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label>{t('settings.receiptFooter')}</label>
          <input
            className="form-control"
            value={receiptFooter}
            onChange={(e) => setReceiptFooter(e.target.value)}
          />
        </div>
        <button className="btn btn-primary" onClick={handleSaveShop} disabled={saving}>
          {t('settings.save')}
        </button>
      </div>

      {/* Exchange rate */}
      <div className="card mb-16">
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>
          {t('settings.exchangeRate')}
        </h2>
        <div className="form-row">
          <div className="form-group">
            <label>{t('settings.exchangeRateHint')}</label>
            <input
              className="form-control"
              value={rateInput}
              onChange={(e) => setRateInput(e.target.value)}
              inputMode="numeric"
            />
          </div>
          <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button className="btn btn-primary" onClick={handleUpdateRate}>
              {t('settings.updateRate')}
            </button>
          </div>
        </div>
        {rate && (
          <div className="text-muted" style={{ fontSize: 12 }}>
            {t('settings.lastUpdated')}: {new Date(rate.updatedAt * 1000).toLocaleString()}
          </div>
        )}
      </div>

      {/* Printer settings */}
      <div className="card mb-16">
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>{t('settings.printer')}</h2>
        {printerSettings && (
          <>
            <div className="form-group">
              <label>
                <input
                  type="checkbox"
                  checked={printerSettings.enabled}
                  onChange={(e) =>
                    setPrinterSettings({
                      ...printerSettings,
                      enabled: e.target.checked,
                    })
                  }
                  style={{ marginRight: 8 }}
                />
                {t('settings.printerEnabled')}
              </label>
            </div>
            <div className="form-group">
              <label>{t('settings.printerName')}</label>
              <select
                className="form-control"
                value={printerSettings.printerName || ''}
                onChange={(e) =>
                  setPrinterSettings({
                    ...printerSettings,
                    printerName: e.target.value || null,
                  })
                }
                disabled={!printerSettings.enabled}
              >
                <option value="">{t('settings.systemDefaultPrinter')}</option>
                {printers.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>{t('settings.paperWidth')}</label>
                <select
                  className="form-control"
                  value={printerSettings.paperWidth}
                  onChange={(e) =>
                    setPrinterSettings({
                      ...printerSettings,
                      paperWidth: parseInt(e.target.value, 10) as 80 | 58,
                    })
                  }
                  disabled={!printerSettings.enabled}
                >
                  <option value="80">80mm</option>
                  <option value="58">58mm</option>
                </select>
              </div>
              <div className="form-group">
                <label>{t('settings.silentPrinting')}</label>
                <select
                  className="form-control"
                  value={printerSettings.silent ? '1' : '0'}
                  onChange={(e) =>
                    setPrinterSettings({
                      ...printerSettings,
                      silent: e.target.value === '1',
                    })
                  }
                  disabled={!printerSettings.enabled}
                >
                  <option value="1">{t('common.yes')}</option>
                  <option value="0">{t('settings.noShowDialog')}</option>
                </select>
              </div>

            </div>
            <button className="btn btn-primary" onClick={handleSavePrinter} style={{ marginInlineEnd: 8 }}>
              {t('common.save')}
            </button>
            <button
              className="btn"
              onClick={handleTestPrint}
              disabled={!printerSettings.enabled}
            >
              {t('settings.testPrint')}
            </button>
          </>
        )}
      </div>

      <div className="card mb-16">
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>{t('settings.deleteDatabase')}</h2>
        <p className="text-muted">{t('settings.deleteDatabaseDescription')}</p>
        <button
          className="btn btn-danger"
          onClick={() => setConfirmDeleteDatabase(true)}
          disabled={deletingDatabase}
        >
          {t('settings.deleteDatabase')}
        </button>
      </div>

      {confirmDeleteDatabase && (
        <div
          className="modal-overlay"
          onClick={() => !deletingDatabase && setConfirmDeleteDatabase(false)}
        >
          <div
            className="modal modal-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-database-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="delete-database-title">{t('settings.confirmDeleteDatabase')}</h2>
            </div>
            <p>{t('settings.confirmDeleteDatabaseText')}</p>
            <div className="modal-footer">
              <button
                className="btn"
                onClick={() => setConfirmDeleteDatabase(false)}
                disabled={deletingDatabase}
              >
                {t('common.cancel')}
              </button>
              <button
                className="btn btn-danger"
                onClick={handleDeleteDatabase}
                disabled={deletingDatabase}
              >
                {deletingDatabase
                  ? t('common.loading')
                  : t('settings.confirmDeleteDatabase')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
