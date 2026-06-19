# Design — Lovely admin tools: Verification queue + Onboarding funnel

**Date:** 2026-06-17
**Author:** Huayi + Claude
**Status:** approved (build)

## Goal

Add two **admin-only** capabilities to the existing Lovely tab in makelila:

1. **Verification queue** — approve pending Lovely-app signups (the app gates users at
   `/verification-pending` but has no admin UI to approve them; today it's manual DB edits).
2. **Onboarding funnel** — read-only view of how far users get through onboarding
   (counts per `onboarding_step`, drop-off, pending-approval callout).

Both build on the [Lovely tab shipped 2026-06-16](2026-06-16-lovely-tab-design.md) and its
secured edge-function + `supabaseTelemetry` plumbing.

## Decisions (locked)

- **Verification = approve-only.** Sets `is_verified=true, verified_at=now()` on the Lovely
  `users` row. No "reject" (the Lovely schema has no rejected state, and the app simply keeps
  unapproved users pending). No Lovely schema change.
- **Admin = the `finance`/leadership tier.** Nobody holds the literal `admin` role today; the
  leadership tier is `finance` (George, Huayi, Yueli). Gate via a new
  `isLeadership(role)` helper (`role === 'finance' || role === 'admin'`).
- **Scope:** the existing **Users** list stays visible to all operators. The **Verification**
  and **Onboarding** sub-tabs are visible/usable to leadership only.
- **No notification on approve in V1.** The Lovely app auto-unblocks an approved user (its
  `/onboarding` page reads `is_verified` from the same DB). Push/email is a future add.

## Context / data

- Lovely project `arfdopgbvlfmhmcfghhl`, table `public.users`. The existing `lovely-users`
  edge function already returns `is_verified`, `verified_at`, `onboarding_step`, `created_at`,
  `last_login_at`, etc. — so **both admin tabs derive from the existing `useLovelyUsers()`
  list; no new read endpoint is needed.**
- Canonical onboarding order (from the Lovely app's `app/onboarding/page.tsx` +
  `app/api/onboarding/route.ts`):
  `pairing` (initial) → `welcome_done` → `quiz_done` → `customizing_done` → `checklist_done`
  → `hardware_done` → `pairing_done` → `tour_done` (complete).
  "Pending approval" is not a step — it is `pairing_done && !is_verified`.
- makelila `profiles` has `profiles_select_all_authenticated` (any authenticated user can read
  roles) → the write function can verify the caller's role **server-side** with the caller's
  own token.

## Architecture

### Structure — sub-tabs in the Lovely module

Refactor `modules/Lovely/index.tsx` to host sub-tabs (mirroring the Customers module's tab
pattern): **Users** (existing table, all operators), **Verification** (leadership), **Onboarding**
(leadership). The not-configured / loading / error states wrap the whole module as today.
Tab strip renders only the tabs the role may see.

### Verification queue (read derives from existing list; one new write)

- **List:** `users.filter(u => u.is_verified !== true)`, newest first (by `created_at`).
  Columns: name, email, paired serial, onboarding step, signed-up date, + **Approve** button.
- **Approve action → new edge function `lovely-verify-user`** on the Lovely project
  (`verify_jwt=false`):
  1. Validate the caller's makelila JWT via `getUser` against makelila auth (same as
     `lovely-users`); require `@virgohome.io` → else 401.
  2. **Enforce leadership server-side:** with the caller's token, read their role from
     makelila `profiles` (`select role where id = uid`); require `finance`/`admin` → else 403.
  3. Read `{ user_id }` from the body; set `is_verified=true, verified_at=now(),
     updated_at=now()` on the Lovely `users` row via the Lovely **service role**; return the
     updated row.
- After a successful approve, the frontend **refetches** the user list (the approved user
  drops out of the queue) and calls `logAction('lovely_user_verified', <email>, ...)` so
  makelila's audit trail records who approved whom.

### Onboarding funnel (pure read, client-side derive)

- `onboardingFunnel(users)` helper in `lib/lovely.ts`: counts users per `onboarding_step` and
  returns them in canonical order with `{ step, label, count, pct }`; unknown step values are
  appended under "other".
- UI: an ordered list / horizontal bars — each step with count + % of total and a drop-off
  cue. A **"N pending approval"** callout (= `pairing_done && !is_verified`, or simply
  `!is_verified`) links to the Verification tab.

## Components / files

| File | Action | Responsibility |
|---|---|---|
| `app/supabase/functions/lovely-verify-user/index.ts` | Create | Auth + leadership-gated approve write (deploys to Lovely project). |
| `app/src/lib/lovely.ts` | Modify | Add `approveLovelyUser(userId)`, `ONBOARDING_STEPS` (ordered) + `onboardingFunnel(users)` helper. |
| `app/src/lib/lovely.test.ts` | Modify | Tests for `onboardingFunnel` + `approveLovelyUser` (mock fetch). |
| `app/src/lib/permissions.ts` | Modify | Add `isLeadership(role)` helper. |
| `app/src/modules/Lovely/index.tsx` | Modify | Sub-tab host (Users / Verification / Onboarding) with role gating. |
| `app/src/modules/Lovely/UsersTab.tsx` | Create | Existing users table extracted from index.tsx. |
| `app/src/modules/Lovely/VerificationTab.tsx` | Create | Pending queue + Approve. |
| `app/src/modules/Lovely/OnboardingTab.tsx` | Create | Funnel view. |
| `app/src/modules/Lovely/Lovely.module.css` | Modify | Sub-tab strip + funnel bar styles. |

## Out of scope (V1)

Reject flow, push/email on approve, cohort/date funnel filters, per-user drill-in, realtime.

## Verification

- `onboardingFunnel` unit test (ordering, counts, %, unknown-step handling).
- `approveLovelyUser` unit test (mock fetch: posts `{ user_id }` with the operator Bearer
  token to the function; surfaces error body on non-2xx).
- `lovely-verify-user` live: **401** (no token), **403** (operator-role token), **200**
  (finance-role token → row flips `is_verified=true`).
- `npm run lint`, `npm run test:run`, `npm run build` all green.
- Manual: as a finance user, Verification tab lists the pending user; Approve flips it and it
  drops out; non-finance operators don't see the Verification/Onboarding tabs.

## Watch-outs

- `lovely-verify-user` deploys to the **Lovely** project (`arfdopgbvlfmhmcfghhl`), not makelila,
  with `verify_jwt=false` (custom in-body auth) — same as `lovely-users`.
- Server-side leadership check relies on makelila `profiles` being readable by the
  authenticated caller (confirmed: `profiles_select_all_authenticated`).
- UI gating (`isLeadership`) is convenience; the function's 403 is the real enforcement.
