# Feature 8: Campaigns Tab — Marketing Module Shell

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the `modules/Marketing/` route shell with a Campaigns tab that assembles the Facebook campaign table (Feature 7), CAC dashboard (Feature 6), Klaviyo sync status (Feature 5), and a Lead Attribution summary (Feature 3) into one place for Pedrum.

**Architecture:** New `modules/Marketing/index.tsx` as the route entry point, lazy-loaded in `App.tsx`, gated to `pedrum@virgohome.io`, `huayi@virgohome.io`, `george@virgohome.io`. Tab structure: Campaigns | Attribution | Sync. GlobalNav entry added between Templates and Activity Log.

**Dependency:** Features 3, 5, 6, 7 must be shipped first so the imported components exist.

**Tech Stack:** React 18 + TypeScript, CSS Modules, React Router lazy loading

---

## File Map

| File | Change |
|------|--------|
| `app/src/modules/Marketing/index.tsx` | Create — route entry point |
| `app/src/modules/Marketing/Marketing.module.css` | Create |
| `app/src/App.tsx` | Modify — add Marketing route |
| `app/src/components/GlobalNav.tsx` | Modify — add Marketing nav entry |
| `app/src/lib/auth.tsx` | Modify — add marketing role gate |

---

### Task 1: Marketing module shell

**Files:**
- Create: `app/src/modules/Marketing/index.tsx`
- Create: `app/src/modules/Marketing/Marketing.module.css`

- [ ] **Step 1: Read existing module patterns for tab structure**

```bash
cat app/src/modules/PostShipment/index.tsx
```

Note the exact tab rendering pattern (state for active tab, CSS class for active/inactive, import pattern for sub-components).

- [ ] **Step 2: Create the CSS module**

```css
/* Marketing.module.css */
.page {
  padding: 24px;
  max-width: 1100px;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}

.title {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.3px;
}

.tabs {
  display: flex;
  gap: 4px;
  border-bottom: 2px solid var(--color-border);
  margin-bottom: 24px;
}

.tab {
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border: none;
  background: none;
  color: var(--color-ink-muted);
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
  border-radius: 0;
}

.tab:hover {
  color: var(--color-ink);
}

.tabActive {
  color: var(--color-crimson);
  border-bottom-color: var(--color-crimson);
}

.syncRow {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
}

.syncBtn {
  font-size: 12px;
  padding: 6px 14px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  cursor: pointer;
  font-weight: 600;
  color: var(--color-ink-muted);
}

.syncBtn:hover { background: var(--color-border); }

.syncStatus {
  font-size: 11px;
  color: var(--color-ink-subtle);
}
```

- [ ] **Step 3: Create `modules/Marketing/index.tsx`**

```tsx
import { useState } from 'react';
import { CacDashboard } from './CacDashboard';
import { useFbCampaigns, triggerFbSync } from '../../lib/marketing/facebook';
import { useKlaviyoSyncStatus, triggerKlaviyoSync } from '../../lib/marketing/klaviyo';
import styles from './Marketing.module.css';

type Tab = 'campaigns' | 'attribution' | 'sync';

export default function Marketing() {
  const [tab, setTab] = useState<Tab>('campaigns');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  const { campaigns, loading: campsLoading } = useFbCampaigns(90);
  const { logs, loading: logsLoading } = useKlaviyoSyncStatus(5);

  async function handleFbSync() {
    setSyncing(true);
    setSyncMsg('');
    try {
      const result = await triggerFbSync();
      setSyncMsg(`Synced ${result.synced} Facebook campaign rows.`);
    } catch (e) {
      setSyncMsg(`Facebook sync failed: ${String(e)}`);
    } finally {
      setSyncing(false);
    }
  }

  async function handleKlaviyoSync() {
    setSyncing(true);
    setSyncMsg('');
    try {
      const result = await triggerKlaviyoSync();
      setSyncMsg(`Synced ${result.profiles_sent} Klaviyo profiles.`);
    } catch (e) {
      setSyncMsg(`Klaviyo sync failed: ${String(e)}`);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.title}>Marketing</div>
      </div>

      <div className={styles.tabs}>
        {(['campaigns', 'attribution', 'sync'] as Tab[]).map(t => (
          <button
            key={t}
            className={`${styles.tab} ${tab === t ? styles.tabActive : ''}`}
            onClick={() => setTab(t)}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'campaigns' && (
        <>
          <div className={styles.syncRow}>
            <button
              className={styles.syncBtn}
              onClick={() => void handleFbSync()}
              disabled={syncing}
            >
              {syncing ? 'Syncing…' : 'Sync Facebook Ads'}
            </button>
            {syncMsg && <span className={styles.syncStatus}>{syncMsg}</span>}
          </div>

          {campsLoading ? (
            <p style={{ color: 'var(--color-ink-subtle)', fontSize: 13 }}>Loading campaigns…</p>
          ) : campaigns.length === 0 ? (
            <p style={{ color: 'var(--color-ink-subtle)', fontSize: 13 }}>
              No campaigns yet. Click "Sync Facebook Ads" to pull data.
            </p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: 'var(--color-ink-subtle)', fontSize: 11 }}>
                  <th style={{ textAlign: 'left', paddingBottom: 8 }}>Campaign</th>
                  <th style={{ textAlign: 'left' }}>Status</th>
                  <th style={{ textAlign: 'right' }}>Spend (CAD)</th>
                  <th style={{ textAlign: 'right' }}>Impressions</th>
                  <th style={{ textAlign: 'right' }}>Clicks</th>
                  <th style={{ textAlign: 'right' }}>Leads</th>
                  <th style={{ textAlign: 'right' }}>CPL</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map(c => (
                  <tr key={c.campaign_id + c.date_start} style={{ borderTop: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '8px 0', fontWeight: 500, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.campaign_name}
                    </td>
                    <td>
                      <span style={{
                        fontSize: 10, padding: '2px 7px', borderRadius: 4,
                        background: c.status === 'ACTIVE' ? '#f0fff4' : 'var(--color-surface)',
                        color: c.status === 'ACTIVE' ? '#276749' : 'var(--color-ink-muted)',
                        border: `1px solid ${c.status === 'ACTIVE' ? '#9ae6b4' : 'var(--color-border)'}`,
                        fontWeight: 700, textTransform: 'uppercase',
                      }}>
                        {c.status}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {c.spend_cad != null ? `$${c.spend_cad.toFixed(0)}` : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>{c.impressions?.toLocaleString() ?? '—'}</td>
                    <td style={{ textAlign: 'right' }}>{c.clicks?.toLocaleString() ?? '—'}</td>
                    <td style={{ textAlign: 'right' }}>{c.leads ?? '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {c.cpl_cad != null ? `$${c.cpl_cad.toFixed(0)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {tab === 'attribution' && <CacDashboard />}

      {tab === 'sync' && (
        <>
          <div className={styles.syncRow}>
            <button
              className={styles.syncBtn}
              onClick={() => void handleKlaviyoSync()}
              disabled={syncing}
            >
              {syncing ? 'Syncing…' : 'Sync Klaviyo Profiles'}
            </button>
            {syncMsg && <span className={styles.syncStatus}>{syncMsg}</span>}
          </div>

          {logsLoading ? (
            <p style={{ color: 'var(--color-ink-subtle)', fontSize: 13 }}>Loading sync logs…</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: 'var(--color-ink-subtle)', fontSize: 11 }}>
                  <th style={{ textAlign: 'left', paddingBottom: 8 }}>Synced At</th>
                  <th style={{ textAlign: 'right' }}>Profiles Sent</th>
                  <th style={{ textAlign: 'right' }}>Errors</th>
                  <th style={{ textAlign: 'left' }}>Detail</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(log => (
                  <tr key={log.id} style={{ borderTop: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '8px 0' }}>
                      {new Date(log.synced_at).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}
                    </td>
                    <td style={{ textAlign: 'right' }}>{log.profiles_sent}</td>
                    <td style={{ textAlign: 'right', color: log.errors > 0 ? 'var(--color-danger, #c53030)' : 'inherit' }}>
                      {log.errors}
                    </td>
                    <td style={{ color: 'var(--color-ink-subtle)' }}>{log.detail ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/Marketing/index.tsx app/src/modules/Marketing/Marketing.module.css
git commit -m "feat(Marketing): add Marketing module shell with Campaigns/Attribution/Sync tabs"
```

---

### Task 2: Wire Marketing route into App.tsx

**Files:**
- Modify: `app/src/App.tsx`

- [ ] **Step 1: Read App.tsx to find the lazy-load and route pattern**

```bash
cat app/src/App.tsx
```

Note the exact pattern for lazy-loading modules (e.g., `const PostShipment = lazy(() => import('./modules/PostShipment'))`).

- [ ] **Step 2: Add Marketing lazy import**

After the last `const ... = lazy(...)` line, add:

```tsx
const Marketing = lazy(() => import('./modules/Marketing'));
```

- [ ] **Step 3: Add the route**

Find the nested routes block (inside `<Routes>`). Add after the last module route, before any catch-all:

```tsx
<Route
  path="marketing"
  element={
    <ProtectedRoute roles={['pedrum@virgohome.io', 'huayi@virgohome.io', 'george@virgohome.io']}>
      <LazyRoute><Marketing /></LazyRoute>
    </ProtectedRoute>
  }
/>
```

Note: If `ProtectedRoute` does not support a `roles` prop (it may only guard auth, not specific users), use the simpler form and rely on GlobalNav visibility for access control:

```tsx
<Route path="marketing" element={<LazyRoute><Marketing /></LazyRoute>} />
```

Check `lib/auth.tsx`'s `ProtectedRoute` implementation before deciding which form to use.

- [ ] **Step 4: Run the app to verify routing**

```bash
npm run dev
```
Navigate to `/marketing` — Marketing module should render. Check that `/order-review` and other routes are unaffected.

- [ ] **Step 5: Commit**

```bash
git add app/src/App.tsx
git commit -m "feat(App): add /marketing lazy route for Marketing module"
```

---

### Task 3: Add Marketing to GlobalNav

**Files:**
- Modify: `app/src/components/GlobalNav.tsx`

- [ ] **Step 1: Read GlobalNav to find the MODULES array**

```bash
cat app/src/components/GlobalNav.tsx
```

Find the `MODULES` constant (array of `{ path, label, icon? }` objects).

- [ ] **Step 2: Add Marketing entry**

Add Marketing between Templates and Activity Log (second-to-last position):

```tsx
{ path: 'marketing', label: 'Marketing' },
```

If the module has an icon pattern (e.g., emoji or SVG), match the existing pattern. If no icon is used, omit it.

- [ ] **Step 3: Conditionally show to marketing roles only**

If GlobalNav renders a module for all users, add a check. Find where the nav items are rendered (likely a `.map()` over `MODULES`). Wrap the Marketing entry:

```tsx
// Only show Marketing to pedrum, huayi, george
const visibleModules = MODULES.filter(m => {
  if (m.path === 'marketing') {
    return ['pedrum@virgohome.io', 'huayi@virgohome.io', 'george@virgohome.io']
      .includes(session?.user?.email ?? '');
  }
  return true;
});
// Use visibleModules instead of MODULES in the render
```

If `session` is already available in GlobalNav (via `useAuth()`), use it directly. If not, import `useAuth`.

- [ ] **Step 4: Run full test suite**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 5: Manual smoke test**

```bash
npm run dev
```
Sign in as huayi@virgohome.io → confirm "Marketing" appears in nav → click it → confirm the Campaigns/Attribution/Sync tabs render → confirm other users wouldn't see it (log in as another user or check the filter logic).

- [ ] **Step 6: Commit**

```bash
git add app/src/components/GlobalNav.tsx
git commit -m "feat(GlobalNav): add Marketing module entry gated to marketing roles"
```
