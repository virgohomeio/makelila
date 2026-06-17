# Design — "Lovely" tab: Lovely app user monitoring

**Date:** 2026-06-16
**Author:** Huayi + Claude
**Status:** approved (build)

## Goal

Add a new top-level nav tab **"Lovely"** to makelila for monitoring the LILA Lovely
customer app. V1 ships exactly one feature: **list the users currently on the app** —
i.e. surface the Lovely project's `public.users` table inside makelila.

This is intentionally a thin MVP ("just create it for now"). It establishes the tab,
route, nav entry, and a secure read path. Richer monitoring (engagement, onboarding
funnel, per-user detail) is explicitly out of scope for V1.

## Context / where the data lives

There are two Supabase projects in play:

| Project | Ref | Role |
|---|---|---|
| **LILA-Pro-Inventory** | `txeftbbzeflequvrmjjr` | makelila's own operations DB (`VITE_SUPABASE_URL`). |
| **Lovely** | `arfdopgbvlfmhmcfghhl` | The Lovely app's DB **and** device telemetry. makelila already reads its telemetry tables via the `supabaseTelemetry` client (`VITE_TELEMETRY_SUPABASE_URL` / `VITE_TELEMETRY_SUPABASE_ANON_KEY`). |

The target table is `Lovely.public.users` (~11 rows today). Columns:
`id, email, first_name, last_name, verified_at, mailing_list, serial_number,
auto_update_permission, last_login_at, login_count, created_at, updated_at,
is_verified, onboarding_step, quiz_answers, quiz_responses, tour_seen,
first_data_notify_requested_at`.

### The access problem

Unlike the telemetry tables (`events`, `lila`, etc.), which expose public `anon read`
SELECT policies, `users` has RLS that only allows **a logged-in Lovely user to read
their own row** (`auth.uid() = id`). makelila operators are **not** authenticated
against the Lovely project, so the existing anon `supabaseTelemetry` client cannot read
the full users list. The table also holds PII (emails, names, login history, quiz
answers), so making it publicly anon-readable is undesirable.

Privacy posture for internal-ops use is already settled in
[`docs/integration-lilalovely-2026-06-07.md`](../../integration-lilalovely-2026-06-07.md)
(resolved question #3): aggregating Lovely user data into makelila (an internal,
auth-gated operator tool) is acceptable. The remaining question was purely the *read
mechanism* — resolved below.

## Approaches considered

1. **Public `anon read` policy on `Lovely.public.users`** — simplest; the existing
   telemetry client reads it directly. **Rejected:** the Lovely anon key ships publicly
   in two frontend bundles, so this would make every Lovely user's email/name readable
   by anyone on the internet. A PII exposure that's hard to fully reverse once live.

2. **Secured edge function (chosen).** A `lovely-users` edge function that returns the
   users list only to authenticated makelila operators. PII never becomes public.

   - **2a — hosted on makelila project**, reading Lovely with a `LOVELY_SERVICE_ROLE_KEY`
     secret. Reuses the existing `_shared/auth.ts` helper, but requires the operator to
     manually set a service-role secret (MCP can't read/set service-role secrets).
   - **2b — hosted on the Lovely project (chosen).** The function reads `users` with the
     Lovely project's own auto-provided `SUPABASE_SERVICE_ROLE_KEY` (no secret handoff),
     and validates the incoming **makelila** operator JWT manually. Needs `verify_jwt=false`
     (the makelila JWT isn't a Lovely JWT, so the gateway must not pre-verify it), which
     the deploy tool supports.

**Decision: 2b.** Secure (PII stays server-side), and needs zero new secrets or
credential handoff.

## Architecture

```
makelila frontend (operator already logged in via Google OAuth @virgohome.io)
  │  supabaseTelemetry.functions.invoke('lovely-users',
  │     { headers: { Authorization: 'Bearer <makelila access_token>' } })
  │  (apikey header = Lovely anon, set automatically by the telemetry client)
  ▼
Lovely project edge function `lovely-users`  (verify_jwt = false)
  │  1. CORS preflight (OPTIONS)
  │  2. Read Authorization Bearer = makelila operator token
  │  3. Validate it against makelila auth:
  │        createClient(MAKELILA_URL, MAKELILA_ANON).auth.getUser(token)
  │     → require user.email endsWith '@virgohome.io'  (else 401)
  │  4. Read public.users via the Lovely SERVICE_ROLE client
  ▼
  { users: LovelyUser[] }
```

`MAKELILA_URL` (`https://txeftbbzeflequvrmjjr.supabase.co`) and `MAKELILA_ANON` are
**public** values (they ship in the makelila bundle), so they are embedded as constants
in the function source — no secret required.

## Components

### Backend — `app/supabase/functions/lovely-users/index.ts`

- **Deploys to the Lovely project (`arfdopgbvlfmhmcfghhl`), NOT makelila.** A header
  comment states this loudly so a future reader doesn't deploy it to the wrong project.
- Self-contained (inline CORS using `Access-Control-Allow-Origin: *`, matching the
  repo's `_shared/cors.ts` convention). No credentials mode is used, so `*` is safe.
- Handles `OPTIONS`.
- Validates the makelila operator JWT (step 3 above). On failure → `401`.
- Reads `public.users` via `createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)`
  (both auto-provided in the Lovely function env), selecting:
  `id, email, first_name, last_name, serial_number, onboarding_step, is_verified,
  verified_at, mailing_list, last_login_at, login_count, created_at, updated_at`
  ordered by `last_login_at desc nulls last`.
  (Sensitive/bulky `quiz_answers` / `quiz_responses` are intentionally **not** returned
  in V1 — not needed for a user list.)
- Returns `{ users }` JSON. On DB error → `500`.
- Deployed with `verify_jwt: false`.

### Frontend data layer — `app/src/lib/lovely.ts`

- `export type LovelyUser` mirroring the returned columns.
- `export function useLovelyUsers()` → `{ users, loading, error, configured, refetch }`.
  - If `!isTelemetryConfigured` (from `supabaseTelemetry.ts`): returns
    `configured: false`, empty users, not loading. (Same degradation as the Fleet tab.)
  - Else: `await supabase.auth.getSession()` (main client) to get the operator
    `access_token`; then
    `supabaseTelemetry.functions.invoke('lovely-users', { headers: { Authorization: \`Bearer \${token}\` } })`.
  - Stores `users` / `loading` / `error`; exposes `refetch()`.
  - One-shot fetch (no realtime — the data path is an edge function, and 11 rows don't
    warrant a subscription).

### UI — `app/src/modules/Lovely/index.tsx` + `Lovely.module.css`

- Route-level component following the module conventions (imports from `lib/` only).
- States: **not-configured** (mirror the Fleet "Telemetry not configured" panel),
  **loading**, **error** (with a Retry button), **empty**, and the populated table.
- Header: title "Lovely", subtitle "Lovely app users", a result count, a **Refresh**
  button, and a **search** input (filters by name / email / serial, client-side).
- Optional light KPI row: total users, verified count. (Keep minimal.)
- Table columns: **Name** (first + last), **Email**, **Paired serial**,
  **Onboarding step**, **Verified** (badge), **Last login**, **Logins**, **Joined**.
  Empty cells render an em-dash, matching the Customers directory.

### Routing / nav / permissions

- `App.tsx` — `const Lovely = lazy(() => import('./modules/Lovely'));` + a
  `<Route path="lovely" element={<LazyRoute><Lovely /></LazyRoute>} />`.
- `components/GlobalNav.tsx` — add `{ path: '/lovely', label: 'Lovely' }` to `MODULES`
  (after Customers). Visible to all authenticated operators (no extra gating).
- `lib/permissions.ts` — add `'lovely'` to the `Module` union for completeness
  (non-restricted → `canView` returns `true`).
- `components/MobileHome.tsx` — add a Lovely card to the `WORKSPACE` group (icon 🌱).

### Env

- Add `VITE_TELEMETRY_SUPABASE_URL` and `VITE_TELEMETRY_SUPABASE_ANON_KEY` to
  `app/.env.example` (currently undocumented). Without them set locally, the tab — like
  Fleet — renders the "not configured" panel rather than crashing.

## Out of scope (V1 / YAGNI)

- No realtime subscription, no editing of users, no pagination (11 rows).
- No per-user detail panel, no `quiz_*` rendering, no engagement/onboarding-funnel charts.
- No write-back to the Lovely project.
- No bespoke CORS origin allowlist (auth is enforced server-side via JWT validation).

## Verification

- `cd app && npm run build` — typecheck + build pass.
- Function deployed to `arfdopgbvlfmhmcfghhl`; invoking it **with** a valid makelila
  operator token returns the users array; **without** a token (or non-`@virgohome.io`)
  → `401`.
- With `VITE_TELEMETRY_*` set, the `/lovely` tab lists the ~11 users; search + refresh
  work; nav entry appears on desktop and mobile.

## Watch-outs

- The function source lives in the makelila repo but deploys to the **Lovely** project —
  the header comment must make this unambiguous.
- `verify_jwt=false` is correct here (custom auth in the body) — do not "fix" it to
  `true`, which would reject the cross-project makelila token at the gateway.
- The Lovely anon key (sent as the `apikey` header by the telemetry client) is required
  by the gateway for routing even with `verify_jwt=false`; it does not grant table access
  (RLS still blocks anon on `users`).
