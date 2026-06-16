# Huayi — Session Notes for makeLILA Shipping

> Reference for Huayi's Claude Code sessions. Owner: cross-cutting platform (RBAC, activity_log refs, Mobile) + restricted Finance module + 1 Customer Service P3.
> Read this at session start. Each feature below is a complete shipping brief.
> Last updated 2026-06-06 (PRD v1.2 / interactive review v1.4.1).

## Quick links
- PRD: `docs/PRD-2026-06-06.md`
- Competitive proposal: `docs/competitive-landscape-and-proposal-2026-06-06.md`
- Feature backlog: `docs/feature-backlog-alpha-feedback.md`
- System of record: `docs/system-of-record.md`

## Your domain

You are the product owner with full module access across makeLILA, which means your work is structurally different from everyone else's. While Pedrum ships Order Review depth, Junaid ships Stock + Service depth, and Reina ships PostShipment depth, you ship the **substrate they all depend on**: the RBAC primitives that gate the Finance module and feed every future role-based UI decision, the `activity_log` entity-reference schema that turns the existing append-only log into a queryable per-serial / per-order / per-ticket timeline, and the Mobile responsiveness layer that lets every module's UI exist on a phone. None of these features is glamorous in isolation; collectively they unlock about 60% of the next two quarters of feature work.

Your second hat is the **visibility-restricted Finance module** — a new top-level module that, by design, doesn't exist for anyone outside the `finance` role (initially george@virgohome.io and huayi@virgohome.io). You build it co-owned with George Lo, who provides the QBO accounting domain knowledge and the sales/production projection methodology; you provide the implementation. The third hat is one Customer Service P3 (bidirectional Linear/GitHub linking from Service tickets), which sits with you because it touches engineering-tool plumbing that the other operators don't need to reason about. Your daily flow per §3 of the PRD: Dashboard telemetry sweep → ActivityLog OKR review → Finance projection check → cross-module feature audit → strategic review. Your work blocks others, so dependency-order shipping matters more for you than for any other person on the team — RBAC blocks the Finance module visibility, `activity_log` refs blocks Junaid's UnitTimeline + Reina's OKR/KPI tracking, and Mobile V1 blocks Mobile V2.

## How to start a session

1. `cd app && git pull && npm install` (in case anyone added deps since your last session).
2. Open `docs/PRD-2026-06-06.md` and skim the §3 owner table to refresh yourself on what other people are shipping concurrently — your RBAC + activity_log work has shared seams with their work.
3. Check `docs/feature-backlog-alpha-feedback.md` for any updates to numbered backlog items that match the features below.
4. `git log --since="1 week ago" --pretty=format:"%h %s %an"` to scan what landed since you last touched the repo.
5. `npm run dev` and confirm the app boots clean against the operational Supabase project (`txeftbbzeflequvrmjjr`) — the Dashboard module pulls from telemetry (`arfdopgbvlfmhmcfghhl`) through `lib/supabaseTelemetry.ts`, so a clean boot is your sanity check that both clients are wired.
6. Run `npm test` to make sure Vitest is green before you start changing schemas. If anything is red, fix it before adding new tests.
7. Pick one feature from the prioritized list below. Resist the temptation to weave two features in the same PR — your features are dependency-ordered and each PR should be reviewable on its own.

## Conventions to follow

- **CSS Modules everywhere.** No Tailwind, no inline styles (except small per-element overrides like dynamic `transform` or `width: ${pct}%`). Component file `Foo.tsx` co-locates with `Foo.module.css`.
- **All Supabase access through `lib/*.ts`.** Components never import the `supabase` client directly. New tables → new `lib/<name>.ts` exporting typed row interface + `useFoo()` hook + mutation functions.
- **Realtime via Supabase channels.** Subscribe in hooks, unsubscribe in cleanup. Don't add polling.
- **`logAction()` on every mutation.** That's the audit trail. After Feature 2 lands, also pass entity refs (`entity_type`, `entity_id`, `unit_serial` where available).
- **Two-Supabase-project posture.** `lib/supabase.ts` is operational (read/write). `lib/supabaseTelemetry.ts` is telemetry (read-only). **Never** cross-query: don't `SELECT` from telemetry tables in operational queries or vice versa. The Finance module reads operational only.
- **Minimal code per the project CLAUDE.md.** No speculative abstractions, no flexibility for callers that don't exist yet, no "improve adjacent code." Every changed line should trace to a backlog item or feature brief.
- **Migration naming: `YYYYMMDDHHMMSS_description.sql`.** Live under `supabase/migrations/`. Never edit a migration after it's been applied to a shared environment — write a new one.

## Features (8 total, ~120h)

---

### Feature 1: RBAC profiles + canDo + canView helpers — **SHIPPED** (2026-06-07)
**Commits:** `6cf6f1e` (profiles.role enum + is_finance/is_manager RLS) · `7c6cf77` (canDo/canView + useAuth role) · `5d10e5f` (replace MANAGER_EMAILS/FINANCE_EMAILS) · `6ed2660` (close self-privilege-escalation)
**Priority:** P1 · **Effort:** S (~5h) · **Tokens:** ~0.6M
**Files to touch:** `supabase/migrations/<ts>_profiles_role.sql`, `app/src/lib/permissions.ts` (new), `app/src/lib/auth.tsx`, `app/src/lib/postShipment.ts`, plus call-sites where `MANAGER_EMAILS` / `FINANCE_EMAILS` checks currently live.
**Depends on:** nothing.
**Blocks:** Junaid's warranty registration write paths, Reina's Returns disposition write paths, Feature 5 (Finance module visibility), Mobile V1's nav-render logic, all future role-based UI.

#### Goal
Today, write-action gating in makeLILA is implemented via hardcoded email allow-lists (`MANAGER_EMAILS`, `FINANCE_EMAILS` in `lib/postShipment.ts`). That works for 8 people but it doesn't scale, can't express "module-level visibility" cleanly, and forces every new feature to re-implement an email check. Replace it with a `profiles.role` enum, a single `canDo(role, action)` helper, and a single `canView(role, module)` helper. This is the substrate everyone else's role-based work consumes.

#### Work to do
1. **Migration.** Add `role` column to `profiles` table with enum type `user_role` (values: `operator`, `manager`, `finance`, `admin`). Default `operator`. Backfill: every email currently in `MANAGER_EMAILS` → `manager`, every email in `FINANCE_EMAILS` → `finance`, george@ and huayi@ → `finance` (george for domain, you because you own the module), nobody is `admin` yet (admin is reserved for future cross-org install).
2. **`lib/permissions.ts`** (new). Export `type Role = 'operator' | 'manager' | 'finance' | 'admin'`, the action and module enums, `canDo(role: Role, action: Action): boolean`, `canView(role: Role, module: Module): boolean`. Cover at minimum the actions currently behind `MANAGER_EMAILS` (`approve_refund`, `dispose_unit`, `edit_warranty_registration`) and the modules that are role-restricted (`finance`). Keep the helpers pure — no Supabase calls inside, role comes from the `useAuth()` hook.
3. **`lib/auth.tsx`** extend the `AuthContext` to expose `role: Role` alongside the user, fetched from `profiles` on session boot. Cache it in context; refetch on auth state change.
4. **Replace the email-list checks.** Grep for `MANAGER_EMAILS` and `FINANCE_EMAILS`. Each call-site becomes `canDo(role, 'approve_refund')` etc. Remove the constants once the last reference is gone.
5. **RLS tightening.** Update existing RLS policies that hardcode emails (there are a few in the refund/disposition area) to consult `profiles.role` via a `is_finance()` / `is_manager()` SQL helper. RLS now becomes the second of the three enforcement layers you'll lean on for the Finance module.
6. **Tests.** `permissions.test.ts` covers every role × action and role × module pair. Vitest, table-driven.

#### Validation
- Vitest: `permissions.test.ts` green for the full role × action matrix.
- Manual UAT: log in as huayi@ (finance) — every existing write path still works. Log in as a non-manager test account — the gated buttons disable correctly with the existing UI affordance.
- RLS: in the SQL editor, set the JWT claim to a non-manager UUID and verify refund mutations return 0 rows / RLS denial.
- Acceptance: `MANAGER_EMAILS` and `FINANCE_EMAILS` constants are deleted from the codebase, replaced 1:1 by `canDo()`.

#### Watch-outs
- Don't ship a role check that only protects the UI button — RLS has to back it. The point of the three layers (UI gate, route guard, RLS) is defense in depth so a curl request from a logged-in operator can't bypass.
- `profiles` is in operational, not telemetry. Don't accidentally read role through the telemetry client.
- Migration ordering: add the enum and column in one migration, backfill in the same migration, drop the default-NULL stance only after you've verified every existing `profiles` row has a role.
- `admin` is intentionally unused today. Don't add admin-only behavior — it's there so you don't have to do another enum migration when we onboard a second org.

#### Files to load into Claude context at session start
- `app/src/lib/auth.tsx` (existing AuthProvider, source of `role` plumbing)
- `app/src/lib/postShipment.ts` (current `MANAGER_EMAILS` / `FINANCE_EMAILS` site)
- `supabase/migrations/` (browse recent migrations for naming + style)
- Search keywords: `MANAGER_EMAILS`, `FINANCE_EMAILS`, `canDo`, `useAuth`, `profiles`

---

### Feature 2: activity_log entity refs + per-serial timeline (substrate) — **SHIPPED** (2026-06-07)
**Commits:** `8d7f630` (entity_type/entity_id/unit_serial columns + indexes) · `e08fc1e` (logAction opts + useActivityForEntity hook) · `7326f64` (wire entity refs at unit/return/ticket call-sites)
**Priority:** P2 · **Effort:** S (~5h) · **Tokens:** ~0.6M
**Files to touch:** `supabase/migrations/<ts>_activity_log_entity_refs.sql`, `app/src/lib/activityLog.ts`, every call-site of `logAction()` (update gradually — new fields are nullable).
**Depends on:** nothing (Feature 1 is parallel-safe).
**Blocks:** Junaid's `UnitTimeline.tsx` component (P2 S, Stock module), Reina's OKR/KPI tracking (P2 M, ActivityLog module).

#### Goal
`activity_log` today is append-only and great for forensic spelunking but bad for product surface. "Show me every event for serial P150-00427" requires a full-text search across `details`. Add typed entity references so you can index and query the log cheaply, which unblocks two operator-facing surfaces (Junaid's per-unit timeline and Reina's KPI rollups). This is the smallest possible change that delivers the queryability — resist scope creep.

#### Work to do
1. **Migration.** Add three nullable columns to `activity_log`:
   - `entity_type` — enum `entity_type` (`order`, `unit`, `return`, `ticket`, `build_station_pass`, `depot_repair`, `warranty_registration`, `customer`, `parts_kit_shipment`)
   - `entity_id` — `uuid`, FK left soft (no constraint — entities span tables and some are external IDs)
   - `unit_serial` — `text`, denormalized when applicable so per-serial queries are a single-index scan
   Add a composite index `(entity_type, entity_id, created_at DESC)` and a partial index `(unit_serial, created_at DESC) WHERE unit_serial IS NOT NULL`.
2. **`lib/activityLog.ts`** — extend `logAction()`'s signature to accept `entityType?`, `entityId?`, `unitSerial?`. Existing callers stay unchanged because the new params are optional. Add a `useActivityForEntity(entityType, entityId)` hook for the consumers.
3. **Backfill (skip).** Don't backfill historical rows — Junaid's UnitTimeline and Reina's KPI rollups operate forward-looking from when the schema lands. Document this in the migration's comment so nobody is surprised.
4. **Explicitly out of scope:** the risk-first proposal floated wrapping a before/after JSON diff into every `logAction()` call. The interactive review correctly flagged that as materially more invasive than the 5h estimate (every mutation site needs to capture the prior row, marshal the diff, ship it). **Skip it.** If we ever want full row diffs, the right architecture is a Postgres trigger writing to a sibling `audit_log` table — that lives in its own backlog item.

#### Validation
- Vitest: `activityLog.test.ts` — verify (a) old callers (no entity refs) still write rows, (b) new callers with entity refs persist correctly, (c) `useActivityForEntity` returns the right slice.
- Manual: in the SQL editor, run `EXPLAIN ANALYZE SELECT * FROM activity_log WHERE entity_type='unit' AND entity_id='<uuid>' ORDER BY created_at DESC LIMIT 50;` and confirm it uses the new composite index.
- Acceptance: Junaid's UnitTimeline component can be implemented as a single `useActivityForEntity('unit', unitId)` call.

#### Watch-outs
- `unit_serial` denormalization is intentional — it lets Junaid's UnitTimeline filter by serial without joining `units`. Don't try to be clever and derive it from `entity_id` at read time.
- Migration is forward-only — no backfill — so older Activity Log rows render with no entity badges. That's OK; document it.
- Don't add a NOT NULL constraint on the new columns. A `logAction('user logged in')` call should not have to invent a fake entity ref.

#### Files to load into Claude context at session start
- `app/src/lib/activityLog.ts` (existing `logAction` + hooks)
- `app/src/modules/ActivityLog.tsx` (existing reader UI for context)
- Search keywords: `logAction`, `activity_log`, `entity_type`

---

### Feature 3: Bidirectional Linear/GitHub issue linking
**Priority:** P3 · **Effort:** S (~5h) · **Tokens:** ~0.6M
**Files to touch:** `supabase/migrations/<ts>_service_tickets_linear_github.sql`, `app/src/lib/service.ts`, `app/src/lib/githubLinear.ts` (new), `app/src/modules/Service/TicketDetailPanel.tsx`, `supabase/functions/linear-webhook/` (new), `supabase/functions/github-webhook/` (new).
**Depends on:** nothing.
**Blocks:** nothing.

#### Goal
Hardware-plus-software teams chronically have the "we fixed it but never told the customer" gap: a Service ticket reveals a firmware bug, engineering fixes it on the next release, the original ticket sits stale forever. Plain (the YC-backed support tool) and Linear's own integration solve this with bidirectional issue linking. Replicate that pattern: from a Service ticket, an operator can "Link to issue" → creates a Linear or GitHub issue with a backref to the ticket. When the issue closes, a webhook fires and the originating ticket re-surfaces in the operator's queue with a notification badge.

#### Work to do
1. **Migration.** Add `linear_issue_url text` and `github_issue_url text` columns to `service_tickets`. Add `engineering_resolved_at timestamptz` (set by webhook when the linked issue closes — distinct from `closed_at` which is the operator confirming with the customer).
2. **`lib/githubLinear.ts`** (new). Two functions: `createLinearIssue(ticket, { title, description })` and `createGitHubIssue(ticket, { repo, title, body })`. Both hit edge functions (`linear-create-issue`, `github-create-issue`) so the operator's browser never sees API tokens. Both store the resulting URL on the ticket row.
3. **`Service/TicketDetailPanel.tsx`.** Add a "Link to engineering" button that opens a small dialog: choice of Linear team or GitHub repo, prefilled title and body from the ticket. On submit, calls the lib function and refreshes the ticket. Show the linked URL as a chip on the ticket once present, with the issue state (Open / In Progress / Done) pulled from the latest webhook event.
4. **Webhooks.** Two new edge functions:
   - `linear-webhook` — verifies Linear's signature, on issue state change to "Done" or "Canceled", finds the ticket by `linear_issue_url`, sets `engineering_resolved_at`, calls `logAction('engineering_resolved', { entity_type: 'ticket', entity_id: ticket_id })`. The Service queue UI shows a "Follow up with customer" badge on tickets where `engineering_resolved_at IS NOT NULL AND closed_at IS NULL`.
   - `github-webhook` — same logic on GitHub issue `closed` event.
5. **Operator notification.** Existing realtime channel on `service_tickets` already triggers a re-render of the queue; the UI just needs a new chip for the badge state.

#### Validation
- E2E (Playwright): operator opens a ticket, clicks Link to engineering, picks Linear → mocked edge function returns a fake URL → ticket row shows the chip. Then simulate the webhook payload → ticket shows "Engineering fixed this — follow up" badge.
- Manual UAT with one real Linear team and one real GitHub repo: end-to-end issue creation and close-detection works.
- Acceptance: a Service ticket linked to a Linear issue that later closes auto-surfaces in the operator queue within ~30s of the Linear close event.

#### Watch-outs
- Don't store API tokens in client code — edge functions only. Linear API key and GitHub PAT live in Supabase env vars.
- Linear webhook signature verification uses HMAC-SHA256 with the webhook secret. GitHub uses `X-Hub-Signature-256`. Both have to be verified or you'll accept spoofed close events.
- One ticket can have at most one Linear issue and at most one GitHub issue — don't model many-to-many.
- The PRD's competitive landscape doc references Plain explicitly for this pattern; the Linear bidirectional sync model is what we're copying.

#### Files to load into Claude context at session start
- `app/src/lib/service.ts` (existing service tickets data layer)
- `app/src/modules/Service/TicketDetailPanel.tsx` (where the button lives)
- `supabase/functions/` (browse for edge function patterns + auth handling)
- Search keywords: `service_tickets`, `useServiceTickets`, `TicketDetailPanel`

---

### Feature 4: Mobile V1 (viewport + PWA manifest + AppShell narrow-aware) — **SHIPPED** (2026-06-07, ~2h actual)
**Commits:** `2ebe867` (V1 — viewport-fit + PWA manifest + safe-area insets + bottom tab bar) · `fbad3bd` (scroll-blocking CSS fix + CI unblock)
**Priority:** P1 · **Effort:** M (~15h) · **Tokens:** ~1.8M
**Files to touch:** `app/index.html` (viewport meta), `app/public/manifest.json` (new), `app/public/icons/` (new — full-bleed iOS icons), `app/src/components/AppShell.tsx` + `AppShell.module.css`, `app/src/components/GlobalNav.tsx` + `GlobalNav.module.css`, global CSS for `dvh` migration in modals.
**Depends on:** Feature 1 (so the collapsed nav can use `canView()` to decide what to render).
**Blocks:** Feature 8 (Mobile V2).

#### Goal
Backlog #80. Today the app is desktop-only despite being installable to an iPhone home screen — module tab-switching works, but scrolling and the side detail panels do not, and the iPhone's notch + home indicator cover up the UI. P1 V1 lift is to make the chrome work on a phone: the nav collapses cleanly, the safe-area-insets don't cover controls, modals don't get cropped by the iOS URL bar, and the PWA installs with a proper icon + theme. **V1 does not touch table layouts** — that's Mobile V2 (Feature 8). V1 is the shell.

#### Work to do
1. **Viewport.** In `app/index.html`, set `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`. The `viewport-fit=cover` is what enables `env(safe-area-inset-*)` on iOS.
2. **PWA manifest.** `app/public/manifest.json`: `display: standalone`, `start_url: "/"`, `theme_color: "#7f1d1d"` (the crimson brand color in `App.css`), `background_color: "#fff7ed"`, name + short_name. Reference from `index.html` with `<link rel="manifest" href="/manifest.json">`.
3. **Icons.** Generate 192px and 512px PNGs + an Apple-touch-icon set (180px, full-bleed — iOS rounds the corners). Drop in `app/public/icons/`. Reference Apple icons via `<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">`.
4. **Safe-area insets.** In `AppShell.module.css` and `GlobalNav.module.css`, add `padding-top: env(safe-area-inset-top)` to the top chrome, `padding-bottom: env(safe-area-inset-bottom)` to the bottom (or to the bottom-bar variant once you add it), `padding-left/right` on sides where appropriate (landscape iPhone). Use `max()` to combine with existing padding: `padding-bottom: max(12px, env(safe-area-inset-bottom))`.
5. **Narrow-aware AppShell.** Define a single breakpoint constant — `--bp-narrow: 700px` — in `app/src/index.css`. Under the breakpoint, the existing `GlobalNav` horizontal tab row collapses to either (a) a hamburger that opens a sheet with the module list, or (b) a bottom tab bar with icons. Pick the bottom tab bar — iOS users expect it, it's one tap instead of two, and it composes with `env(safe-area-inset-bottom)` cleanly. Use `canView()` from Feature 1 to filter which modules render (Finance hides for non-finance roles).
6. **Dynamic viewport (`dvh`).** Audit modal CSS for `100vh` — replace with `100dvh` so iOS Safari's URL bar shrink doesn't crop the bottom of dialogs. The CSS Modules in `OrderReview/`, `PostShipment/`, `Service/` modal components are the main offenders.
7. **Touch targets.** Audit interactive controls — minimum 44×44px hit area per Apple HIG. The dense table row controls (status pill, action menu) are likely under this on phone. For V1 just bump the small icon buttons in the chrome; table-row controls are Feature 8's problem.
8. **Hover-less devices.** `@media (hover: none) { ... }` — make tooltip + on-hover controls always-visible. Anything that reveals on hover today gets a small persistent affordance.

#### Validation
- E2E Playwright with mobile viewport profile (iPhone 14 Pro): app boots, tab bar renders at the bottom, every module reachable, no UI clipped by safe-area.
- Manual on a real iPhone (huayi's): install to home screen, open, every tab reachable, scrolling works, modal dialogs don't get cropped by URL bar.
- Lighthouse PWA audit: installability score green.
- Acceptance: huayi can open the app on iPhone, navigate to every module the role can see, scroll the queue lists, and the chrome respects the notch + home indicator.

#### Watch-outs
- `100dvh` is broadly supported now but verify on the iOS Safari version huayi is on. If it falls back to `100vh`, the bug is cosmetic, not fatal.
- Bottom tab bar interacts with `env(safe-area-inset-bottom)` — the bar's height needs to be `56px + env(safe-area-inset-bottom)` and the bar's padding-bottom needs to absorb the inset, otherwise content is double-padded.
- Don't ship a third nav variant for tablet — let the desktop nav handle anything above 700px. We can add a tablet variant later if anyone uses it.
- Use `canView()` from Feature 1 in the mobile nav. Don't reimplement the role check.

#### Files to load into Claude context at session start
- `app/src/components/AppShell.tsx` + `AppShell.module.css`
- `app/src/components/GlobalNav.tsx` + `GlobalNav.module.css`
- `app/index.html`
- `app/src/App.css` (for the crimson brand color reference)
- Search keywords: `100vh`, `safe-area`, `viewport`, `AppShell`

---

### Feature 5: Finance module skeleton + JournalPanel (QBO) — **SHIPPED** (2026-06-11)
**Commits:** `055723a` (qbo_daily_journals + qbo_oauth + cron) · `4812e1f` (lib/finance.ts) · `f9eab96` (Finance module + JournalPanel + route guard) · `5a8fcb6` (qbo-daily-summary edge fn) · `7a024fb` (PostShipment FinanceTab) · `c48103d` (EntityType extension) · `ef3cd00` (finance.test.ts) · `c60b65d` / `f0638fc` (fixes)
**Priority:** P1 · **Effort:** M (~15h) · **Tokens:** ~1.8M
**Files to touch:** `app/src/modules/Finance/` (new directory — `index.tsx`, `JournalPanel.tsx`, module CSS), `app/src/App.tsx` (add route + guard), `app/src/components/GlobalNav.tsx` (conditional render), `supabase/migrations/<ts>_qbo_daily_journals.sql`, `supabase/functions/qbo-daily-summary/` (new edge function), `app/src/lib/finance.ts` (new), `app/src/modules/PostShipment/FinanceTab.tsx` (the embedded view of the last 30 days of journals).
**Depends on:** Feature 1 (RBAC), Reina's Returns disposition work (clean refund data flowing in before QBO sees it).
**Blocks:** Feature 6 and Feature 7 (other Finance panels live in the same module shell).

#### Goal
Finance work today is a manual QBO journal entry per day per currency per payment channel — about 6-12 journals/day depending on Sezzle settlement timing. Replace that with a nightly edge function that aggregates orders + refunds + Sezzle payouts and posts one journal per (currency, payment_channel) via the QBO Accounting API. The Finance module is the operator surface: review yesterday's journals, see what posted, repost a failed one, jump to the QBO journal. This is the **first restricted-visibility module** in makeLILA, so it also exists as the proving ground for the three-layer enforcement pattern.

#### Work to do
1. **Three-layer enforcement pattern.** This is the canonical version other future restricted modules will copy.
   - **Layer 1 — Nav.** In `GlobalNav.tsx`, the Finance link renders only when `canView(role, 'finance')`. Other roles literally don't see it.
   - **Layer 2 — Route guard.** In `App.tsx`, the `/finance` route wraps a `<RequireRole role="finance">` guard that redirects unauthorized roles to `/`. This catches URL-hopping or shared-link attempts.
   - **Layer 3 — RLS.** The underlying `qbo_daily_journals` table has RLS policies that `SELECT`-deny non-finance roles via `is_finance(auth.uid())`. This catches anyone who tries to hit the Supabase REST API directly with their token.
2. **Migration.** New table `qbo_daily_journals`:
   ```
   id uuid pk
   date date not null
   currency text not null check (currency in ('CAD','USD'))
   payment_channel text not null  -- 'shopify_card', 'sezzle', 'shopify_paypal', 'manual_etransfer', ...
   gross_sales numeric(12,2) not null
   discounts numeric(12,2) not null default 0
   refunds numeric(12,2) not null default 0
   tax_collected numeric(12,2) not null default 0
   shipping numeric(12,2) not null default 0
   fees numeric(12,2) not null default 0
   net_deposit numeric(12,2) not null
   qbo_journal_id text   -- null until posted
   posted_at timestamptz
   error text            -- last post error if any
   created_at timestamptz default now()
   unique (date, currency, payment_channel)
   ```
   RLS: `is_finance(auth.uid())` for both SELECT and UPDATE. INSERT only via the service-role edge function.
3. **Edge function `qbo-daily-summary`.** Scheduled via `pg_cron` at 02:00 America/Toronto. For yesterday's date:
   - Aggregate orders by `(currency, payment_channel)` from `orders` (joining `order_line_items` for gross), refunds from `returns` (joining for refund amounts and channels), Sezzle payouts from a separate Sezzle settlement feed once it's wired (placeholder for now — Reina's work).
   - **Exclude replacement orders** — `WHERE NOT (orders.kind = 'replacement' AND orders.total = 0)`. Replacement journal entries route to a `warranty_reserve` GL account through a separate flow.
   - Upsert into `qbo_daily_journals` keyed on `(date, currency, payment_channel)`.
   - For each unposted row, build the QBO Journal Entry payload (debit cash/AR for net_deposit, credit revenue for gross_sales, credit/debit each side), POST to QBO via OAuth2, save the returned `Id` as `qbo_journal_id`, set `posted_at`.
4. **QBO OAuth2 flow.** Authorization Code grant initially. Store `qbo_access_token`, `qbo_refresh_token`, `qbo_realm_id` in a `qbo_oauth` table (single row, finance-RLS-locked, service-role-only writes). Refresh tokens last 100 days, access tokens 60 minutes — the edge function refreshes opportunistically before each batch. QBO rate limits: 500 req/min and 10 concurrent per realm — serialize the edge function's POSTs (it's at most ~12 a night, irrelevant).
5. **`lib/finance.ts`.** Typed row interface, `useQboJournals(dateRange)` hook (realtime via channel), `repostJournal(id)` mutation that calls a `qbo-post-journal` edge function for a single row.
6. **`Finance/JournalPanel.tsx`.** Table view: date, currency, channel, net_deposit, posted state, QBO link (open in new tab), Repost button (manager+ only). Default range: last 30 days. Filter chips for currency and channel.
7. **`PostShipment/FinanceTab.tsx`.** Same data, embedded in PostShipment for the operators who already work there. Read-only — no Repost button.

#### Validation
- Vitest: `finance.test.ts` — `useQboJournals` returns the right slice, `repostJournal` calls the right edge function.
- E2E Playwright: log in as huayi (finance) → Finance tab visible → JournalPanel shows seed data. Log in as a manager test account → Finance tab does not render in nav, URL-hopping to `/finance` redirects to `/`. SQL direct hit: a non-finance JWT returns 0 rows on the journals table.
- QBO sandbox: run the edge function against the QBO sandbox realm — one journal per group, posted_at populated, qbo_journal_id matches what's in QBO sandbox UI.
- Acceptance: George opens the Finance module, sees yesterday's auto-posted journals, can repost one, clicking the QBO link opens the actual entry in QBO.

#### Watch-outs
- **Multi-currency discipline.** A CAD order with a CAD card payment and a USD refund must not bleed into a single journal. The `(date, currency, payment_channel)` unique key is what protects you — every aggregation must respect it.
- **Replacement orders ($0 with `kind='replacement'`) — explicitly excluded.** A future feature will route them to a warranty_reserve GL through a separate journal flow.
- **OAuth token refresh.** The 100-day refresh token expiry is a quiet failure mode — once a year, someone has to re-auth Finance manager (huayi or George). Build a clear failure surface in `JournalPanel.tsx` when `qbo_oauth.refresh_token_expires_at` is within 14 days.
- **RLS on `qbo_oauth`.** It has the access token in it. Service-role-only writes; finance-only reads if you read at all from the client (better: don't — only the edge function reads it).
- **Don't post twice.** The `unique (date, currency, payment_channel)` constraint + the `qbo_journal_id IS NULL` check in the post step is what prevents double-posting if the edge function retries.
- **QBO API version.** Pin to a specific Accounting API minor version in the headers — otherwise a QBO API rev can silently break the journal payload schema.

#### Files to load into Claude context at session start
- `app/src/App.tsx` (route config, where you add the guard)
- `app/src/components/GlobalNav.tsx` (where Finance link is conditionally rendered)
- `app/src/lib/auth.tsx` (after Feature 1 — `role` lives here)
- `app/src/lib/permissions.ts` (after Feature 1 — `canView` lives here)
- `supabase/functions/` (existing edge function patterns)
- Search keywords: `qbo`, `QuickBooks`, `journal`, `Finance`, `RequireRole`

---

### Feature 6: ProductionProjectionPanel (Finance) — **SHIPPED** (2026-06-11)
**Commits:** `f16f284` (ProductionProjectionPanel + production-projection-snapshot edge fn) · `4851fbf` (migration fix: batch_id text + is_finance() signature)
**Priority:** P2 · **Effort:** M (~15h) · **Tokens:** ~1.8M
**Files to touch:** `app/src/modules/Finance/ProductionProjectionPanel.tsx` (new), `app/src/lib/finance.ts` (extend), `supabase/migrations/<ts>_production_projection_snapshots.sql`, `supabase/functions/production-projection-snapshot/` (new — scheduled).
**Depends on:** Feature 5 (Finance module shell + RBAC enforcement pattern).
**Blocks:** nothing.

#### Goal
George and Huayi need a forward-looking view of unit availability per batch (P150, P50N, P100, P100X). Today this is a spreadsheet maintained by hand. Replace with a per-batch burn-down: start from `units.status = 'ready'` count, subtract weekly reservation velocity (orders pulling from the batch), add batch arrivals as step-functions. Output: stock-out forecast table flagging when projected demand crosses projected supply before the next batch lands. The Kristen + Cheryl P100X replacement scenario from backlog #71 is the canonical use case — known replacement queue + thin ready inventory + a long-lead next batch.

#### Work to do
1. **`ProductionProjectionPanel.tsx`.** Reads three live sources via `lib/finance.ts`: `units` (count by `batch_id` and `status='ready'`), `orders` (open ones with `status IN ('pending','confirmed')` to size near-term demand), `orders` with `kind='replacement' AND awaiting_batch_id IS NOT NULL` (replacement queue per batch). Computes weekly velocity from last 12 weeks of order-to-unit reservations. UI: per-batch row with `current_ready`, `weekly_velocity`, `projected_stockout_date`, `replacement_queue_size`, `inbound_units + arrival_date` (from a `batches` table assumed shipped or stubbed if not), `risk_level` chip (green > 90d, amber 30-90d, red < 30d). A chart per batch is nice-to-have but not required for ship — the table is the core surface.
2. **Snapshot persistence.** New table `production_projection_snapshots` (id uuid pk, `as_of` timestamptz, `batch_id` FK, `ready_count` int, `reserved_count` int, `weekly_velocity` numeric, `projected_stockout_date` date, `inbound_units` int, `inbound_arrival_date` date, `replacement_queue_size` int, `risk_level` text). Stored so we can trend "how has the projection moved" over time. RLS: finance-only SELECT.
3. **Scheduled snapshot.** Edge function `production-projection-snapshot` runs daily at 02:30 America/Toronto (after `qbo-daily-summary`), computes the projection, writes one row per batch. The panel reads live numbers from the operational tables for "now" and the snapshots table for the trend.
4. **Flag logic.** Highlight scenarios where `replacement_queue_size + open_orders_for_batch > current_ready` AND `inbound_arrival_date > today + 30d`. That's the Kristen+Cheryl pattern — known demand, thin supply, long wait.

#### Validation
- Vitest: pure-function tests for the projection math (`projectStockout({ ready, velocity, replacementQueue, inbounds })` returns expected date).
- Manual: seed a fake batch with `ready=5`, `weekly_velocity=2`, `replacement_queue=10`, no inbound → projected_stockout_date is ~today, risk red, the panel shows it correctly.
- Acceptance: George opens Finance → Production Projection, sees P100X flagged red (matches the real Kristen+Cheryl scenario when it exists), can see the snapshot history trend.

#### Watch-outs
- **Don't double-count reservations.** An order's reservation against a batch and a replacement queue entry might be the same unit. Be explicit about the join.
- **Weekly velocity is noisy.** Use a 12-week trailing average, not last week's single number. Surface the standard deviation in the UI if there's appetite for it — but keep the table clean.
- **Batches table dependency.** If a proper `batches` table doesn't exist yet, stub it minimally (id, name, arrival_date, expected_units) and document the dependency. Don't carry batch info as denormalized strings on `units`.
- This is finance-restricted via the same RLS + nav-hide + route-guard pattern as Feature 5. Don't reinvent.

#### Files to load into Claude context at session start
- `app/src/lib/stock.ts` (where `units` and batch logic lives)
- `app/src/lib/finance.ts` (extend, from Feature 5)
- `app/src/modules/Finance/JournalPanel.tsx` (model for panel structure)
- Search keywords: `units`, `batches`, `awaiting_batch_id`, `replacement`

---

### Feature 7: SalesProjectionPanel rolling-average (Finance) — **SHIPPED** (2026-06-11)
**Commits:** `c5fc9a5` (SalesProjectionPanel + sales-projection-snapshot edge fn)
**Priority:** P2 · **Effort:** M (~15h) · **Tokens:** ~1.8M
**Files to touch:** `app/src/modules/Finance/SalesProjectionPanel.tsx` (new), `app/src/lib/finance.ts` (extend), `supabase/migrations/<ts>_sales_projection_snapshots.sql`, `supabase/functions/sales-projection-snapshot/` (new — scheduled).
**Depends on:** Feature 5 (Finance module shell), Feature 6 (proves the snapshot pattern).
**Blocks:** nothing.

#### Goal
Forward-looking revenue projection for the next 30/60/90 days vs the company revenue OKR. **V1 is rolling-average** — last-90d order velocity × AOV by SKU × manual seasonality curve. **V2 is pipeline-driven** (Facebook leads × conversion + HubSpot pipeline × conversion) and is **P3, not in this scope** — the Facebook Marketing API is unstable and we need ~30d of clean attribution data before that variant has signal.

#### Work to do
1. **`SalesProjectionPanel.tsx`.** Reads `orders` for last 90d (excluding `kind='replacement'`), computes velocity by SKU (P150 / P50N / P100 / P100X), multiplies by AOV per SKU, applies the seasonality curve. UI: a chart with solid historical revenue + shaded projected revenue with 80% confidence band, KPI tiles for projected MRR-equivalent / QTD / quarter-end estimate vs company revenue OKR (read OKR target from a config table or constant — TBD with George). Breakdown table per SKU.
2. **Seasonality curve.** Manual JSON owned by huayi, stored in a `finance_config` table keyed by `config_key`. Shape: `{ month: 1..12 → multiplier }`. Start with all 1.0; adjust as we see real seasonality.
3. **Snapshot persistence.** New table `sales_projection_snapshots` (id, `as_of` timestamptz, `horizon_days` int, `model` text — values `'rolling_average'` now, `'pipeline_driven'` future, `projected_revenue_cad` numeric, `projected_revenue_usd` numeric, `lower_bound` numeric, `upper_bound` numeric, `breakdown` jsonb — per-SKU detail, `inputs` jsonb — captured velocity + AOV + seasonality at compute time for auditability). RLS: finance-only.
4. **Scheduled snapshot.** Edge function `sales-projection-snapshot` runs daily at 02:45 America/Toronto, writes one row per (horizon_days × currency) for 30 / 60 / 90.
5. **OKR-pace flag.** Compute the implied daily rate needed to hit the quarterly OKR target; flag when current projection falls below it. Single banner at the top of the panel, red.

#### Validation
- Vitest: `projectRevenue({ velocity, aov, seasonality, horizon })` returns expected number with expected confidence band.
- Manual: seed orders, run the snapshot edge function manually, see the projection appear in the panel.
- Acceptance: George opens Finance → Sales Projection, sees the next 30/60/90 day projection, the OKR-pace banner reads correctly against the current quarter.

#### Watch-outs
- **Confidence band is illustrative, not statistical.** Document this in a panel tooltip. We're not running ARIMA; we're showing ±15% of the rolling average as a band. If George wants real prediction intervals, that's a follow-up.
- **AOV is per-SKU per-currency.** Don't average across CAD and USD orders — the FX swing alone would distort it. Keep CAD and USD separated through the entire pipeline.
- **Exclude replacement orders.** Same as Feature 5 — they're zero-dollar and would skew velocity.
- **Pipeline-driven variant is explicitly out of scope for V1.** When someone asks for "Facebook leads × conversion," point at the model column and explain V2 lands when the data is reliable.

#### Files to load into Claude context at session start
- `app/src/lib/orders.ts` (where `orders` data flows)
- `app/src/lib/finance.ts` (extend)
- `app/src/modules/Finance/ProductionProjectionPanel.tsx` (panel + snapshot pattern)
- Search keywords: `AOV`, `velocity`, `seasonality`, `OKR`

---

### Feature 8: Mobile V2 (per-module card-row tables) — **SHIPPED** (2026-06-07)
**Commits:** `24d968d` (MobileHome + NavCard + Brolink UI + makelila wordmark) · `4ab795d` (Service/PostShipment/Fulfillment tab-cards) · `3db2b3b` (Customers/Stock/Build/OrderReview card views) · `acb3181` (Dashboard/ActivityLog/Templates card views) · `910c529` (row→detail drill + Inbox tap-to-read)
**Priority:** P2 · **Effort:** L (~45h) · **Tokens:** ~5.4M
**Files to touch:** `app/src/modules/OrderReview/` (list view), `app/src/modules/Fulfillment/QueuePanel.tsx`, `app/src/modules/Service/TicketsTable.tsx`, `app/src/modules/PostShipment/` (Returns/Refunds/Replacements/Cancellations tables), `app/src/modules/Stock/UnitTable.tsx`, and the CSS Modules for each. Plus a shared `components/CardRowTable/` if a reusable component pattern emerges (it likely will).
**Depends on:** Feature 4 (Mobile V1 — the breakpoint constant + safe-area-insets + AppShell already exist).
**Blocks:** nothing.

#### Goal
Mobile V1 makes the chrome work on phone. Mobile V2 makes the **content** work on phone. Every high-traffic module today renders a dense table with 6-12 columns; that table is unusable on a 390px-wide screen. Convert the high-traffic tables to a card-row layout under the V1 breakpoint: stacked cards with the key fields (customer / status / priority) prominent and secondary fields collapsed behind a tap. Some tables (Build pipeline board) work better with sticky-first-column horizontal scroll than card conversion — pick per table.

#### Work to do
1. **Decide the pattern per module.**
   - **OrderReview list:** card per order. Top line customer name + total. Second line status + city + days-in-queue. Tap → existing detail panel.
   - **Fulfillment Queue:** card per unit. Top line serial + assignee. Second line current step + days-in-step. Tap → existing detail panel.
   - **Service Tickets:** card per ticket. Top line customer + urgency chip. Second line ticket type + days-open. Tap → existing detail panel.
   - **PostShipment (Returns, Refunds, Replacements, Cancellations):** card per row, slightly different fields per tab.
   - **Stock Units:** card per serial, with batch chip.
   - **Build pipeline:** keep the board layout, horizontal-scroll the columns with sticky station headers. Card conversion would lose the pipeline metaphor.
2. **Shared `CardRowTable` component.** If three or more of the above end up with the same shape (top-line + second-line + collapsed detail + tap-target), lift to `components/CardRowTable/`. Otherwise keep per-module — don't force an abstraction that doesn't yet exist.
3. **Breakpoint switch.** Use the V1 breakpoint constant (`--bp-narrow: 700px`). Under it, render `<CardRowTable>` or the per-module mobile variant; over it, the existing dense table.
4. **Touch targets.** Every card is ≥ 56px tall, the whole card is the tap target, action menus expand to a sheet on tap (not a popover — sheets work better with thumb reach).
5. **Parallel ownership note.** Junaid could own the Service tables variant, Reina the PostShipment tables variant, Pedrum the OrderReview variant — they each know their own module best. You own the breakpoint logic + shared component + AppShell coordination. If you want, scope this as: you ship the shared `CardRowTable` first, then assign per-module wiring as paired follow-ups.
6. **Testing strategy.** Playwright with mobile viewport for each module's main list view. Snapshot DOM, snapshot the actual visual once (per-module screenshot baseline) to catch regressions.

#### Validation
- E2E Playwright mobile-viewport: each migrated module's list view renders, tap → detail panel opens correctly.
- Manual on huayi's iPhone: navigate to every migrated module, scroll the list, tap a card, the detail panel works.
- Acceptance: each high-traffic module is usable on a 390px-wide screen without horizontal scroll (except Build's intentional pipeline scroll).

#### Watch-outs
- **45h is a real estimate.** Don't try to ship all six tables in one PR. Sequence by user pain — OrderReview and Fulfillment first (operators look at these on phones during fulfillment), then Service, then PostShipment, then Stock. One PR per module.
- **The reusable component is a trap if you build it first.** Build the OrderReview variant inline, then the Fulfillment variant inline, then extract the shared piece. Otherwise you'll build for use cases that don't exist.
- **Don't change the detail panel layout in this feature.** The detail panel is its own work — V2 is the list / table conversion only.
- **Coordinate with Junaid + Reina + Pedrum.** If they're touching their module's table at the same time you are, the merge conflict is painful. Ship one module's V2 at a time, behind a quick stand-up.

#### Files to load into Claude context at session start
- `app/src/components/AppShell.tsx` (V1 breakpoint lives here)
- `app/src/modules/OrderReview/index.tsx` (first conversion target)
- `app/src/modules/Fulfillment/QueuePanel.tsx`
- `app/src/modules/Service/TicketsTable.tsx`
- `app/src/modules/PostShipment/` (all four tabs)
- `app/src/modules/Stock/UnitTable.tsx`
- Search keywords: `module.css`, `@media`, `--bp-narrow`, `<table>`

---

## Quick session start cheat sheet

When you sit down for a session, in order:

1. `cd app && git pull && npm install && npm run dev` — sanity boot, both Supabase clients wire.
2. `git log --since="1 week ago" --pretty=format:"%h %s %an"` — what's landed.
3. Pick a feature **in this order** if multiple are unstarted:
   - **Feature 1 (RBAC)** — blocks everything else
   - **Feature 2 (activity_log refs)** — blocks Junaid + Reina
   - **Feature 4 (Mobile V1)** — blocks Feature 8
   - **Feature 5 (Finance + JournalPanel)** — first restricted module, proves the 3-layer pattern
   - **Feature 6 (Production Projection)** — depends on Feature 5
   - **Feature 7 (Sales Projection)** — depends on Feature 5
   - **Feature 3 (Linear/GitHub linking)** — P3, slot when bandwidth opens
   - **Feature 8 (Mobile V2)** — largest item, sequence by user pain, one module per PR
4. Load the files listed in that feature's "Files to load into Claude context" — explicitly, not "the whole repo."
5. Write the migration first (if any), then the `lib/*.ts` types and functions, then the UI, then `logAction()` everywhere, then tests, then RLS verification.
6. Before merging: `npm test` green, Playwright green for any touched path, manual UAT on a real account that matches the target role (not your own finance role — switch to an operator account to verify gates work).
7. Commit message: backlog item number + short description. E.g. `feat(rbac): profiles.role + canDo/canView helpers (#82)`.
8. PR description: link the feature brief in this doc + the backlog item + the migration filename. Reviewer wants to see the three-layer enforcement explicitly called out for any restricted-module work.

Remember the project CLAUDE.md: minimum code that solves the problem, no speculative abstractions, surgical changes only, goal-driven execution. Your features are substrate — every line should trace to a backlog item or a downstream feature that depends on it.
