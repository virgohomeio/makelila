import type { ReactNode } from 'react';
import { GlobalNav } from './GlobalNav';
import { NotificationsProvider } from '../lib/notifications';
import { UpdateBanner } from './UpdateBanner';
import styles from './AppShell.module.css';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <NotificationsProvider>
      <div className="page">
        {/* Outside the module routes: whichever page is open, a tab running a
            replaced build has to be able to say so. */}
        <UpdateBanner />
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
