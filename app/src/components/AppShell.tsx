import type { CSSProperties, ReactNode } from 'react';
import { GlobalNav } from './GlobalNav';
import { NotificationsProvider } from '../lib/notifications';

// Inline style on <main> kept (no module CSS for the shell yet) but uses
// CSS env() + dvh so the iPhone notch + home indicator don't crop content.
// Mobile V1 changes (backlog #80):
//   - paddingTop honours env(safe-area-inset-top)
//   - paddingBottom honours env(safe-area-inset-bottom) so the iOS home
//     indicator doesn't sit on top of footer controls
//   - paddingLeft/Right honour safe-area for landscape orientation
//   - minHeight uses dvh so iOS Safari's collapsing URL bar doesn't crop
const mainStyle: CSSProperties = {
  background: '#fff',
  minHeight: 'calc(100dvh - var(--nav-height))',
  padding: '18px',
  paddingTop: 'max(18px, env(safe-area-inset-top))',
  paddingBottom: 'max(18px, env(safe-area-inset-bottom))',
  paddingLeft: 'max(18px, env(safe-area-inset-left))',
  paddingRight: 'max(18px, env(safe-area-inset-right))',
};

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <NotificationsProvider>
      <div className="page">
        <div id="app-shell">
          <GlobalNav />
          <main style={mainStyle}>
            {children}
          </main>
        </div>
      </div>
    </NotificationsProvider>
  );
}
