import type { ReactNode } from 'react';
import { GlobalNav } from './GlobalNav';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="page">
      <div id="app-shell">
        <GlobalNav />
        <main style={{ background: '#fff', minHeight: 600, padding: 18 }}>
          {children}
        </main>
      </div>
    </div>
  );
}
