import { useState } from 'react';
import { useI18n } from '../i18n';
import { setLanguage } from '../i18n';

interface Props {
  onDone: () => void;
}

export default function SetupWizard({ onDone }: Props) {
  const { t } = useI18n();
  const [shopName, setShopName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [defaultCurrency, setDefaultCurrency] = useState<'USD' | 'LBP'>('USD');
  const [language, setLanguageState] = useState<'en' | 'ar'>('en');
  const [exchangeRate, setExchangeRate] = useState('89500');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!shopName.trim()) {
      setError(t('setup.shopName') + ' ' + t('common.required'));
      return;
    }
    const rate = parseInt(exchangeRate, 10);
    if (!Number.isFinite(rate) || rate <= 0) {
      setError(t('validation.positiveInteger'));
      return;
    }

    setSubmitting(true);
    try {
      // Apply language immediately so UI updates
      setLanguage(language);
      const result = await window.posApi.completeFirstRun({
        shopName: shopName.trim(),
        phone: phone.trim(),
        address: address.trim(),
        defaultCurrency,
        language,
        exchangeRate: rate,
      });
      if (result && typeof result === 'object' && 'error' in result) {
        setError((result as { error: { userMessage: string } }).error.userMessage);
      } else {
        onDone();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="setup-container">
      <div className="setup-logo">🏪</div>
      <h1>{t('setup.welcome')}</h1>
      <p className="subtitle">{t('setup.subtitle')}</p>

      {error && <div className="alert alert-error">{error}</div>}

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>{t('setup.shopName')} *</label>
          <input
            className="form-control"
            value={shopName}
            onChange={(e) => setShopName(e.target.value)}
            autoFocus
          />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>{t('setup.phone')}</label>
            <input
              className="form-control"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>{t('setup.language')}</label>
            <select
              className="form-control"
              value={language}
              onChange={(e) => {
                const lang = e.target.value as 'en' | 'ar';
                setLanguageState(lang);
                setLanguage(lang); // live switch
              }}
            >
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </select>
          </div>
        </div>
        <div className="form-group">
          <label>{t('setup.address')}</label>
          <input
            className="form-control"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>{t('setup.defaultCurrency')}</label>
            <select
              className="form-control"
              value={defaultCurrency}
              onChange={(e) =>
                setDefaultCurrency(e.target.value as 'USD' | 'LBP')
              }
            >
              <option value="USD">USD ($)</option>
              <option value="LBP">LBP</option>
            </select>
          </div>
          <div className="form-group">
            <label>{t('setup.exchangeRate')}</label>
            <input
              className="form-control"
              value={exchangeRate}
              onChange={(e) => setExchangeRate(e.target.value)}
              placeholder="89500"
            />
            <small className="text-muted">{t('setup.exchangeRateHint')}</small>
          </div>
        </div>

        <button
          type="submit"
          className="btn btn-primary btn-large"
          style={{ width: '100%' }}
          disabled={submitting}
        >
          {submitting ? <span className="spinner" /> : t('setup.start')}
        </button>
      </form>
    </div>
  );
}
