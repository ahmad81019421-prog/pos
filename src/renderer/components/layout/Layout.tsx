import { NavLink, useLocation } from 'react-router-dom';
import { useI18n } from '../../i18n';
import type { ReactNode } from 'react';

const navItems: Array<{ path: string; key: string; icon: string }> = [
  { path: '/', key: 'nav.sales', icon: '🛒' },
  { path: '/products', key: 'nav.products', icon: '📦' },
  { path: '/inventory', key: 'nav.inventory', icon: '📋' },
  { path: '/invoices', key: 'nav.invoices', icon: '🧾' },
  { path: '/customers', key: 'nav.customers', icon: '👥' },
  { path: '/reports', key: 'nav.reports', icon: '📊' },
  { path: '/expenses', key: 'nav.expenses', icon: '💸' },
  { path: '/settings', key: 'nav.settings', icon: '⚙️' },
  { path: '/backup', key: 'nav.backup', icon: '💾' },
];

export default function Layout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const location = useLocation();

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-sidebar-header">{t('app.title')}</div>
        <nav>
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={location.pathname === item.path ? 'active' : ''}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{t(item.key)}</span>
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="app-main">{children}</main>
    </div>
  );
}
