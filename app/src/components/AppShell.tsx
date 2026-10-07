import type { ReactNode } from 'react';
import { GlobalNav } from './GlobalNav';
import { NotificationsProvider } from '../lib/notifications';
import styles from './AppShell.module.css';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <NotificationsProvider>
      <div className="page">
        <div id="app-shell">
          <GlobalNav />
          <main className={styles.main}>
            {children}
          </main>
        </div>
      </div>
    </NotificationsProvider>
  );
}
