# Lovely Admin Tools Implementation Plan

> **For agentic workers:** implement task-by-task. **Do NOT run git** — the user commits all changes themselves. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Add admin-only **Verification queue** (approve pending Lovely signups) + **Onboarding funnel** (read-only) as sub-tabs in the existing Lovely tab.

**Architecture:** Both tabs derive from the existing `useLovelyUsers()` list. The only new backend is `lovely-verify-user` (edge function on the Lovely project, `verify_jwt=false`) which validates the caller's makelila JWT, enforces `finance`/`admin` server-side via makelila `profiles`, and flips `is_verified` with the Lovely service role. UI gated by a new `isLeadership(role)` helper.

**Tech Stack:** Supabase Edge Functions (Deno), React 19 + TS, Vite, CSS Modules, Vitest.

Spec: [`docs/superpowers/specs/2026-06-17-lovely-admin-tools-design.md`](../specs/2026-06-17-lovely-admin-tools-design.md)

**Commit policy:** Leave all changes uncommitted. Do not `git add/commit/merge/push`. The deploy of `lovely-verify-user` is handled by the controller via the Supabase MCP (not the implementer).

---

### Task 1: `lovely-verify-user` edge function (Lovely project)

**Files:** Create `app/supabase/functions/lovely-verify-user/index.ts`

- [ ] **Step 1: Create the source**

```ts
// lovely-verify-user — Supabase Edge Function
//
// ⚠️ DEPLOYS TO THE **LOVELY** PROJECT (ref arfdopgbvlfmhmcfghhl), NOT makelila. verify_jwt=false.
//
// Approves a pending Lovely-app user (is_verified=true). Admin-only:
//   1. validates the caller's makelila operator JWT (@virgohome.io), AND
//   2. requires the caller to be finance/admin in makelila's `profiles`.
// Reads makelila profiles with the caller's own token (RLS allows authenticated read);
// writes the Lovely `users` row with the Lovely service role. Mirrors lovely-users.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MAKELILA_URL = 'https://txeftbbzeflequvrmjjr.supabase.co';
const MAKELILA_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4ZWZ0YmJ6ZWZsZXF1dnJtampyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNzk3NjcsImV4cCI6MjA5MTg1NTc2N30.sWmDCODRuhutbHuXcoVIVRvVvVyZADpNysFkerOXNPw';

const ALLOWED_EMAIL_DOMAIN = '@virgohome.io';
const LEADERSHIP_ROLES = ['finance', 'admin'];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // 1. Validate the makelila operator token.
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return json({ error: 'Missing authorization header' }, 401);
  const token = authHeader.replace('Bearer ', '');

  const makelila = createClient(MAKELILA_URL, MAKELILA_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: authErr } = await makelila.auth.getUser(token);
  const email = userData?.user?.email ?? '';
  if (authErr || !email.toLowerCase().endsWith(ALLOWED_EMAIL_DOMAIN)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // 2. Enforce leadership (finance/admin) server-side, read with the caller's own token.
  const { data: profile, error: roleErr } = await makelila
    .from('profiles')
    .select('role')
    .eq('id', userData!.user!.id)
    .single();
  if (roleErr || !LEADERSHIP_ROLES.includes((profile?.role as string) ?? '')) {
    return json({ error: 'Forbidden — leadership only' }, 403);
  }

  // 3. Read body.
  const body = await req.json().catch(() => ({})) as { user_id?: string };
  if (!body.user_id) return json({ error: 'Missing user_id' }, 400);

  // 4. Approve via the Lovely project's own service role.
  const lovely = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const nowIso = new Date().toISOString();
  const { data: updated, error: updErr } = await lovely
    .from('users')
    .update({ is_verified: true, verified_at: nowIso, updated_at: nowIso })
    .eq('id', body.user_id)
    .select('id, email, is_verified, verified_at')
    .single();
  if (updErr) {
    console.error('lovely-verify-user update error:', updErr);
    return json({ error: updErr.message }, 500);
  }

  return json({ user: updated });
});
```

> Confirm the `MAKELILA_ANON_KEY` literal matches `app/supabase/functions/lovely-users/index.ts` exactly (copy from there).

- [ ] **Step 2:** (Controller) deploy via Supabase MCP `deploy_edge_function`: `project_id=arfdopgbvlfmhmcfghhl`, `name=lovely-verify-user`, `verify_jwt=false`. Do NOT commit.

---

### Task 2: `isLeadership` permissions helper

**Files:** Modify `app/src/lib/permissions.ts`

- [ ] **Step 1:** After the `canView` function, add:

```ts
// Leadership tier = the de-facto admins today (finance) plus the future admin
// role. Used to gate admin-only surfaces (e.g. Lovely verification + funnel)
// without requiring a dedicated module flag.
export function isLeadership(role: Role | null | undefined): boolean {
  return role === 'finance' || role === 'admin';
}
```

- [ ] **Step 2:** Typecheck: `cd app && npx tsc -b` → no errors. Do NOT commit.

---

### Task 3: lib/lovely.ts — approve mutation + funnel helper (TDD)

**Files:** Modify `app/src/lib/lovely.ts`, `app/src/lib/lovely.test.ts`

- [ ] **Step 1: Add failing tests** — append to `app/src/lib/lovely.test.ts` (inside the file, after the existing `describe`):

```ts
import { onboardingFunnel, approveLovelyUser } from './lovely';

describe('onboardingFunnel', () => {
  const mk = (step: string | null) => ({
    id: step ?? 'x', email: 'a@x.com', first_name: null, last_name: null,
    serial_number: null, onboarding_step: step, is_verified: true, verified_at: null,
    mailing_list: null, last_login_at: null, login_count: null, created_at: null, updated_at: null,
  });

  it('returns canonical steps in order with counts and percentages', () => {
    const rows = onboardingFunnel([mk('tour_done'), mk('tour_done'), mk('pairing'), mk('hardware_done')]);
    const codes = rows.map(r => r.code);
    expect(codes.slice(0, 2)).toEqual(['pairing', 'welcome_done']); // canonical order preserved
    const tour = rows.find(r => r.code === 'tour_done')!;
    expect(tour.count).toBe(2);
    expect(tour.pct).toBe(50); // 2 of 4
    expect(rows.find(r => r.code === 'pairing')!.count).toBe(1);
  });

  it('appends unknown step codes after the canonical ones', () => {
    const rows = onboardingFunnel([mk('mystery_step')]);
    expect(rows[rows.length - 1].code).toBe('mystery_step');
    expect(rows[rows.length - 1].count).toBe(1);
  });
});

describe('approveLovelyUser', () => {
  it('POSTs user_id with the operator token and resolves on 2xx', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{"user":{}}') });
    await approveLovelyUser('u-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://lovely.supabase.co/functions/v1/lovely-verify-user',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ apikey: 'lovely-anon', Authorization: 'Bearer tok' }),
        body: JSON.stringify({ user_id: 'u-1' }),
      }),
    );
  });

  it('throws the function error body on non-2xx', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve('{"error":"Forbidden — leadership only"}') });
    await expect(approveLovelyUser('u-1')).rejects.toThrow(/Forbidden/);
  });
});
```

- [ ] **Step 2:** Run `cd app && npx vitest run src/lib/lovely.test.ts` → FAILS (exports missing).

- [ ] **Step 3: Implement** — append to `app/src/lib/lovely.ts`:

```ts
// ── Onboarding funnel ───────────────────────────────────────────────────────
// Canonical onboarding order, mirrored from the Lovely app
// (app/onboarding/page.tsx + app/api/onboarding/route.ts). 'pairing' is the
// initial DB default (just signed up); 'tour_done' = fully onboarded.
export const ONBOARDING_STEPS: { code: string; label: string }[] = [
  { code: 'pairing',          label: 'Signed up' },
  { code: 'welcome_done',     label: 'Welcome' },
  { code: 'quiz_done',        label: 'Preference quiz' },
  { code: 'customizing_done', label: 'Customizing' },
  { code: 'checklist_done',   label: 'Unboxing checklist' },
  { code: 'hardware_done',    label: 'Hardware walkthrough' },
  { code: 'pairing_done',     label: 'Paired device' },
  { code: 'tour_done',        label: 'Completed' },
];

export type FunnelRow = { code: string; label: string; count: number; pct: number };

export function onboardingFunnel(users: LovelyUser[]): FunnelRow[] {
  const total = users.length;
  const counts = new Map<string, number>();
  for (const u of users) {
    const k = u.onboarding_step || '(none)';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
  const rows: FunnelRow[] = ONBOARDING_STEPS.map(s => {
    const count = counts.get(s.code) ?? 0;
    counts.delete(s.code);
    return { code: s.code, label: s.label, count, pct: pct(count) };
  });
  for (const [code, count] of counts) {
    rows.push({ code, label: code, count, pct: pct(count) });
  }
  return rows;
}

// ── Approve (admin write) ───────────────────────────────────────────────────
// Calls the lovely-verify-user edge function (leadership-gated, server-side).
export async function approveLovelyUser(userId: string): Promise<void> {
  if (!isTelemetryConfigured || !TELEMETRY_URL || !TELEMETRY_ANON_KEY) {
    throw new Error('Lovely telemetry not configured.');
  }
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not signed in.');
  const res = await fetch(`${TELEMETRY_URL}/functions/v1/lovely-verify-user`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: TELEMETRY_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ user_id: userId }),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) detail = parsed.error;
    } catch { /* keep raw */ }
    throw new Error(`Approve failed (${res.status}): ${detail}`);
  }
}
```

- [ ] **Step 4:** Run `cd app && npx vitest run src/lib/lovely.test.ts` → PASSES. Do NOT commit.

---

### Task 4: Lovely module → sub-tabs (Users / Verification / Onboarding)

**Files:** Modify `app/src/modules/Lovely/index.tsx`; Create `UsersTab.tsx`, `VerificationTab.tsx`, `OnboardingTab.tsx`; Modify `Lovely.module.css`.

- [ ] **Step 1: Extract the users table** → create `app/src/modules/Lovely/UsersTab.tsx` with the table + search currently in `index.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { useLovelyUsers, type LovelyUser } from '../../lib/lovely';
import styles from './Lovely.module.css';

export function UsersTab() {
  const { users, loading, error, refetch } = useLovelyUsers();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(u =>
      fullName(u).toLowerCase().includes(q) ||
      (u.email?.toLowerCase().includes(q) ?? false) ||
      (u.serial_number?.toLowerCase().includes(q) ?? false),
    );
  }, [users, search]);

  const verifiedCount = useMemo(() => users.filter(u => u.is_verified).length, [users]);

  return (
    <>
      <div className={styles.kpiRow}>
        <div className={styles.kpi}><div className={styles.kpiLabel}>Total users</div><div className={styles.kpiValue}>{users.length}</div></div>
        <div className={styles.kpi}><div className={styles.kpiLabel}>Verified</div><div className={styles.kpiValue}>{verifiedCount}</div></div>
      </div>

      <div className={styles.filterBar}>
        <input type="search" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search name, email, serial…" className={styles.searchInput} />
        <div className={styles.resultCount}>{filtered.length} {filtered.length === 1 ? 'user' : 'users'}</div>
      </div>

      {error && <div className={styles.errorBar}>Error: {error}{' '}<button onClick={() => void refetch()} className={styles.retryBtn}>Retry</button></div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead><tr>
            <th>Name</th><th>Email</th><th>Paired serial</th><th>Onboarding</th>
            <th>Verified</th><th>Last login</th><th>Logins</th><th>Joined</th>
          </tr></thead>
          <tbody>
            {loading && users.length === 0 ? (
              <tr><td colSpan={8} className={styles.empty}>Loading users…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={8} className={styles.empty}>No users found.</td></tr>
            ) : filtered.map(u => <UserRow key={u.id} u={u} />)}
          </tbody>
        </table>
      </div>
    </>
  );
}

function fullName(u: LovelyUser): string { return [u.first_name, u.last_name].filter(Boolean).join(' '); }
function fmtDate(s: string | null): string {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' });
}
function UserRow({ u }: { u: LovelyUser }) {
  const name = fullName(u);
  return (
    <tr>
      <td><strong>{name || <span className={styles.muted}>—</span>}</strong></td>
      <td className={styles.mono}>{u.email || <span className={styles.muted}>—</span>}</td>
      <td className={styles.mono}>{u.serial_number || <span className={styles.muted}>—</span>}</td>
      <td>{u.onboarding_step || <span className={styles.muted}>—</span>}</td>
      <td><span className={u.is_verified ? styles.badgeOk : styles.badgeWarn}>{u.is_verified ? 'Verified' : 'Pending'}</span></td>
      <td className={styles.mono}>{fmtDate(u.last_login_at)}</td>
      <td>{u.login_count ?? 0}</td>
      <td className={styles.mono}>{fmtDate(u.created_at)}</td>
    </tr>
  );
}
```

- [ ] **Step 2: Create `app/src/modules/Lovely/VerificationTab.tsx`:**

```tsx
import { useMemo, useState } from 'react';
import { useLovelyUsers, approveLovelyUser, type LovelyUser } from '../../lib/lovely';
import { logAction } from '../../lib/activityLog';
import styles from './Lovely.module.css';

export function VerificationTab() {
  const { users, loading, error, refetch } = useLovelyUsers();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const pending = useMemo(
    () => users.filter(u => u.is_verified !== true)
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')),
    [users],
  );

  const approve = async (u: LovelyUser) => {
    setBusyId(u.id); setActionErr(null);
    try {
      await approveLovelyUser(u.id);
      await logAction('lovely_user_verified', u.email ?? u.id, `Approved Lovely app user ${u.email ?? u.id}`);
      await refetch();
    } catch (e) {
      setActionErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className={styles.sectionNote}>
        Approving sets the user to verified in the Lovely app — they’re let through the
        pending-approval gate on their next visit.
      </div>
      {error && <div className={styles.errorBar}>Error: {error}{' '}<button onClick={() => void refetch()} className={styles.retryBtn}>Retry</button></div>}
      {actionErr && <div className={styles.errorBar}>{actionErr}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead><tr><th>Name</th><th>Email</th><th>Paired serial</th><th>Step</th><th>Signed up</th><th></th></tr></thead>
          <tbody>
            {loading && users.length === 0 ? (
              <tr><td colSpan={6} className={styles.empty}>Loading…</td></tr>
            ) : pending.length === 0 ? (
              <tr><td colSpan={6} className={styles.empty}>No users pending verification. 🎉</td></tr>
            ) : pending.map(u => (
              <tr key={u.id}>
                <td><strong>{[u.first_name, u.last_name].filter(Boolean).join(' ') || <span className={styles.muted}>—</span>}</strong></td>
                <td className={styles.mono}>{u.email || <span className={styles.muted}>—</span>}</td>
                <td className={styles.mono}>{u.serial_number || <span className={styles.muted}>—</span>}</td>
                <td>{u.onboarding_step || <span className={styles.muted}>—</span>}</td>
                <td className={styles.mono}>{u.created_at ? new Date(u.created_at).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' }) : '—'}</td>
                <td><button className={styles.approveBtn} disabled={busyId === u.id} onClick={() => void approve(u)}>{busyId === u.id ? 'Approving…' : 'Approve'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
```

- [ ] **Step 3: Create `app/src/modules/Lovely/OnboardingTab.tsx`:**

```tsx
import { useMemo } from 'react';
import { useLovelyUsers, onboardingFunnel } from '../../lib/lovely';
import styles from './Lovely.module.css';

export function OnboardingTab({ onGoToVerification }: { onGoToVerification: () => void }) {
  const { users, loading, error, refetch } = useLovelyUsers();
  const rows = useMemo(() => onboardingFunnel(users), [users]);
  const pendingApproval = useMemo(() => users.filter(u => u.is_verified !== true).length, [users]);
  const max = Math.max(1, ...rows.map(r => r.count));

  if (loading && users.length === 0) return <div className={styles.empty}>Loading…</div>;

  return (
    <>
      {error && <div className={styles.errorBar}>Error: {error}{' '}<button onClick={() => void refetch()} className={styles.retryBtn}>Retry</button></div>}

      {pendingApproval > 0 && (
        <div className={styles.calloutBar}>
          {pendingApproval} user{pendingApproval === 1 ? '' : 's'} pending approval ·{' '}
          <button className={styles.linkBtn} onClick={onGoToVerification}>review →</button>
        </div>
      )}

      <div className={styles.funnel}>
        {rows.map(r => (
          <div key={r.code} className={styles.funnelRow}>
            <div className={styles.funnelLabel}>{r.label}</div>
            <div className={styles.funnelBarTrack}>
              <div className={styles.funnelBar} style={{ width: `${Math.round((r.count / max) * 100)}%` }} />
            </div>
            <div className={styles.funnelCount}>{r.count} <span className={styles.muted}>({r.pct}%)</span></div>
          </div>
        ))}
      </div>
    </>
  );
}
```

- [ ] **Step 4: Rewrite `app/src/modules/Lovely/index.tsx` as the sub-tab host:**

```tsx
import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { isLeadership } from '../../lib/permissions';
import { useLovelyUsers } from '../../lib/lovely';
import { UsersTab } from './UsersTab';
import { VerificationTab } from './VerificationTab';
import { OnboardingTab } from './OnboardingTab';
import styles from './Lovely.module.css';

type Tab = 'users' | 'verification' | 'onboarding';

export default function Lovely() {
  const { role } = useAuth();
  const admin = isLeadership(role);
  const { configured, loading, refetch } = useLovelyUsers();
  const [tab, setTab] = useState<Tab>('users');

  if (!configured) {
    return (
      <div className={styles.layout}>
        <div className={styles.header}><h2 className={styles.title}>Lovely</h2></div>
        <div className={styles.notice}>
          <h3>Lovely telemetry not configured</h3>
          <p>Set <code>VITE_TELEMETRY_SUPABASE_URL</code> and <code>VITE_TELEMETRY_SUPABASE_ANON_KEY</code> in <code>.env</code> and reload.</p>
        </div>
      </div>
    );
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'users', label: 'Users' },
    ...(admin ? [{ key: 'verification' as Tab, label: 'Verification' }, { key: 'onboarding' as Tab, label: 'Onboarding' }] : []),
  ];
  // Guard: if a non-admin somehow holds an admin tab in state, fall back.
  const activeTab: Tab = tabs.some(t => t.key === tab) ? tab : 'users';

  return (
    <div className={styles.layout}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>Lovely</h2>
          <div className={styles.subTabs}>
            {tabs.map(t => (
              <button key={t.key} className={`${styles.subTab} ${activeTab === t.key ? styles.subTabActive : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
            ))}
          </div>
        </div>
        <div className={styles.headerActions}>
          <button onClick={() => void refetch()} disabled={loading} className={styles.refreshBtn}>{loading ? 'Loading…' : '⟳ Refresh'}</button>
        </div>
      </div>

      {activeTab === 'users' && <UsersTab />}
      {activeTab === 'verification' && admin && <VerificationTab />}
      {activeTab === 'onboarding' && admin && <OnboardingTab onGoToVerification={() => setTab('verification')} />}
    </div>
  );
}
```

> Note: each tab calls `useLovelyUsers()` independently (a small refetch per tab switch). That's acceptable for ~dozens of users; if it ever matters, lift the hook to the host and pass data down. Keep as-is for V1.

- [ ] **Step 5: Append styles** to `app/src/modules/Lovely/Lovely.module.css`:

```css
.subTabs { display: inline-flex; gap: 4px; margin-left: 8px; }
.subTab { border: 1px solid transparent; background: transparent; color: #4a5568; border-radius: 6px; padding: 4px 10px; font-size: 13px; cursor: pointer; }
.subTab:hover { background: #f7fafc; }
.subTabActive { background: #edf2f7; color: #1a202c; font-weight: 600; }

.sectionNote { font-size: 12px; color: #718096; background: #f7fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px 12px; }
.calloutBar { font-size: 13px; color: #c05621; background: #fffaf0; border: 1px solid #feebc8; border-radius: 6px; padding: 8px 12px; }
.linkBtn { background: none; border: none; color: #2b6cb0; cursor: pointer; font-size: 13px; padding: 0; text-decoration: underline; }
.approveBtn { border: 1px solid #38a169; background: #38a169; color: #fff; border-radius: 6px; padding: 5px 12px; font-size: 13px; cursor: pointer; }
.approveBtn:disabled { opacity: 0.6; cursor: default; }

.funnel { display: flex; flex-direction: column; gap: 8px; }
.funnelRow { display: grid; grid-template-columns: 160px 1fr 90px; align-items: center; gap: 12px; }
.funnelLabel { font-size: 13px; color: #2d3748; }
.funnelBarTrack { background: #edf2f7; border-radius: 4px; height: 18px; overflow: hidden; }
.funnelBar { background: #4299e1; height: 100%; border-radius: 4px; min-width: 2px; }
.funnelCount { font-size: 13px; text-align: right; color: #2d3748; }
```

- [ ] **Step 6:** `cd app && npx tsc -b` → no errors. Do NOT commit.

---

### Task 5: Verify (controller)

- [ ] `cd app && npm run test:run` → all pass (incl. new lovely tests).
- [ ] `cd app && npm run lint` → 0 errors.
- [ ] `cd app && npm run build` → green.
- [ ] Live function gating (after Task 1 deploy): curl `lovely-verify-user` → **401** no token; with a real operator-role token → **403**; with a finance token → **200** + row flips. (Controller verifies what it can without minting tokens; the finance path is verified via the running app.)
- [ ] Leave everything uncommitted; report the working-tree diff to the user for them to commit/push.
