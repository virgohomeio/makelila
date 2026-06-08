# Integration proposal — lilalovely ↔ makelila customer-journey tracking

**Date:** 2026-06-07
**Authors:** Huayi + Claude
**Status:** draft for review

## TL;DR

**lilalovely** (Ryan's customer-facing PWA at `virgohomeio/beta-lovely`) and **makelila** (this app, internal ops) already share the **`lila` device telemetry tables** at the infra layer but have **no customer-record link** between them today. The natural join key is the **serial number** that beta-lovely's user pairs to during onboarding and that makelila's `units` table FKs to `customers.id`.

Three small pieces unlock customer-journey tracking:
1. **Identity resolution edge function** — beta-lovely emits a webhook to makelila on user signup + serial pairing; makelila joins `users.serial_number` → `units.serial` → `customers.id` and writes a `customer_app_link` row.
2. **Event bus** — beta-lovely posts lifecycle events to a makelila `customer_events` table (signup, onboarding step, dashboard open, OTA accept, damage report, push opt-in, dormancy).
3. **JourneyTab consumes events** — the existing 10-stage CJM in makelila's Customers/JourneyTab.tsx scores stage transitions automatically from the event stream instead of operator-curated only.

Ship cost: ~15h (one M-sized feature). Operator-visible payoff is large.

---

## What lilalovely is today

### Stack
- **Next.js 16** (App Router) + React 19 + TypeScript
- Tailwind v4 + shadcn/ui (Radix primitives)
- **Supabase** — separate project from makelila. Uses `@supabase/ssr` for cookie-based server auth + `@supabase/supabase-js` for client. Has its own `users` table extending `auth.users`.
- **Sentry** for error monitoring (only "analytics" today)
- **Web Push** + a `push-cron` edge function for "your batch is done" notifications
- nginx + custom shell scripts for deployment (`setup_nginx.sh`, `restart_nextjs.sh`)

### Routes / customer surfaces
| Route | What it does |
|---|---|
| `/` | Login (Supabase email/password) |
| `/onboarding` | 7-step flow: Welcome → PreferenceQuiz → CustomizingScreen → UnboxingChecklist → HardwareWalkthrough → PairingWizard → PendingApproval. State persists in `users.onboarding_step`. |
| `/verification-pending` | Gate while admin manually verifies (`users.is_verified`) |
| `/dashboard` | Live LILA status: system status, last event, WiFi strength. Reads the shared `lila` telemetry tables. |
| `/chambers` | Per-chamber view: temp, humidity, batch progress, days remaining. Uses `getOrDetectActiveBatch` + `compost_batches`. |
| `/settings` | Account + device settings |
| `/api/dashboard`, `/api/chambers`, `/api/compost-batches`, `/api/onboarding/damage-report`, `/api/ota/check`, `/api/ota/accept`, `/api/push/subscribe` | REST endpoints backing the above |

### Schema (own project; key tables)
- **`users`** — extends `auth.users`. Columns: `email`, `first_name`, `last_name`, `is_verified`, `verified_at`, `mailing_list`, `serial_number`, `auto_update_permission`, `last_login_at`, `login_count`, `onboarding_step`, `quiz_responses` (JSONB), `tour_seen`. **`serial_number` is the join key** to makelila.
- **`compost_batches`** — `serial_number`, `chamber_side` (L/R), `started_at`, `completed_at`, `notified_at`. Per-batch lifecycle on the physical machine.
- **`damage_reports`** — submitted during onboarding (`serial_number`, `notes`, FK to user). Photos in `damage-photos` storage bucket via `images` table.
- **`ota_updates`** + **`ota_acceptances`** — firmware version + per-user accept records.
- **`push_subscriptions`** — web push endpoints per user.

### Customer features (today)
1. Account signup + Supabase auth
2. Pair their LILA via serial number (during onboarding)
3. Take a preference quiz (JSONB responses)
4. Submit unboxing-damage report with photos
5. View live dashboard status (Active / Offline + WiFi strength)
6. View chamber-level batch progress
7. Accept OTA firmware updates
8. Opt into push notifications (compost-complete alerts)

### Telemetry surface (today)
**No dedicated analytics SDK** — no Mixpanel, PostHog, Segment, Amplitude, GA4. Only Sentry (errors, not behavior).
Implicit signals already captured:
- `users.last_login_at` + `login_count` (trigger on `auth.users` updates)
- `users.onboarding_step` transitions (mutated route-by-route in `/api/onboarding/*`)
- `ota_acceptances` (per-version accept timestamps)
- `damage_reports` rows
- `push_subscriptions` rows
- `compost_batches.completed_at` (when the machine finishes a batch)

These are great signal raw materials but they're trapped in beta-lovely's Supabase project — makelila operators don't see them.

---

## What makelila has today (for reference)

- **`public.customers`** — keyed by `id` (UUID), columns include `email`, `customer_name`, `shopify_customer_id`, `onboard_date`, `country`, `fu1_sent_at` / `fu2_sent_at` (follow-up state).
- **`public.units`** — keyed by `serial` (e.g. `LL01-…`). FK `customer_id → customers.id` (populated by fulfillment-sheet sync). Same `serial` lives in the telemetry `lila` table.
- **`public.activity_log`** — recently extended with `entity_type` + `entity_id` + `unit_serial` typed refs (Phase B substrate shipped 2026-06-07).
- **`Customers/JourneyTab.tsx`** — 10-stage CJM visualisation (pre-sale → routine → at-risk → churned). Stage assignment is operator-curated today; bar scores 0–5 are manual.
- **`OverdueFollowupPanel`** — surfaces customers overdue for follow-up calls based on `onboard_date` + 30/60-day windows.

So makelila already has the *operator UI* for customer journey. What it's missing is the *event stream* that would make that journey self-updating.

---

## The integration

### Join key

```
beta-lovely.users.serial_number
   ↔ makelila.public.units.serial
      ↔ makelila.public.units.customer_id
         ↔ makelila.public.customers.id
```

Once a beta-lovely user pairs their device in onboarding, we have a deterministic chain from their Supabase auth UUID to their makelila customer record. Before pairing, we can fall back to `users.email` ↔ `customers.email`.

### Architecture

```
┌─────────────────────┐         webhook         ┌──────────────────────┐
│ lilalovely (Next)   │ ────────────────────────►│ makelila edge fn     │
│ Supabase project A  │  POST /customer-event    │ ingest-lovely-event  │
│                     │  { user_id, event_type,  │ (Supabase Edge)      │
│                     │    serial, payload }     │                      │
└─────────────────────┘                          └─────────┬────────────┘
                                                            │
                                  resolves user_id+serial ►│
                                                            ▼
                                  ┌─────────────────────────────────────┐
                                  │ makelila DB (project txeftb…)       │
                                  │                                     │
                                  │  customer_app_links (new table)     │
                                  │   - customer_id FK                  │
                                  │   - lovely_user_id (UUID)           │
                                  │   - first_seen_at, last_seen_at     │
                                  │                                     │
                                  │  customer_events (new table)        │
                                  │   - customer_id FK                  │
                                  │   - event_type                      │
                                  │   - event_payload JSONB             │
                                  │   - source (lovely / makelila /...) │
                                  │   - occurred_at                     │
                                  │                                     │
                                  │  customer_journey_state (new mat-   │
                                  │  view or trigger-maintained table)  │
                                  │   - customer_id                     │
                                  │   - cjm_stage                       │
                                  │   - health_score                    │
                                  │   - last_engagement_at              │
                                  │   - dormancy_days                   │
                                  └─────────────────────────────────────┘
```

### Events to emit (V1)

| Event | When | Payload | CJM stage impact |
|---|---|---|---|
| `lovely.signup` | First `users` row created | `{ email, first_name }` | → `account_created` |
| `lovely.serial_paired` | `users.serial_number` first set | `{ serial }` | → `onboarding` |
| `lovely.onboarding_step` | `users.onboarding_step` changes | `{ from, to }` | progress within `onboarding` |
| `lovely.onboarding_done` | `onboarding_step = 'tour_done'` | `{ first_use_ms_after_signup }` | → `routine_use` (or `first_use`) |
| `lovely.damage_report` | New `damage_reports` row | `{ notes_present, photo_count }` | flag for ops follow-up |
| `lovely.dashboard_open` | `/dashboard` page view | `{}` (debounce ≥10min) | engagement signal |
| `lovely.batch_complete_seen` | User views chamber after `compost_batches.completed_at` | `{ batch_id }` | engagement signal |
| `lovely.ota_accepted` | New `ota_acceptances` row | `{ ota_version }` | engagement signal |
| `lovely.push_opt_in` / `lovely.push_opt_out` | `push_subscriptions` row added / deleted | `{}` | retention indicator |
| `lovely.dormancy_30d` | No login for 30d (computed via cron) | `{ days_since_last_login }` | → `at_risk` |
| `lovely.dormancy_60d` | No login for 60d | `{}` | → `at_risk` (higher tier) |
| `lovely.churn_signal` | Damage report + no resolution + dormant | `{ reason }` | → `churned` candidate |

### Wire mechanism

**Option A — Postgres `pg_notify` + webhook receiver (preferred).**
Beta-lovely's Supabase project gets a `pg_notify`-style trigger on the relevant tables (`users`, `compost_batches`, `damage_reports`, `ota_acceptances`, `push_subscriptions`). A small Supabase edge function in lilalovely listens and posts each event to a makelila edge function `ingest-lovely-event`. **Pros:** zero changes to beta-lovely's Next.js code, captures DB-level truth, hard to miss events.

**Option B — Beta-lovely Next.js code emits directly.**
Each API route that mutates state (`/api/onboarding/*`, `/api/ota/accept`, `/api/push/subscribe`) makes an outbound POST to makelila's ingest edge function. **Pros:** simpler, no triggers; **cons:** ad-hoc; easy to miss if a future route forgets to call.

Recommend **Option A** for canonical mutations + **Option B** for opt-in client-side signals like `dashboard_open` (which has no DB trigger to hook into).

### makelila side — minimum new code

1. **DB migration** — `customer_app_links` + `customer_events` + indexes. Reuses the existing `activity_log` substrate if we want (extend `activity_log.source` enum to include `lovely`), but a separate `customer_events` table keeps customer-facing signals isolated from internal-operator activity.
2. **Edge function `ingest-lovely-event`** — validates payload, resolves customer via the join chain, inserts into `customer_events`, updates `customer_journey_state` materialized view.
3. **`useCustomerEvents(customer_id)` hook** in `lib/customers.ts` — pulls event stream for a single customer.
4. **`CustomerActivityTab.tsx`** — new tab in the Customers module showing the event timeline per customer (timestamps + event type pills).
5. **JourneyTab automation** — current bars are operator-edited; layer in a "computed from events" badge that surfaces dormancy_days + last_engagement_at next to each customer in the grid.
6. **OverdueFollowupPanel enhancement** — split overdue customers by lovely engagement: "no login in 30d" floats to the top; "active but no human follow-up" goes lower priority.

### What it unblocks (operator wins)

- **Reina/Junaid see app engagement on every Service ticket.** "Customer hasn't opened the app in 14 days" is the single most useful pre-call context — beats the current cold "Cheryl Lemieux · onboard date · units list".
- **Pedrum's at-risk dashboard becomes self-updating.** Today the "8 at-risk" count on the home screen is manual. With this, at-risk = dormancy_60d OR onboarding_stalled OR damage_unresolved.
- **Onboarding funnel becomes measurable.** "78% complete Pairing, 51% finish the Tour" — a real conversion metric to optimise.
- **George's KPI dashboard can show app-side metrics** (DAU/MAU per cohort, % onboarding-complete, % opted into push) alongside the existing build/fulfillment metrics.

### What it doesn't do (yet)

- No bidirectional sync makelila → lovely (could push CJM stage back as a "your subscription tier" hint, but that's V2).
- No personalisation API (recipe library, batch tips). Could be built on top of `quiz_responses` later.
- No third-party analytics tool (PostHog etc.). The `customer_events` table is the source of truth; export to PostHog/Mixpanel later if needed.

### Ship plan

| Step | Owner | Hours | Verify |
|---|---|---|---|
| 1. Migration — `customer_app_links` + `customer_events` + indexes | Huayi | 1h | Apply via Supabase MCP; `select count(*) from customer_events` returns 0 |
| 2. Edge function `ingest-lovely-event` with email-fallback resolver | Huayi | 3h | Curl with a known serial; row appears in `customer_events`; unknown-serial returns 422 with reason |
| 3. Beta-lovely: `pg_notify` triggers on `users`, `damage_reports`, `ota_acceptances`, `push_subscriptions`, `compost_batches.completed_at` | Ryan | 2h | Trigger fires in beta-lovely test env; webhook receiver gets the payload |
| 4. Beta-lovely: client-side `dashboard_open` POST (debounced) | Ryan | 1h | Open dashboard; event appears in makelila within 10s |
| 5. `useCustomerEvents` hook + `CustomerActivityTab.tsx` | Huayi | 3h | Open a customer → see their event timeline |
| 6. JourneyTab badge — dormancy days + last engagement next to existing stage bars | Huayi | 2h | Customer with no logins for 31d gets a yellow "dormant" badge |
| 7. OverdueFollowupPanel re-sort by lovely engagement | Reina | 2h | Overdue list reordered correctly per the new precedence |
| 8. Docs + handoff notes | Huayi | 1h | Add brief to docs/session-notes/ for Junaid/Reina |

**Total: ~15h Huayi + ~3h Ryan.** One M-sized makelila feature with a small Ryan dependency.

### Resolved questions (2026-06-07 from Huayi)

1. **Beta-lovely Supabase project:** `arfdopgbvlfmhmcfghhl` (the "Lovely" project, us-east-1, created 2025-10-28).
2. **Email reliability:** confirmed — beta-lovely user emails are always Shopify-customer emails, so the email fallback resolver works deterministically for pre-pairing users.
3. **Privacy posture:** standard B2C SaaS internal-ops usage. Aggregating in-app engagement events into a same-company internal operator tool is covered by typical "we use your data to provide and improve the service" privacy-policy language. Not a blocker. George should give the existing VCycene privacy policy a 5-min read to confirm it has that language; if not, a one-line addition is enough. No customer consent UI change needed.
4. **V2 operator-fires-push:** confirmed — wanted. Adds a small admin endpoint in beta-lovely (`POST /api/admin/push`, service-role-auth gated) that accepts `{ serial_number, title, body, url? }` and uses the existing `web-push` infra. makelila side: a "Send push" button in the Service ticket detail panel + a generic one on the Customer detail panel.

---

*This doc lives at [`docs/integration-lilalovely-2026-06-07.md`](docs/integration-lilalovely-2026-06-07.md). Update when Ryan + George respond to the open questions.*
