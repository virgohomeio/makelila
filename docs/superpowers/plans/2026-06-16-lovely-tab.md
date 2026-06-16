# Lovely Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a top-level "Lovely" tab to makelila that lists the Lovely app's users (the `public.users` table from the Lovely Supabase project).

**Architecture:** A `lovely-users` edge function deployed to the **Lovely** project (`arfdopgbvlfmhmcfghhl`, `verify_jwt=false`) reads `public.users` with that project's service-role key, but only after validating the caller's makelila operator JWT against makelila's auth server. The makelila frontend calls it through the existing `supabaseTelemetry` client (which supplies the Lovely anon `apikey`), passing the operator's makelila access token as the `Authorization` header. A thin `useLovelyUsers()` hook + a `Lovely` module render the table.

**Tech Stack:** Supabase Edge Functions (Deno), React 19 + TypeScript, Vite, CSS Modules, Vitest + `@testing-library/react`.

Spec: [`docs/superpowers/specs/2026-06-16-lovely-tab-design.md`](../specs/2026-06-16-lovely-tab-design.md)

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `app/supabase/functions/lovely-users/index.ts` | Edge function: auth-gated read of Lovely `public.users`. Deploys to the Lovely project. | Create |
| `app/src/lib/lovely.ts` | `LovelyUser` type + `useLovelyUsers()` hook. | Create |
| `app/src/lib/lovely.test.ts` | Unit test for the hook. | Create |
| `app/src/modules/Lovely/index.tsx` | Route-level page: states + users table. | Create |
| `app/src/modules/Lovely/Lovely.module.css` | Styles for the module. | Create |
| `app/src/App.tsx` | Lazy import + `/lovely` route. | Modify |
| `app/src/components/GlobalNav.tsx` | Desktop nav entry. | Modify |
| `app/src/components/MobileHome.tsx` | Mobile nav card. | Modify |
| `app/src/lib/permissions.ts` | Add `'lovely'` to `Module` union. | Modify |
| `app/.env.example` | Document `VITE_TELEMETRY_*` vars. | Modify |

---

### Task 1: `lovely-users` edge function (Lovely project)

**Files:**
- Create: `app/supabase/functions/lovely-users/index.ts`

- [ ] **Step 1: Create the function source**

Create `app/supabase/functions/lovely-users/index.ts`:

```ts
// lovely-users — Supabase Edge Function
//
// ⚠️ DEPLOYS TO THE **LOVELY** PROJECT (ref arfdopgbvlfmhmcfghhl), *NOT* makelila.
// The source lives in the makelila repo for cohesion, but any deploy
// (`supabase functions deploy` or the Supabase MCP) MUST target arfdopgbvlfmhmcfghhl.
//
// Returns the Lovely app `public.users` list to authenticated makelila operators
// only. That table is PII and is intentionally NOT anon-readable. This function
// reads it with the Lovely project's own service-role key, and gates access by
// validating the caller's *makelila* operator JWT against makelila's auth server.
//
// Deploy with verify_jwt = FALSE: the incoming token is a makelila JWT (not a
// Lovely JWT), so the gateway must not pre-verify it — auth is enforced in-body.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Public (non-secret) makelila project values — they already ship in the makelila
// frontend bundle. Used only to validate operator tokens against makelila auth.
const MAKELILA_URL = 'https://txeftbbzeflequvrmjjr.supabase.co';
const MAKELILA_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4ZWZ0YmJ6ZWZsZXF1dnJtampyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNzk3NjcsImV4cCI6MjA5MTg1NTc2N30.sWmDCODRuhutbHuXcoVIVRvVvVyZADpNysFkerOXNPw';

const ALLOWED_EMAIL_DOMAIN = '@virgohome.io';

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
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // 1. Require + validate the makelila operator token.
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ error: 'Missing authorization header' }, 401);
  }
  const token = authHeader.replace('Bearer ', '');

  const makelila = createClient(MAKELILA_URL, MAKELILA_ANON_KEY);
  const { data: userData, error: authErr } = await makelila.auth.getUser(token);
  const email = userData?.user?.email ?? '';
  if (authErr || !email.toLowerCase().endsWith(ALLOWED_EMAIL_DOMAIN)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // 2. Read the Lovely users with the Lovely project's own service role
  //    (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-provided in the env).
  const lovely = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: users, error: dbErr } = await lovely
    .from('users')
    .select(
      'id, email, first_name, last_name, serial_number, onboarding_step, is_verified, verified_at, mailing_list, last_login_at, login_count, created_at, updated_at',
    )
    .order('last_login_at', { ascending: false, nullsFirst: false });

  if (dbErr) {
    console.error('lovely-users DB error:', dbErr);
    return json({ error: dbErr.message }, 500);
  }

  return json({ users: users ?? [] });
});
```

> **Note:** Verify the `MAKELILA_ANON_KEY` literal exactly matches `VITE_SUPABASE_ANON_KEY` in `app/.env` (copy it verbatim — the value above is transcribed and must be confirmed before deploy; a wrong key makes every request 401).

- [ ] **Step 2: Deploy to the Lovely project**

Use the Supabase MCP `deploy_edge_function` tool with:
- `project_id`: `arfdopgbvlfmhmcfghhl`
- `name`: `lovely-users`
- `entrypoint_path`: `index.ts`
- `verify_jwt`: `false`
- `files`: `[{ name: 'index.ts', content: <the file above> }]`

Expected: deploy succeeds; the function appears in `list_edge_functions` for `arfdopgbvlfmhmcfghhl`.

- [ ] **Step 3: Verify auth gating (negative path)**

Run (PowerShell/bash) against the deployed function — no token should be rejected:

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST \
  "https://arfdopgbvlfmhmcfghhl.supabase.co/functions/v1/lovely-users" \
  -H "apikey: <LOVELY_ANON_KEY>"
```

Expected: `401` (missing/invalid authorization). `<LOVELY_ANON_KEY>` = the Lovely project's anon key (`get_publishable_keys` for `arfdopgbvlfmhmcfghhl`, or `VITE_TELEMETRY_SUPABASE_ANON_KEY`).

> Full positive-path verification (a real `@virgohome.io` makelila token returns the users array) happens via the running app in Task 5 — minting an operator JWT by hand here is not worth it.

- [ ] **Step 4: Commit**

```bash
git add app/supabase/functions/lovely-users/index.ts
git commit -m "feat(lovely): lovely-users edge function (auth-gated Lovely users read)"
```

---

### Task 2: `useLovelyUsers` hook + type (TDD)

**Files:**
- Create: `app/src/lib/lovely.ts`
- Test: `app/src/lib/lovely.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/lovely.test.ts`:

```ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { invokeMock, getSessionMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  getSessionMock: vi.fn(),
}));

vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: getSessionMock } },
}));

vi.mock('./supabaseTelemetry', () => ({
  isTelemetryConfigured: true,
  supabaseTelemetry: { functions: { invoke: invokeMock } },
}));

import { useLovelyUsers } from './lovely';

beforeEach(() => {
  invokeMock.mockReset();
  getSessionMock.mockReset();
  getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok' } } });
});

describe('useLovelyUsers', () => {
  it('loads users from the lovely-users function with the operator token', async () => {
    invokeMock.mockResolvedValue({
      data: {
        users: [{
          id: '1', email: 'a@x.com', first_name: 'A', last_name: null,
          serial_number: 'LL01', onboarding_step: 'done', is_verified: true,
          verified_at: null, mailing_list: false, last_login_at: null,
          login_count: 3, created_at: null, updated_at: null,
        }],
      },
      error: null,
    });

    const { result } = renderHook(() => useLovelyUsers());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.users).toHaveLength(1);
    expect(result.current.users[0].email).toBe('a@x.com');
    expect(result.current.error).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith('lovely-users', {
      headers: { Authorization: 'Bearer tok' },
    });
  });

  it('surfaces an error when the function fails', async () => {
    invokeMock.mockResolvedValue({ data: null, error: new Error('boom') });

    const { result } = renderHook(() => useLovelyUsers());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('boom');
    expect(result.current.users).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx vitest run src/lib/lovely.test.ts`
Expected: FAIL — cannot resolve `./lovely` (module not created yet).

- [ ] **Step 3: Implement the hook**

Create `app/src/lib/lovely.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { supabaseTelemetry, isTelemetryConfigured } from './supabaseTelemetry';

// Lovely app users, read from the Lovely project's `public.users` via the
// `lovely-users` edge function (deployed on the Lovely project). The table is
// PII and is NOT anon-readable, so the function gates on the makelila operator's
// JWT. We pass that operator token explicitly as the Authorization header; the
// telemetry client supplies the Lovely anon `apikey` automatically.
export type LovelyUser = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  serial_number: string | null;
  onboarding_step: string | null;
  is_verified: boolean | null;
  verified_at: string | null;
  mailing_list: boolean | null;
  last_login_at: string | null;
  login_count: number | null;
  created_at: string | null;
  updated_at: string | null;
};

export function useLovelyUsers() {
  const [users, setUsers] = useState<LovelyUser[]>([]);
  const [loading, setLoading] = useState<boolean>(isTelemetryConfigured);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!isTelemetryConfigured || !supabaseTelemetry) return;
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not signed in.');
      const { data, error: invokeErr } = await supabaseTelemetry.functions.invoke(
        'lovely-users',
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (invokeErr) throw invokeErr;
      setUsers(((data as { users?: LovelyUser[] } | null)?.users) ?? []);
    } catch (e) {
      setError((e as Error).message);
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { users, loading, error, configured: isTelemetryConfigured, refetch };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && npx vitest run src/lib/lovely.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/lovely.ts app/src/lib/lovely.test.ts
git commit -m "feat(lovely): useLovelyUsers hook + LovelyUser type"
```

---

### Task 3: `Lovely` module (page + styles)

**Files:**
- Create: `app/src/modules/Lovely/index.tsx`
- Create: `app/src/modules/Lovely/Lovely.module.css`

- [ ] **Step 1: Create the page component**

Create `app/src/modules/Lovely/index.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { useLovelyUsers, type LovelyUser } from '../../lib/lovely';
import styles from './Lovely.module.css';

export default function Lovely() {
  const { users, loading, error, configured, refetch } = useLovelyUsers();
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

  if (!configured) {
    return (
      <div className={styles.layout}>
        <div className={styles.header}><h2 className={styles.title}>Lovely</h2></div>
        <div className={styles.notice}>
          <h3>Lovely telemetry not configured</h3>
          <p>
            Set <code>VITE_TELEMETRY_SUPABASE_URL</code> and{' '}
            <code>VITE_TELEMETRY_SUPABASE_ANON_KEY</code> in <code>.env</code> and reload.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.layout}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>Lovely</h2>
          <span className={styles.subtitle}>Lovely app users</span>
        </div>
        <div className={styles.headerActions}>
          <button onClick={() => void refetch()} disabled={loading} className={styles.refreshBtn}>
            {loading ? 'Loading…' : '⟳ Refresh'}
          </button>
        </div>
      </div>

      <div className={styles.kpiRow}>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>Total users</div>
          <div className={styles.kpiValue}>{users.length}</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>Verified</div>
          <div className={styles.kpiValue}>{verifiedCount}</div>
        </div>
      </div>

      <div className={styles.filterBar}>
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search name, email, serial…"
          className={styles.searchInput}
        />
        <div className={styles.resultCount}>
          {filtered.length} {filtered.length === 1 ? 'user' : 'users'}
        </div>
      </div>

      {error && (
        <div className={styles.errorBar}>
          Error: {error}{' '}
          <button onClick={() => void refetch()} className={styles.retryBtn}>Retry</button>
        </div>
      )}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Paired serial</th>
              <th>Onboarding</th>
              <th>Verified</th>
              <th>Last login</th>
              <th>Logins</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {loading && users.length === 0 ? (
              <tr><td colSpan={8} className={styles.empty}>Loading users…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={8} className={styles.empty}>No users found.</td></tr>
            ) : (
              filtered.map(u => <UserRow key={u.id} u={u} />)
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function fullName(u: LovelyUser): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ');
}

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
      <td>
        <span className={u.is_verified ? styles.badgeOk : styles.badgeWarn}>
          {u.is_verified ? 'Verified' : 'Pending'}
        </span>
      </td>
      <td className={styles.mono}>{fmtDate(u.last_login_at)}</td>
      <td>{u.login_count ?? 0}</td>
      <td className={styles.mono}>{fmtDate(u.created_at)}</td>
    </tr>
  );
}
```

- [ ] **Step 2: Create the stylesheet**

Create `app/src/modules/Lovely/Lovely.module.css`:

```css
.layout { padding: 24px; display: flex; flex-direction: column; gap: 16px; }

.header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.titleRow { display: flex; align-items: baseline; gap: 12px; }
.title { margin: 0; font-size: 22px; font-weight: 700; color: #1a202c; }
.subtitle { font-size: 13px; color: #718096; }
.headerActions { display: flex; gap: 8px; }

.refreshBtn, .retryBtn {
  border: 1px solid #cbd5e0; background: #fff; color: #2d3748;
  border-radius: 6px; padding: 6px 12px; font-size: 13px; cursor: pointer;
}
.refreshBtn:disabled { opacity: 0.6; cursor: default; }

.notice {
  padding: 24px; color: #4a5568; background: #f7fafc;
  border: 1px solid #e2e8f0; border-radius: 8px;
}
.notice h3 { margin-top: 0; }
.notice code { background: #edf2f7; padding: 1px 5px; border-radius: 4px; font-size: 12px; }

.kpiRow { display: flex; gap: 12px; flex-wrap: wrap; }
.kpi {
  flex: 1; min-width: 140px; background: #fff; border: 1px solid #e2e8f0;
  border-radius: 8px; padding: 12px 16px;
}
.kpiLabel { font-size: 12px; color: #718096; }
.kpiValue { font-size: 24px; font-weight: 700; color: #1a202c; }

.filterBar { display: flex; align-items: center; gap: 12px; }
.searchInput {
  flex: 1; max-width: 360px; border: 1px solid #cbd5e0; border-radius: 6px;
  padding: 7px 10px; font-size: 13px;
}
.resultCount { font-size: 12px; color: #718096; margin-left: auto; }

.errorBar {
  background: #fff5f5; border: 1px solid #feb2b2; color: #c53030;
  border-radius: 6px; padding: 8px 12px; font-size: 13px;
}

.tableWrap { overflow-x: auto; border: 1px solid #e2e8f0; border-radius: 8px; }
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table thead th {
  text-align: left; padding: 10px 12px; background: #f7fafc;
  color: #4a5568; font-weight: 600; border-bottom: 1px solid #e2e8f0; white-space: nowrap;
}
.table tbody td { padding: 10px 12px; border-bottom: 1px solid #edf2f7; color: #2d3748; }
.table tbody tr:last-child td { border-bottom: none; }

.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.muted { color: #a0aec0; }
.empty { text-align: center; color: #a0aec0; padding: 24px; }

.badgeOk, .badgeWarn {
  font-size: 10px; padding: 2px 8px; border-radius: 4px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.3px;
}
.badgeOk { color: #276749; background: #c6f6d5; }
.badgeWarn { color: #c05621; background: #feebc8; }
```

- [ ] **Step 3: Typecheck the new module**

Run: `cd app && npx tsc -b`
Expected: no errors. (The route is not wired yet, but the module must compile.)

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/Lovely/index.tsx app/src/modules/Lovely/Lovely.module.css
git commit -m "feat(lovely): Lovely module — users table + states"
```

---

### Task 4: Wire route, nav, permissions, mobile, env docs

**Files:**
- Modify: `app/src/App.tsx`
- Modify: `app/src/components/GlobalNav.tsx`
- Modify: `app/src/components/MobileHome.tsx`
- Modify: `app/src/lib/permissions.ts`
- Modify: `app/.env.example`

- [ ] **Step 1: Add the lazy import + route in `App.tsx`**

In `app/src/App.tsx`, add to the lazy-import block (after the `Finance` line, ~line 27):

```tsx
const Lovely      = lazy(() => import('./modules/Lovely'));
```

And add the route inside the protected `<Route path="/">` block, immediately after the `customers` route (~line 78):

```tsx
            <Route path="lovely"        element={<LazyRoute><Lovely /></LazyRoute>} />
```

- [ ] **Step 2: Add the desktop nav entry in `GlobalNav.tsx`**

In `app/src/components/GlobalNav.tsx`, add to the `MODULES` array after the `/customers` entry:

```tsx
  { path: '/lovely',        label: 'Lovely' },
```

(No filter needed — it is visible to all authenticated operators, matching the default branch in `visibleModules`.)

- [ ] **Step 3: Add `'lovely'` to the `Module` union in `permissions.ts`**

In `app/src/lib/permissions.ts`, add `| 'lovely'` to the `Module` type:

```ts
  | 'customers'
  | 'lovely'
  | 'templates'
```

- [ ] **Step 4: Add the mobile nav card in `MobileHome.tsx`**

In `app/src/components/MobileHome.tsx`, add to the `WORKSPACE` array (after the `customers` card):

```tsx
  { to: '/lovely',       title: 'Lovely',       subtitle: 'Lovely app users',                      icon: '🌱', iconBg: '#e6f4ea' },
```

- [ ] **Step 5: Document the telemetry env vars in `.env.example`**

In `app/.env.example`, append:

```
# Lovely project (device telemetry + Lovely app users) — read-only second client
VITE_TELEMETRY_SUPABASE_URL=https://arfdopgbvlfmhmcfghhl.supabase.co
VITE_TELEMETRY_SUPABASE_ANON_KEY=your_lovely_anon_key_here
```

- [ ] **Step 6: Typecheck + build**

Run: `cd app && npm run build`
Expected: build succeeds (tsc + vite) with no type errors. The `/lovely` route and nav entry now resolve.

- [ ] **Step 7: Commit**

```bash
git add app/src/App.tsx app/src/components/GlobalNav.tsx app/src/components/MobileHome.tsx app/src/lib/permissions.ts app/.env.example
git commit -m "feat(lovely): wire /lovely route, nav, permissions, mobile card, env docs"
```

---

### Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit test suite**

Run: `cd app && npm run test:run`
Expected: all tests pass, including `src/lib/lovely.test.ts`.

- [ ] **Step 2: Build**

Run: `cd app && npm run build`
Expected: success, no type errors.

- [ ] **Step 3: Manual smoke (requires `VITE_TELEMETRY_*` set in `app/.env`)**

If `app/.env` lacks the telemetry vars, add them (URL + the Lovely anon key from `get_publishable_keys` for `arfdopgbvlfmhmcfghhl`). Then:

```bash
cd app && npm run dev
```

- Log in as a `@virgohome.io` operator.
- Click the new **Lovely** tab.
- Expected: the users table lists the Lovely app users (~11 today), ordered by last login. Search by name/email/serial filters the list. Refresh re-fetches.
- Without telemetry vars set: the tab shows the "Lovely telemetry not configured" panel (no crash).

- [ ] **Step 4: Confirm the negative auth path still holds**

Re-run the Task 1, Step 3 curl. Expected: `401` without a valid operator token.

---

## Notes for the executor

- The edge function source lives in the makelila repo but **deploys to the Lovely project** (`arfdopgbvlfmhmcfghhl`). Do not deploy it to makelila.
- `verify_jwt=false` is intentional (custom in-body auth). Do not change it to `true`.
- Before deploying, confirm the `MAKELILA_ANON_KEY` literal in the function matches `VITE_SUPABASE_ANON_KEY` in `app/.env` exactly.
- No realtime, pagination, editing, or per-user detail in V1 — keep scope to listing users.
