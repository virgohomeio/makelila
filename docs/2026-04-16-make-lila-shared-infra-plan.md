# Make Lila Shared Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the React + Supabase foundation for the Make Lila app: users can sign in with Google (@virgohome.io), navigate between 5 empty module placeholders, and any action writes to an `activity_log` table that streams back to the UI in realtime.

**Architecture:** React 18 + TypeScript + Vite SPA deployed to GitHub Pages. Supabase provides Postgres, Google OAuth, Row Level Security (RLS), and Realtime subscriptions. The existing `schema.sql` (project root) contains an older MRP schema — this plan adds only the two tables needed for shared infra (`profiles`, `activity_log`); module-specific tables come in later plans.

**Tech Stack:** React 18, TypeScript, Vite, React Router v6, @supabase/supabase-js, Vitest, Playwright, CSS Modules + CSS custom properties. Package manager: npm.

**Related docs:** Spec at `docs/2026-04-16-make-lila-app-design.md`. Existing Supabase project ID: `txeftbbzeflequvrmjjr` (referenced in `schema.sql`).

---

## File Structure

All new code lives under `E:\Claude\makelila\app/` (the React app) and `E:\Claude\makelila\supabase/` (DB migrations), leaving existing project root files (`schema.sql`, `seeds.sql`, `architecture.md`, the mockup `.html` files) in place.

```
E:\Claude\makelila\
  app/                                    ← NEW: React SPA
    package.json
    vite.config.ts
    tsconfig.json
    tsconfig.node.json
    index.html
    .env.example
    .env.local                            (gitignored)
    src/
      main.tsx                            App entry
      App.tsx                             Router + AuthProvider
      lib/
        supabase.ts                       Supabase client singleton
        auth.tsx                          AuthProvider, useAuth, ProtectedRoute
        activityLog.ts                    logAction + useActivityLog hook
      components/
        AppShell.tsx                      Layout wrapper (#app-shell, 1200px max)
        GlobalNav.tsx                     Brand + 5 module links + user badge
        UserBadge.tsx                     Avatar + name + sign-out
      modules/
        OrderReview.tsx                   Empty placeholder
        Fulfillment.tsx                   Empty placeholder
        PostShipment.tsx                  Empty placeholder
        Stock.tsx                         Empty placeholder
        ActivityLog.tsx                   Live feed (uses useActivityLog)
      styles/
        tokens.css                        Design tokens (colors, typography)
        globals.css                       Resets + #app-shell base
      test/
        setup.ts                          Vitest globals
    tests/
      e2e/
        smoke.spec.ts                     Playwright sign-in → log → realtime
      unit/
        activityLog.test.ts
        auth.test.ts
    playwright.config.ts
  supabase/                               ← NEW: DB migrations
    config.toml
    migrations/
      0001_profiles.sql
      0002_activity_log.sql
      0003_seed_team_members.sql
  .github/
    workflows/
      deploy.yml                          GitHub Pages deploy on push to main
  docs/
    2026-04-16-make-lila-app-design.md    (existing spec)
    2026-04-16-make-lila-shared-infra-plan.md   (this file)
```

### File responsibility boundaries

- `lib/supabase.ts` — single source of Supabase client; no React, no UI.
- `lib/auth.tsx` — React-aware auth state (AuthContext, useAuth, ProtectedRoute). Reads from `lib/supabase.ts`.
- `lib/activityLog.ts` — `logAction(type, entity, detail)` + `useActivityLog(limit)` hook with realtime. Reads from `lib/supabase.ts`.
- `components/` — presentation only; no DB access. Consume hooks from `lib/`.
- `modules/` — one file per module; current plan ships them as empty placeholders.

---

## Task 1: Initialize app/ directory with Vite + React + TypeScript

**Files:**
- Create: `E:\Claude\makelila\app\package.json`
- Create: `E:\Claude\makelila\app\index.html`
- Create: `E:\Claude\makelila\app\vite.config.ts`
- Create: `E:\Claude\makelila\app\tsconfig.json`
- Create: `E:\Claude\makelila\app\tsconfig.node.json`
- Create: `E:\Claude\makelila\app\.gitignore`
- Create: `E:\Claude\makelila\app\.env.example`
- Create: `E:\Claude\makelila\app\src\main.tsx`
- Create: `E:\Claude\makelila\app\src\App.tsx`

- [ ] **Step 1: Scaffold via npm create**

Run:
```bash
cd E:\Claude\makelila
npm create vite@latest app -- --template react-ts
cd app
npm install
```

Expected: creates `app/` with boilerplate; `npm install` completes without errors.

- [ ] **Step 2: Add router and Supabase dependencies**

Run:
```bash
cd E:\Claude\makelila\app
npm install react-router-dom @supabase/supabase-js
npm install -D @types/node
```

Expected: `package.json` shows all four deps added.

- [ ] **Step 3: Replace `src/App.tsx` with placeholder**

```tsx
// src/App.tsx
export default function App() {
  return <div>Make Lila — infra scaffold</div>;
}
```

- [ ] **Step 4: Verify dev server starts**

Run:
```bash
cd E:\Claude\makelila\app
npm run dev
```

Expected: Vite starts on `http://localhost:5173/`, page shows "Make Lila — infra scaffold".

Stop the server (Ctrl+C) before moving on.

- [ ] **Step 5: Create `.env.example`**

```
# Supabase — get from dashboard → Project Settings → API
VITE_SUPABASE_URL=https://txeftbbzeflequvrmjjr.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key_here
```

- [ ] **Step 6: Append to `app/.gitignore`**

Append to existing `.gitignore`:
```
.env.local
.env.*.local
```

- [ ] **Step 7: Commit**

```bash
cd E:\Claude\makelila
git add app/
git commit -m "feat(infra): scaffold React + TS + Vite app"
```

---

## Task 2: Vitest setup with one passing test

**Files:**
- Modify: `E:\Claude\makelila\app\package.json` (add test scripts)
- Modify: `E:\Claude\makelila\app\vite.config.ts` (add test config)
- Create: `E:\Claude\makelila\app\src\test\setup.ts`
- Create: `E:\Claude\makelila\app\src\lib\sanity.test.ts`

- [ ] **Step 1: Install Vitest + testing-library**

```bash
cd E:\Claude\makelila\app
npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom
```

- [ ] **Step 2: Replace `vite.config.ts` with Vitest-aware config**

```ts
// vite.config.ts
/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/makelila/',
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});
```

Note: `base: '/makelila/'` is required for GitHub Pages deploy under `<user>.github.io/makelila/`. Adjust if the repo name differs.

- [ ] **Step 3: Create test setup file**

```ts
// src/test/setup.ts
import '@testing-library/jest-dom';
```

- [ ] **Step 4: Add test script to `package.json`**

In the `"scripts"` block, add:
```json
"test": "vitest",
"test:run": "vitest run"
```

- [ ] **Step 5: Write the sanity test**

```ts
// src/lib/sanity.test.ts
import { describe, it, expect } from 'vitest';

describe('sanity', () => {
  it('runs the test harness', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: Run test**

```bash
cd E:\Claude\makelila\app
npm run test:run
```

Expected: 1 test file, 1 test passed.

- [ ] **Step 7: Commit**

```bash
cd E:\Claude\makelila
git add app/
git commit -m "feat(infra): set up Vitest with jsdom + testing-library"
```

---

## Task 3: Supabase local stack + CLI setup

**Files:**
- Create: `E:\Claude\makelila\supabase\config.toml`
- Modify: `E:\Claude\makelila\.gitignore` (root-level)

- [ ] **Step 1: Install Supabase CLI globally (if not present)**

```bash
npm install -g supabase
supabase --version
```

Expected: version string printed (e.g., `1.x.x`).

- [ ] **Step 2: Initialize Supabase project in repo**

```bash
cd E:\Claude\makelila
supabase init
```

Expected: creates `supabase/` directory with `config.toml`, `migrations/`, `seed.sql`, etc. If prompted about VS Code settings or Deno, answer "no".

- [ ] **Step 3: Link to existing Supabase project**

```bash
cd E:\Claude\makelila
supabase link --project-ref txeftbbzeflequvrmjjr
```

Expected: prompts for database password (retrieve from Supabase dashboard → Project Settings → Database); success message after.

- [ ] **Step 4: Pull current remote schema**

```bash
cd E:\Claude\makelila
supabase db pull
```

Expected: new migration file appears under `supabase/migrations/` reflecting current remote state (the existing MRP schema).

- [ ] **Step 5: Add root `.gitignore` entries for Supabase temp files**

Create or append to `E:\Claude\makelila\.gitignore`:
```
node_modules/
.env.local
.env.*.local
supabase/.temp/
supabase/.branches/
```

- [ ] **Step 6: Commit**

```bash
cd E:\Claude\makelila
git add supabase/ .gitignore
git commit -m "chore(infra): init Supabase CLI config and pull current schema"
```

---

## Task 4: Migration — `profiles` table

**Files:**
- Create: `E:\Claude\makelila\supabase\migrations\0002_profiles.sql` (use whatever number follows the one pulled in Task 3)

- [ ] **Step 1: Generate empty migration file**

```bash
cd E:\Claude\makelila
supabase migration new profiles
```

Expected: file `supabase/migrations/<timestamp>_profiles.sql` is created.

- [ ] **Step 2: Write migration SQL**

Paste into the new migration file:

```sql
-- profiles: 1:1 with auth.users, stores display name and role
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role text default 'member',
  created_at timestamptz not null default now()
);

-- Auto-insert profile on new auth user signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- RLS: all authenticated users can read all profiles; only the owner can update
alter table public.profiles enable row level security;

create policy "profiles_select_all_authenticated"
  on public.profiles for select
  to authenticated
  using (true);

create policy "profiles_update_self"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id);
```

- [ ] **Step 3: Apply migration to local stack**

```bash
cd E:\Claude\makelila
supabase start
supabase db reset
```

Expected: local Postgres running; migrations applied successfully; `profiles` table visible at `http://localhost:54323` (Supabase Studio).

- [ ] **Step 4: Smoke-test with a manual insert**

Open `http://localhost:54323` → SQL editor → run:
```sql
-- Should succeed
insert into auth.users (id, email, raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000001', 'test@virgohome.io',
        '{"full_name":"Test User"}'::jsonb);

-- Should show one row with display_name = 'Test User'
select * from public.profiles;
```

Expected: profile row auto-created by the trigger.

Clean up: `delete from auth.users where id = '00000000-0000-0000-0000-000000000001';`

- [ ] **Step 5: Commit**

```bash
cd E:\Claude\makelila
git add supabase/migrations/
git commit -m "feat(db): add profiles table with auth.users trigger and RLS"
```

---

## Task 5: Migration — `activity_log` table with realtime

**Files:**
- Create: `E:\Claude\makelila\supabase\migrations\<timestamp>_activity_log.sql`

- [ ] **Step 1: Generate migration file**

```bash
cd E:\Claude\makelila
supabase migration new activity_log
```

- [ ] **Step 2: Write migration SQL**

```sql
-- activity_log: UX-layer audit stream (distinct from row-level audit_log)
create table if not exists public.activity_log (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  ts timestamptz not null default now(),
  type text not null,
  entity text not null,
  detail text default ''
);

create index if not exists idx_activity_log_ts
  on public.activity_log (ts desc);
create index if not exists idx_activity_log_user_ts
  on public.activity_log (user_id, ts desc);

-- RLS: all authenticated users read all entries; insert stamps current user
alter table public.activity_log enable row level security;

create policy "activity_log_select_all_authenticated"
  on public.activity_log for select
  to authenticated
  using (true);

create policy "activity_log_insert_self"
  on public.activity_log for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Enable realtime for this table
alter publication supabase_realtime add table public.activity_log;
```

- [ ] **Step 3: Apply migration to local stack**

```bash
cd E:\Claude\makelila
supabase db reset
```

Expected: migration applies without errors.

- [ ] **Step 4: Smoke-test insert + select**

In `http://localhost:54323` SQL editor:
```sql
-- Setup a test user
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'test@virgohome.io');

-- Insert log entry
insert into public.activity_log (user_id, type, entity, detail)
values ('00000000-0000-0000-0000-000000000001',
        'test_action', 'Test Entity', 'Test detail');

-- Verify
select id, user_id, type, entity, detail from public.activity_log;

-- Cleanup
delete from auth.users where id = '00000000-0000-0000-0000-000000000001';
```

Expected: one row returned with `type = 'test_action'`.

- [ ] **Step 5: Commit**

```bash
cd E:\Claude\makelila
git add supabase/migrations/
git commit -m "feat(db): add activity_log table with RLS and realtime publication"
```

---

## Task 6: Migration — seed 7 team members

**Files:**
- Create: `E:\Claude\makelila\supabase\migrations\<timestamp>_seed_team_invite_list.sql`

Note: we cannot create `auth.users` entries via SQL that support real login — those are created by Supabase when a user first signs in through OAuth. This migration only documents the expected display names so profile rows get correctly labeled after the team signs in. If the auto-trigger from Task 4 picks up their Google full name, this seed may be skipped — but for deterministic UX we override.

- [ ] **Step 1: Generate migration file**

```bash
cd E:\Claude\makelila
supabase migration new seed_team_invite_list
```

- [ ] **Step 2: Write SQL — an invite-mapping table to override display names**

```sql
-- team_invite_list: maps emails to canonical display names.
-- On first sign-in, handle_new_user trigger will prefer this over Google's full_name.
create table if not exists public.team_invite_list (
  email text primary key,
  display_name text not null
);

insert into public.team_invite_list (email, display_name) values
  ('pedrum@virgohome.io',  'Pedrum'),
  ('raymond@virgohome.io', 'Raymond'),
  ('aaron@virgohome.io',   'Aaron'),
  ('ashwini@virgohome.io', 'Ashwini'),
  ('junaid@virgohome.io',  'Junaid'),
  ('huayi@virgohome.io',   'Huayi'),
  ('george@virgohome.io',  'George')
on conflict (email) do update set display_name = excluded.display_name;

-- Update handle_new_user to prefer invite_list display_name
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
declare
  override_name text;
begin
  select display_name into override_name
    from public.team_invite_list where email = new.email;

  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(override_name, new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

-- RLS: read-only for authenticated
alter table public.team_invite_list enable row level security;
create policy "invite_list_select" on public.team_invite_list
  for select to authenticated using (true);
```

- [ ] **Step 3: Apply and verify**

```bash
cd E:\Claude\makelila
supabase db reset
```

In Supabase Studio → SQL editor:
```sql
select * from public.team_invite_list order by display_name;
```

Expected: 7 rows.

- [ ] **Step 4: Commit**

```bash
cd E:\Claude\makelila
git add supabase/migrations/
git commit -m "feat(db): seed team_invite_list with 7 @virgohome.io members"
```

---

## Task 7: Supabase client singleton

**Files:**
- Create: `E:\Claude\makelila\app\src\lib\supabase.ts`

- [ ] **Step 1: Write failing test**

Create `E:\Claude\makelila\app\src\lib\supabase.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { supabase } from './supabase';

describe('supabase client', () => {
  it('exposes an auth namespace', () => {
    expect(supabase.auth).toBeDefined();
    expect(typeof supabase.auth.getSession).toBe('function');
  });

  it('exposes a from() builder', () => {
    expect(typeof supabase.from).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd E:\Claude\makelila\app
npm run test:run -- supabase
```

Expected: FAIL with "Cannot find module './supabase'".

- [ ] **Step 3: Create `.env.local` with local Supabase credentials**

Get local URL + anon key:
```bash
cd E:\Claude\makelila
supabase status
```

Copy the `API URL` and `anon key` from the output into `E:\Claude\makelila\app\.env.local`:
```
VITE_SUPABASE_URL=http://localhost:54321
VITE_SUPABASE_ANON_KEY=<anon key from supabase status>
```

- [ ] **Step 4: Implement the client**

```ts
// src/lib/supabase.ts
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. ' +
    'Copy .env.example to .env.local and fill in values.'
  );
}

export const supabase = createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd E:\Claude\makelila\app
npm run test:run -- supabase
```

Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
cd E:\Claude\makelila
git add app/src/lib/supabase.ts app/src/lib/supabase.test.ts app/.env.example
git commit -m "feat(app): add supabase client singleton with env validation"
```

---

## Task 8: Configure Google OAuth in Supabase (manual, documented)

This task has no code — it's dashboard configuration. Document the steps so engineers repeat reliably across environments.

**Files:**
- Create: `E:\Claude\makelila\docs\supabase-google-oauth-setup.md`

- [ ] **Step 1: Create Google Cloud OAuth client**

1. Visit `https://console.cloud.google.com/apis/credentials`
2. Select the virgohome.io organization project (or create new).
3. Click **Create Credentials → OAuth client ID**.
4. Application type: **Web application**.
5. Name: `Make Lila — Supabase`.
6. Authorized redirect URIs:
   - `https://txeftbbzeflequvrmjjr.supabase.co/auth/v1/callback` (production)
   - `http://localhost:54321/auth/v1/callback` (local dev)
7. Save. Copy Client ID and Client Secret.

- [ ] **Step 2: Configure Supabase Auth (remote)**

1. Go to `https://app.supabase.com/project/txeftbbzeflequvrmjjr/auth/providers`.
2. Enable **Google** provider.
3. Paste Client ID and Client Secret.
4. Under **Authorized domains** add: `virgohome.io`.
5. Save.

- [ ] **Step 3: Configure Supabase Auth (local)**

Edit `E:\Claude\makelila\supabase\config.toml`:

```toml
[auth]
enabled = true
site_url = "http://localhost:5173"
additional_redirect_urls = ["http://localhost:5173/auth/callback"]

[auth.external.google]
enabled = true
client_id = "env(GOOGLE_CLIENT_ID)"
secret = "env(GOOGLE_CLIENT_SECRET)"
redirect_uri = "http://localhost:54321/auth/v1/callback"
```

Then set the local env vars and restart the stack (bash syntax):
```bash
cd E:\Claude\makelila
export GOOGLE_CLIENT_ID=<your id>
export GOOGLE_CLIENT_SECRET=<your secret>
supabase stop
supabase start
```

- [ ] **Step 4: Write the docs file**

Create `E:\Claude\makelila\docs\supabase-google-oauth-setup.md` with the above steps plus:

```markdown
# Supabase Google OAuth Setup

## Domain restriction

Supabase does not natively restrict OAuth to a single Google Workspace domain.
Enforce the restriction client-side in `app/src/lib/auth.tsx` by rejecting sign-ins
where `user.email` does not end with `@virgohome.io`. See `requireInternalDomain()`.

## Rotation

Client Secret lives in Supabase dashboard. To rotate:
1. Generate new secret in Google Cloud Console.
2. Paste into Supabase dashboard.
3. Delete old secret in Google Cloud Console.
No downtime required; Supabase uses the newest secret.
```

- [ ] **Step 5: Commit**

```bash
cd E:\Claude\makelila
git add docs/supabase-google-oauth-setup.md supabase/config.toml
git commit -m "docs(infra): document Google OAuth setup for Supabase"
```

---

## Task 9: Auth context with domain enforcement and ProtectedRoute

**Files:**
- Create: `E:\Claude\makelila\app\src\lib\auth.tsx`
- Create: `E:\Claude\makelila\app\src\lib\auth.test.ts`

- [ ] **Step 1: Write failing test — domain guard**

```ts
// src/lib/auth.test.ts
import { describe, it, expect } from 'vitest';
import { requireInternalDomain } from './auth';

describe('requireInternalDomain', () => {
  it('accepts @virgohome.io emails', () => {
    expect(requireInternalDomain('pedrum@virgohome.io')).toBe(true);
    expect(requireInternalDomain('HUAYI@virgohome.io')).toBe(true);
  });

  it('rejects other domains', () => {
    expect(requireInternalDomain('attacker@gmail.com')).toBe(false);
    expect(requireInternalDomain('fake@virgohome.com')).toBe(false);
    expect(requireInternalDomain('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd E:\Claude\makelila\app
npm run test:run -- auth
```

Expected: FAIL with "Cannot find module './auth'".

- [ ] **Step 3: Implement `lib/auth.tsx`**

```tsx
// src/lib/auth.tsx
import {
  createContext, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { Navigate, useLocation } from 'react-router-dom';
import { supabase } from './supabase';

export function requireInternalDomain(email: string | undefined | null): boolean {
  if (!email) return false;
  return email.toLowerCase().endsWith('@virgohome.io');
}

type Profile = { id: string; display_name: string; role: string };

type AuthState = {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const user = session?.user;
    if (!user) { setProfile(null); return; }

    if (!requireInternalDomain(user.email)) {
      supabase.auth.signOut();
      alert('Access restricted to @virgohome.io accounts.');
      return;
    }

    supabase
      .from('profiles')
      .select('id, display_name, role')
      .eq('id', user.id)
      .single()
      .then(({ data }) => setProfile(data as Profile | null));
  }, [session]);

  const value: AuthState = useMemo(() => ({
    session,
    user: session?.user ?? null,
    profile,
    loading,
    signInWithGoogle: async () => {
      await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin + import.meta.env.BASE_URL,
          queryParams: { hd: 'virgohome.io' },
        },
      });
    },
    signOut: async () => { await supabase.auth.signOut(); },
  }), [session, profile, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!session) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd E:\Claude\makelila\app
npm run test:run -- auth
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
cd E:\Claude\makelila
git add app/src/lib/auth.tsx app/src/lib/auth.test.ts
git commit -m "feat(app): auth context with @virgohome.io domain enforcement"
```

---

## Task 10: Design tokens + global styles

**Files:**
- Create: `E:\Claude\makelila\app\src\styles\tokens.css`
- Create: `E:\Claude\makelila\app\src\styles\globals.css`

- [ ] **Step 1: Write design tokens**

Values sourced from spec §9.

```css
/* src/styles/tokens.css */
:root {
  /* Brand */
  --color-crimson: #8B1A1A;
  --color-us-navy: #3C3B6E;

  /* Status */
  --color-success: #276749;
  --color-success-bg: #f0fff4;
  --color-success-border: #9ae6b4;
  --color-warning: #744210;
  --color-warning-strong: #d69e2e;
  --color-warning-bg: #fffbeb;
  --color-warning-border: #f6ad55;
  --color-error: #c53030;
  --color-error-strong: #e53e3e;
  --color-error-bg: #fff5f5;
  --color-error-border: #fc8181;
  --color-info: #2b6cb0;
  --color-info-bg: #ebf8ff;
  --color-info-border: #bee3f8;
  --color-purple: #553c9a;
  --color-purple-bg: #faf5ff;

  /* Neutrals */
  --color-ink: #1a202c;
  --color-ink-muted: #4a5568;
  --color-ink-subtle: #718096;
  --color-ink-faint: #a0aec0;
  --color-border: #e2e8f0;
  --color-surface: #f7fafc;
  --color-page: #f0f0f0;

  /* Dark UI */
  --color-dark-0: #111;
  --color-dark-1: #1c1c1c;
  --color-dark-2: #232323;
  --color-dark-3: #2a2a2a;

  /* Typography */
  --font-sans: -apple-system, BlinkMacSystemFont, 'SF Pro Display',
               'SF Pro Text', 'Helvetica Neue', sans-serif;

  /* Sizing */
  --page-max: 1200px;
  --nav-height: 40px;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
}
```

- [ ] **Step 2: Write global CSS**

```css
/* src/styles/globals.css */
@import './tokens.css';

*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  font-family: var(--font-sans);
}

body {
  background: var(--color-page);
  color: var(--color-ink);
  padding: 20px;
}

.page {
  max-width: var(--page-max);
  margin: 0 auto;
  overflow-x: hidden;
}

#app-shell {
  width: 100%;
  overflow: hidden;
  border-radius: var(--radius-lg);
}

/* Grid overflow guard — from mockup */
[style*="display:grid"] > *,
.grid > * {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

a { color: inherit; text-decoration: none; }
button { cursor: pointer; font: inherit; }
```

- [ ] **Step 3: Import globals in `main.tsx`**

Replace `E:\Claude\makelila\app\src\main.tsx`:

```tsx
// src/main.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/globals.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 4: Delete Vite boilerplate styles**

```bash
cd E:\Claude\makelila/app/src
rm -f index.css App.css
rm -f assets/react.svg
```

Ensure `App.tsx` and `main.tsx` no longer import these files (already done in Step 3).

- [ ] **Step 5: Commit**

```bash
cd E:\Claude\makelila
git add app/src/styles app/src/main.tsx
git rm -f app/src/index.css app/src/App.css app/src/assets/react.svg 2>/dev/null || true
git commit -m "feat(app): add design tokens and global styles from spec"
```

---

## Task 11: GlobalNav + UserBadge components

**Files:**
- Create: `E:\Claude\makelila\app\src\components\GlobalNav.tsx`
- Create: `E:\Claude\makelila\app\src\components\GlobalNav.module.css`
- Create: `E:\Claude\makelila\app\src\components\UserBadge.tsx`

- [ ] **Step 1: Write `GlobalNav.module.css`**

```css
/* GlobalNav.module.css */
.nav {
  background: var(--color-dark-0);
  display: flex;
  align-items: center;
  gap: 0;
  padding: 0 16px;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  height: var(--nav-height);
  width: 100%;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-right: 20px;
  border-right: 1px solid var(--color-dark-3);
  margin-right: 8px;
  font-size: 12px;
  font-weight: 800;
  color: #fff;
  letter-spacing: 0.5px;
}

.item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 14px;
  height: var(--nav-height);
  font-size: 11px;
  font-weight: 600;
  color: #888;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.1s;
  white-space: nowrap;
}

.item:hover { color: #ccc; }

.active {
  color: #fff;
  border-bottom: 2px solid var(--color-crimson);
}

.spacer { flex: 1; }
```

- [ ] **Step 2: Implement `GlobalNav.tsx`**

```tsx
// src/components/GlobalNav.tsx
import { NavLink } from 'react-router-dom';
import styles from './GlobalNav.module.css';
import { UserBadge } from './UserBadge';

const MODULES = [
  { path: '/order-review',  label: 'Order Review' },
  { path: '/fulfillment',   label: 'Fulfillment' },
  { path: '/post-shipment', label: 'Post-Shipment' },
  { path: '/stock',         label: 'Stock' },
  { path: '/activity-log',  label: 'Activity Log' },
];

export function GlobalNav() {
  return (
    <nav className={styles.nav}>
      <div className={styles.brand}>MAKE LILA</div>
      {MODULES.map(m => (
        <NavLink
          key={m.path}
          to={m.path}
          className={({ isActive }) =>
            isActive ? `${styles.item} ${styles.active}` : styles.item
          }
        >
          {m.label}
        </NavLink>
      ))}
      <div className={styles.spacer} />
      <UserBadge />
    </nav>
  );
}
```

- [ ] **Step 3: Implement `UserBadge.tsx`**

```tsx
// src/components/UserBadge.tsx
import { useAuth } from '../lib/auth';

export function UserBadge() {
  const { profile, user, signOut } = useAuth();
  if (!user) return null;
  const name = profile?.display_name ?? user.email ?? 'User';
  const initial = name[0]?.toUpperCase() ?? '?';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, color: '#eee',
      fontSize: 11, fontWeight: 600,
    }}>
      <div style={{
        width: 24, height: 24, borderRadius: '50%',
        background: 'var(--color-crimson)', color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 10, fontWeight: 800,
      }}>{initial}</div>
      <span>{name}</span>
      <button
        onClick={() => void signOut()}
        style={{
          background: 'transparent', border: '1px solid #333',
          color: '#888', padding: '4px 10px', borderRadius: 4,
          fontSize: 10, fontWeight: 600,
        }}
      >Sign out</button>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
cd E:\Claude\makelila
git add app/src/components/
git commit -m "feat(app): GlobalNav with NavLink routing and UserBadge"
```

---

## Task 12: App shell + router with 5 empty module placeholders

**Files:**
- Create: `E:\Claude\makelila\app\src\components\AppShell.tsx`
- Create: `E:\Claude\makelila\app\src\modules\OrderReview.tsx`
- Create: `E:\Claude\makelila\app\src\modules\Fulfillment.tsx`
- Create: `E:\Claude\makelila\app\src\modules\PostShipment.tsx`
- Create: `E:\Claude\makelila\app\src\modules\Stock.tsx`
- Create: `E:\Claude\makelila\app\src\modules\ActivityLog.tsx`
- Create: `E:\Claude\makelila\app\src\modules\Login.tsx`
- Modify: `E:\Claude\makelila\app\src\App.tsx`

- [ ] **Step 1: Implement `AppShell.tsx`**

```tsx
// src/components/AppShell.tsx
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
```

- [ ] **Step 2: Create a module placeholder factory**

Write `E:\Claude\makelila\app\src\modules\_Placeholder.tsx`:

```tsx
// src/modules/_Placeholder.tsx
export function Placeholder({ title }: { title: string }) {
  return (
    <div>
      <h1 style={{ fontSize: 18, fontWeight: 800, color: 'var(--color-crimson)' }}>
        {title}
      </h1>
      <p style={{ fontSize: 11, color: 'var(--color-ink-subtle)', marginTop: 6 }}>
        This module is planned but not yet implemented.
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Create the 4 pure-placeholder modules**

```tsx
// src/modules/OrderReview.tsx
import { Placeholder } from './_Placeholder';
export default function OrderReview() { return <Placeholder title="Order Review" />; }
```

```tsx
// src/modules/Fulfillment.tsx
import { Placeholder } from './_Placeholder';
export default function Fulfillment() { return <Placeholder title="Fulfillment" />; }
```

```tsx
// src/modules/PostShipment.tsx
import { Placeholder } from './_Placeholder';
export default function PostShipment() { return <Placeholder title="Post-Shipment" />; }
```

```tsx
// src/modules/Stock.tsx
import { Placeholder } from './_Placeholder';
export default function Stock() { return <Placeholder title="Stock" />; }
```

(`ActivityLog.tsx` comes in Task 13.)

- [ ] **Step 4: Create `Login.tsx`**

```tsx
// src/modules/Login.tsx
import { useAuth } from '../lib/auth';
import { Navigate } from 'react-router-dom';

export default function Login() {
  const { session, signInWithGoogle, loading } = useAuth();
  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (session) return <Navigate to="/order-review" replace />;

  return (
    <div style={{
      minHeight: '70vh', display: 'flex', alignItems: 'center',
      justifyContent: 'center', flexDirection: 'column', gap: 16,
    }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--color-crimson)' }}>
        Make Lila
      </h1>
      <p style={{ fontSize: 12, color: 'var(--color-ink-subtle)' }}>
        Sign in with your @virgohome.io account.
      </p>
      <button
        onClick={() => void signInWithGoogle()}
        style={{
          background: 'var(--color-crimson)', color: '#fff', border: 'none',
          padding: '10px 20px', borderRadius: 6, fontSize: 12, fontWeight: 700,
        }}
      >Sign in with Google</button>
    </div>
  );
}
```

- [ ] **Step 5: Create a placeholder ActivityLog module for now**

```tsx
// src/modules/ActivityLog.tsx
import { Placeholder } from './_Placeholder';
export default function ActivityLog() { return <Placeholder title="Activity Log" />; }
```

(Task 14 replaces this with the live-feed version.)

- [ ] **Step 6: Replace `App.tsx` with router**

```tsx
// src/App.tsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, ProtectedRoute } from './lib/auth';
import { AppShell } from './components/AppShell';
import OrderReview from './modules/OrderReview';
import Fulfillment from './modules/Fulfillment';
import PostShipment from './modules/PostShipment';
import Stock from './modules/Stock';
import ActivityLog from './modules/ActivityLog';
import Login from './modules/Login';

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={
            <ProtectedRoute><AppShell><Outlet /></AppShell></ProtectedRoute>
          }>
            <Route index element={<Navigate to="order-review" replace />} />
            <Route path="order-review"  element={<OrderReview />} />
            <Route path="fulfillment"   element={<Fulfillment />} />
            <Route path="post-shipment" element={<PostShipment />} />
            <Route path="stock"         element={<Stock />} />
            <Route path="activity-log"  element={<ActivityLog />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

import { Outlet } from 'react-router-dom';
```

Note: `Outlet` import is at the bottom only to keep the JSX tree above uncluttered. Engineers may prefer moving it up.

- [ ] **Step 7: Verify dev server works end-to-end**

```bash
cd E:\Claude\makelila\app
npm run dev
```

Expected:
1. `http://localhost:5173/` redirects to `/login` (via ProtectedRoute).
2. Sign-in button visible.
3. After successful sign-in: redirected to `/order-review`, nav shows 5 module links, clicking each swaps the placeholder content.
4. Sign-out button returns to `/login`.

Stop the server before committing.

- [ ] **Step 8: Commit**

```bash
cd E:\Claude\makelila
git add app/src/
git commit -m "feat(app): app shell with router and 5 module placeholders"
```

---

## Task 13: Activity log client library (logAction + useActivityLog)

**Files:**
- Create: `E:\Claude\makelila\app\src\lib\activityLog.ts`
- Create: `E:\Claude\makelila\app\src\lib\activityLog.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/lib/activityLog.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertMock = vi.fn();
const selectMock = vi.fn();
const fromMock = vi.fn(() => ({
  insert: insertMock,
  select: selectMock,
}));

vi.mock('./supabase', () => ({
  supabase: {
    from: fromMock,
    auth: {
      getUser: vi.fn(() => Promise.resolve({
        data: { user: { id: 'user-1' } },
      })),
    },
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
      unsubscribe: vi.fn(),
    })),
  },
}));

import { logAction } from './activityLog';

describe('logAction', () => {
  beforeEach(() => {
    insertMock.mockReset();
    insertMock.mockResolvedValue({ data: null, error: null });
    fromMock.mockClear();
  });

  it('inserts row with current user_id, type, entity, detail', async () => {
    await logAction('order_approve', 'Test Order', '#ORD-0001');
    expect(fromMock).toHaveBeenCalledWith('activity_log');
    expect(insertMock).toHaveBeenCalledWith({
      user_id: 'user-1',
      type: 'order_approve',
      entity: 'Test Order',
      detail: '#ORD-0001',
    });
  });

  it('defaults detail to empty string', async () => {
    await logAction('order_flag', 'Test');
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ detail: '' }));
  });

  it('throws if no authenticated user', async () => {
    const { supabase } = await import('./supabase');
    (supabase.auth.getUser as any).mockResolvedValueOnce({ data: { user: null } });
    await expect(logAction('x', 'y')).rejects.toThrow(/not authenticated/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd E:\Claude\makelila\app
npm run test:run -- activityLog
```

Expected: FAIL — module './activityLog' not found.

- [ ] **Step 3: Implement `activityLog.ts`**

```ts
// src/lib/activityLog.ts
import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

export type ActivityLogEntry = {
  id: number;
  user_id: string;
  ts: string;
  type: string;
  entity: string;
  detail: string;
};

/** Insert an audit entry stamped with the current authenticated user. */
export async function logAction(
  type: string,
  entity: string,
  detail: string = '',
): Promise<void> {
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) throw new Error('logAction: not authenticated');

  const { error } = await supabase.from('activity_log').insert({
    user_id: user.id,
    type,
    entity,
    detail,
  });
  if (error) throw error;
}

/**
 * Subscribe to the most recent `limit` activity_log entries, with realtime updates
 * prepended as new rows arrive.
 */
export function useActivityLog(limit: number = 100) {
  const [entries, setEntries] = useState<ActivityLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('activity_log')
        .select('id, user_id, ts, type, entity, detail')
        .order('ts', { ascending: false })
        .limit(limit);

      if (cancelled) return;
      if (!error && data) setEntries(data as ActivityLogEntry[]);
      setLoading(false);

      channel = supabase
        .channel('activity_log:realtime')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'activity_log' },
          (payload) => {
            setEntries(prev => [payload.new as ActivityLogEntry, ...prev].slice(0, limit));
          },
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (channel) void channel.unsubscribe();
    };
  }, [limit]);

  return { entries, loading };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd E:\Claude\makelila\app
npm run test:run -- activityLog
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
cd E:\Claude\makelila
git add app/src/lib/activityLog.ts app/src/lib/activityLog.test.ts
git commit -m "feat(app): activity log client (logAction + useActivityLog hook)"
```

---

## Task 14: Wire Activity Log module with live feed + test-ping button

**Files:**
- Modify: `E:\Claude\makelila\app\src\modules\ActivityLog.tsx`

- [ ] **Step 1: Replace placeholder with live feed**

```tsx
// src/modules/ActivityLog.tsx
import { logAction, useActivityLog } from '../lib/activityLog';
import { useAuth } from '../lib/auth';

export default function ActivityLog() {
  const { entries, loading } = useActivityLog(50);
  const { profile } = useAuth();

  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 14,
      }}>
        <h1 style={{ fontSize: 18, fontWeight: 800, color: 'var(--color-crimson)' }}>
          Activity Log
        </h1>
        <button
          onClick={() => void logAction(
            'infra_ping',
            'Infra ping',
            `Ping from ${profile?.display_name ?? 'unknown'}`,
          )}
          style={{
            background: 'var(--color-crimson)', color: '#fff', border: 'none',
            padding: '6px 14px', borderRadius: 5, fontSize: 11, fontWeight: 700,
          }}
        >Fire test ping</button>
      </div>

      {loading ? (
        <div style={{ fontSize: 11, color: 'var(--color-ink-subtle)' }}>Loading…</div>
      ) : (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 0,
          border: '1px solid var(--color-border)', borderRadius: 6,
        }}>
          {entries.map(e => (
            <div key={e.id} style={{
              padding: '8px 12px',
              borderBottom: '1px solid var(--color-border)',
              display: 'grid',
              gridTemplateColumns: '140px 120px 1fr 1fr',
              gap: 10, fontSize: 11,
            }}>
              <div style={{ color: 'var(--color-ink-subtle)', fontFamily: 'monospace' }}>
                {new Date(e.ts).toLocaleString()}
              </div>
              <div style={{ fontWeight: 700, color: 'var(--color-ink)' }}>{e.type}</div>
              <div style={{ color: 'var(--color-ink)' }}>{e.entity}</div>
              <div style={{ color: 'var(--color-ink-muted)' }}>{e.detail}</div>
            </div>
          ))}
          {entries.length === 0 && (
            <div style={{ padding: 14, fontSize: 11, color: 'var(--color-ink-subtle)' }}>
              No activity yet. Fire a test ping above.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Manual verification (two-browser realtime)**

```bash
cd E:\Claude\makelila\app
npm run dev
```

1. Open `http://localhost:5173/` in browser A, sign in.
2. Navigate to Activity Log.
3. Open `http://localhost:5173/` in an incognito window as browser B, sign in as a different user (requires 2 accounts in Google; alternatively open in a second browser profile).
4. In browser A, click **Fire test ping**.
5. Expected: entry appears in browser A's feed within ~1s, and **also** appears in browser B's feed without refresh (realtime subscription).

Stop server before committing.

- [ ] **Step 3: Commit**

```bash
cd E:\Claude\makelila
git add app/src/modules/ActivityLog.tsx
git commit -m "feat(app): Activity Log module — live feed with realtime updates"
```

---

## Task 15: GitHub Pages deployment workflow

**Files:**
- Create: `E:\Claude\makelila\.github\workflows\deploy.yml`

- [ ] **Step 1: Write deploy workflow**

```yaml
# .github/workflows/deploy.yml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: app
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: app/package-lock.json
      - run: npm ci
      - run: npm run test:run
      - run: npm run build
        env:
          VITE_SUPABASE_URL: ${{ secrets.VITE_SUPABASE_URL }}
          VITE_SUPABASE_ANON_KEY: ${{ secrets.VITE_SUPABASE_ANON_KEY }}
      - uses: actions/upload-pages-artifact@v3
        with:
          path: app/dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Configure GitHub secrets (document)**

Append to `E:\Claude\makelila\docs\supabase-google-oauth-setup.md`:

```markdown
## GitHub deployment secrets

Add these repository secrets at Settings → Secrets and variables → Actions:
- `VITE_SUPABASE_URL` — production Supabase project URL
- `VITE_SUPABASE_ANON_KEY` — production Supabase anon key

Add the production GitHub Pages URL to Supabase redirect allowlist:
`https://<owner>.github.io/makelila/` → Supabase dashboard → Auth → URL Configuration.
```

- [ ] **Step 3: Verify local production build works**

```bash
cd E:\Claude\makelila\app
npm run build
```

Expected: `dist/` folder created with `index.html` and assets under `/makelila/` base path.

- [ ] **Step 4: Commit**

```bash
cd E:\Claude\makelila
git add .github/workflows/deploy.yml docs/supabase-google-oauth-setup.md
git commit -m "ci(infra): GitHub Pages deploy workflow with Supabase env vars"
```

---

## Task 16: Playwright E2E smoke test

**Files:**
- Create: `E:\Claude\makelila\app\playwright.config.ts`
- Create: `E:\Claude\makelila\app\tests\e2e\smoke.spec.ts`
- Modify: `E:\Claude\makelila\app\package.json`

The shared-infra smoke test intentionally stays at the edges: verify the login page renders and that a signed-in user (injected via Supabase's admin API in a single seeded auth flow) can navigate modules and fire a log action. Full OAuth coverage is deferred to a future auth-focused plan.

- [ ] **Step 1: Install Playwright**

```bash
cd E:\Claude\makelila\app
npm install -D @playwright/test
npx playwright install --with-deps chromium
```

- [ ] **Step 2: Write `playwright.config.ts`**

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
  },
});
```

- [ ] **Step 3: Add e2e script to `package.json`**

Append to `"scripts"` block:
```json
"e2e": "playwright test"
```

- [ ] **Step 4: Write smoke test — login page renders**

Keep this test hermetic: no auth, no network. It verifies the shell boots and unauth routes to login.

```ts
// tests/e2e/smoke.spec.ts
import { test, expect } from '@playwright/test';

test('unauthenticated user is redirected to login', async ({ page }) => {
  await page.goto('/order-review');
  await expect(page).toHaveURL(/\/login/);
  await expect(
    page.getByRole('button', { name: /sign in with google/i }),
  ).toBeVisible();
});

test('login page shows brand heading', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: /make lila/i })).toBeVisible();
});
```

- [ ] **Step 5: Run e2e locally**

```bash
cd E:\Claude\makelila\app
npm run e2e
```

Expected: 2 tests pass.

- [ ] **Step 6: Write `tests/README.md` documenting deeper test plan**

```markdown
# Tests

## Unit (`npm run test:run`)
All logic that doesn't require a browser — auth helpers, activityLog client, etc.

## E2E smoke (`npm run e2e`)
Covers:
- unauthenticated route → redirect to /login
- login page UI renders

## Not yet covered (deferred to later plans)
- Full OAuth flow (requires test-friendly Google OAuth app or session injection helper)
- Realtime subscription across sessions (requires 2 sessions; verify manually for now)
- Each module's full UI (covered by its own plan)
```

- [ ] **Step 7: Commit**

```bash
cd E:\Claude\makelila
git add app/tests app/playwright.config.ts app/package.json app/package-lock.json
git commit -m "test(app): Playwright smoke test for unauth redirect + login render"
```

---

## Task 17: Final integration walkthrough

No new files — this is an end-to-end manual verification.

- [ ] **Step 1: Clean checkout verification**

```bash
cd E:\Claude\makelila
git status
git log --oneline -20
```

Expected: working tree clean; 16+ commits since plan start, each task one commit.

- [ ] **Step 2: Fresh install + full test suite**

```bash
cd E:\Claude\makelila\app
rm -rf node_modules package-lock.json
npm install
npm run test:run
npm run build
```

Expected: all unit tests pass; production build succeeds; `dist/` created.

- [ ] **Step 3: Manual walkthrough against spec**

Against `docs/2026-04-16-make-lila-app-design.md`:

- §2 Global Shell: nav bar renders, 5 module links routable, user badge shows name + sign-out. ✓
- §2 User identity: authenticated user appears in UserBadge; sign-out works. ✓ (note: localStorage user switcher is replaced by real auth per plan architecture — this is intentional.)
- §2 Activity Log plumbing: `logAction` writes to DB; live feed renders; realtime subscription updates another session without refresh. ✓
- §3–§6: empty placeholders render with module titles.
- §7: Activity Log module has a feed + a test-ping trigger.
- §9 Design tokens: crimson, US navy, status colors all loaded from CSS custom properties.

- [ ] **Step 4: Deploy verification**

Push to `main`; watch `Actions` tab for the deploy workflow.

Expected: workflow completes successfully; visit `https://<owner>.github.io/makelila/`; sign in with @virgohome.io account; navigate modules; fire a test ping; observe realtime update.

- [ ] **Step 5: Tag the release**

```bash
cd E:\Claude\makelila
git tag v0.1.0-infra -m "Shared infrastructure foundation"
git push --tags
```

---

## Done criteria

The shared infrastructure is complete when all of the following hold:

1. `npm run test:run` passes in `app/`.
2. `npm run build` produces a working `dist/`.
3. `npm run e2e` passes against a running local Supabase stack.
4. Deployed GitHub Pages URL allows @virgohome.io sign-in; non-@virgohome.io emails are rejected client-side with the domain guard.
5. The live feed in the Activity Log module updates across two browser sessions within ~1 second.
6. Database has `profiles`, `activity_log`, and `team_invite_list` tables with RLS enabled.
7. The 5 module placeholder pages route and render without errors.

## Next plans (not in scope here)

Once this plan merges, the next plans in sequence are:

1. `2026-xx-xx-make-lila-stock-module-plan.md` — build Stock module (largest data model; other modules depend on it).
2. `2026-xx-xx-make-lila-fulfillment-queue-plan.md` — Fulfillment Queue 5-step workflow.
3. `2026-xx-xx-make-lila-fulfillment-shelf-plan.md` — Shelf drag-and-drop + remaining sub-tabs.
4. `2026-xx-xx-make-lila-post-shipment-plan.md` — geo dashboard + shipment tracking.
5. `2026-xx-xx-make-lila-order-review-plan.md` — order triage UI (can be parallel with 2–4).
6. `2026-xx-xx-make-lila-activity-log-dashboard-plan.md` — replace the current simple feed with full KPI dashboard + team contributions.
