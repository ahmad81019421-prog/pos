import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n';
import Layout from '../components/layout/Layout';
import SetupWizard from '../pages/SetupWizard';
import PosPage from '../pages/pos/PosPage';
import ProductsPage from '../pages/products/ProductsPage';
import InventoryPage from '../pages/inventory/InventoryPage';
import InvoicesPage from '../pages/invoices/InvoicesPage';
import ReportsPage from '../pages/reports/ReportsPage';
import ExpensesPage from '../pages/expenses/ExpensesPage';
import SettingsPage from '../pages/settings/SettingsPage';
import CustomersPage from '../pages/customers/CustomersPage';
import BackupPage from '../pages/backup/BackupPage';

export default function App() {
  const { lang } = useI18n();
  const navigate = useNavigate();
  const [initialized, setInitialized] = useState<boolean | null>(null);

  // On mount: check if shop is initialized
  useEffect(() => {
    window.posApi.isInitialized().then((result) => {
      setInitialized(Boolean(result));
    });
  }, []);

  // Listen for menu navigation events from main process
  useEffect(() => {
    const offNav = window.posApi.onMenuNavigate((route: string) => {
      const map: Record<string, string> = {
        pos: '/',
        products: '/products',
        inventory: '/inventory',
        invoices: '/invoices',
        reports: '/reports',
        expenses: '/expenses',
        settings: '/settings',
        backup: '/backup',
      };
      navigate(map[route] || '/');
    });
    return () => {
      offNav();
    };
  }, [navigate]);

  // On mount: load shop info to set language
  useEffect(() => {
    if (initialized === false) return;
    window.posApi.getShopInfo().then((info) => {
      if (info && 'language' in info && info.language) {
        // Lazy import to avoid circular dependency
        import('../i18n').then(({ setLanguage }) => {
          setLanguage(info.language as 'en' | 'ar');
        });
      }
    });
  }, [initialized]);

  if (initialized === null) {
    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 16,
          color: '#5a5a60',
        }}
      >
        Loading Local POS...
      </div>
    );
  }

  if (!initialized) {
    return <SetupWizard onDone={() => setInitialized(true)} />;
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<PosPage />} />
        <Route path="/products" element={<ProductsPage />} />
        <Route path="/inventory" element={<InventoryPage />} />
        <Route path="/invoices" element={<InvoicesPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/expenses" element={<ExpensesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/customers" element={<CustomersPage />} />
        <Route path="/backup" element={<BackupPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
