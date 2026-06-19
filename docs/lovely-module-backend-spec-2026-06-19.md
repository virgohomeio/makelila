# Lovely Module — Backend Spec for the Customer App

**Date:** 2026-06-19
**Owner:** Ryan Yuan (ryanyuan32@gmail.com)
**Status:** Draft — for George + Huayi review
**Related:** [integration-lilalovely-2026-06-07.md](integration-lilalovely-2026-06-07.md) (event bus architecture, join-key chain, ship plan for customer_events)

---

## Purpose

The MakeLila **Lovely module** (`/lovely`) is the internal operational control plane for the customer-facing Lovely PWA (`E:\Claude\Lovely_Beta`, repo `virgohomeio/beta-lovely`). Every significant thing a customer does in the Lovely app — signing up, pairing their device, accepting a firmware update, composting a batch — must be visible to VCycene operators in MakeLila so they can act on it without switching tools.

Ryan is the primary engineer for both sides of this integration. His role: build the data pipelines that make the Lovely module the single source of truth for customer app health, and add the missing operational surfaces (fleet health, OTA acceptance rates, event timeline).

---

## Architecture — Three Supabase Projects

```
Customer phone
    │  reads / writes
    ▼
Lovely PWA (Next.js 16, E:\Claude\Lovely_Beta)
    │
    ├── Lovely Supabase (arfdopgbvlfmhmcfghhl, us-east-1)
    │     users, devices, ota_updates, ota_acceptances,
    │     compost_batches, damage_reports, push_subscriptions
    │
    └── VCyceneOS Supabase (felozafjjzmglbvjlqdo, us-west-1) ← NOT YET CONNECTED
          telemetry, sensor_status_events, actuator_log,
          machine_state, devices (IoT registry)
          [currently mocked from /public/mock/*.json in the PWA]

MakeLila (txeftbbzeflequvrmjjr, us-east-2)
    │  reads Lovely Supabase via edge functions
    ├── lovely-users       → UsersTab
    ├── lovely-verify-user → VerificationTab
    └── lovely-ota         → FirmwareTab
    │
    │  [NOT YET] reads VCyceneOS for per-customer device health → FleetTab (proposed)
    │  [NOT YET] receives event webhooks from Lovely via ingest-lovely-event
```

**Join key throughout the entire stack:**
```
Lovely.users.serial_number (= devices.device_identifier after pairing)
  ↔  MakeLila.units.serial
  ↔  MakeLila.customers.id
  ↔  VCyceneOS device IDs (LL01-XXXXXXXXX format)
```

---

## Lovely App — Current Schema (Lovely Supabase)

### `users` (extended from `auth.users`)
| Column | Type | Notes |
|---|---|---|
| id | uuid | auth.users FK |
| email | text | Always = Shopify customer email |
| first_name, last_name, display_name | text | |
| avatar_url | text | |
| mailing_list | bool | Email consent |
| is_active, is_verified | bool | `is_verified` = MakeLila operator approved |
| email_verified_at | timestamp | |
| last_login_at | timestamp | |
| login_count | int | Incremented by auth trigger |
| onboarding_step | text | Canonical step code (see below) |
| quiz_responses | jsonb | Preference quiz answers |
| auto_update_permission | bool | OTA auto-accept consent |
| tour_seen | bool | |
| metadata | jsonb | Extensible |

### `devices` (serial-number pairing)
| Column | Type | Notes |
|---|---|---|
| id | uuid | |
| user_id | uuid → users | |
| device_identifier | text | = MakeLila `units.serial` |
| device_name | text | Customer's custom name |

### `ota_updates`
| Column | Type | Notes |
|---|---|---|
| id | uuid | |
| version | text | Semantic version string |
| description | text | Short changelog |
| release_notes | text | Full notes shown to customer |
| is_active | bool | Only the newest active is served to customers |

### `ota_acceptances`
| Column | Type | Notes |
|---|---|---|
| id | uuid | |
| user_id, device_id, ota_update_id | uuid FKs | |
| user_email | text | Denormalized for audit |
| accepted_at | timestamp | |

### `compost_batches`
| Column | Type | Notes |
|---|---|---|
| serial_number | text | Device join key |
| chamber_side | text | 'L' or 'R' |
| started_at, completed_at | timestamp | |
| notified_at | timestamp | Push sent when batch done |

### `damage_reports`
| Column | Type | Notes |
|---|---|---|
| serial_number, user_id | | |
| notes | text | Customer-entered damage description |
| images | FK | Photos in `damage-photos` storage bucket |

---

## Onboarding Step Sequence

The canonical progression MakeLila already tracks (from `lib/lovely.ts`):

```
pairing → welcome_done → quiz_done → customizing_done →
checklist_done → hardware_done → pairing_done → tour_done
```

`pairing_done` is the step where `devices.device_identifier` is first set — this is the earliest point where MakeLila can do a deterministic serial → customer lookup. Before `pairing_done`, the join key is email.

---

## Customer Journey Map (CJM)

Each stage maps what the customer sees to what MakeLila surfaces and what a VCycene operator should do.

| # | Stage | Customer touchpoint | MakeLila signal | Responsible operator | Action |
|---|---|---|---|---|---|
| **1** | **Order placed** | Shopify checkout confirmation | Order in OrderReview, status `pending` | Pedrum | Review + confirm order; verify address |
| **2** | **Unit shipped** | Freightcom tracking email | `orders.status = fulfilled`; shipment row | Raymond | Fulfill queue → generate label → mark done |
| **3** | **Unit delivered** | Package arrives at door | Tracking: delivered | Reina | 48h contact via Quo; book onboarding call |
| **4** | **App signup** | Downloads Lovely, creates account | `users` row in Lovely Supabase; `onboarding_step = 'pairing'` | Ryan | Visible in Lovely → Users tab within minutes |
| **5** | **Verification pending** | App shows "pending approval" gate | User appears in Lovely → Verification tab | Ryan / Huayi / George | Cross-check email against MakeLila order; click Approve |
| **6a** | **Welcome + quiz** | Welcome screen → preference quiz | `onboarding_step` → `quiz_done` | Reina | No action; funnel view shows progress |
| **6b** | **Unboxing + hardware** | Checklist + hardware walkthrough | `onboarding_step` → `hardware_done` | Reina | If stuck >48h: proactive call |
| **6c** | **Device paired** | Scans or types serial number | `devices` row created; `onboarding_step = 'pairing_done'` | Ryan | MakeLila can now cross-ref unit QC data; verify no failed QC |
| **6d** | **Tour complete** | In-app product tour done | `onboarding_step = 'tour_done'` | Reina | Trigger 7-day follow-up call |
| **7** | **Active daily use** | Dashboard: chamber status, temp, humidity, cycle progress | *(proposed)* Fleet tab: per-customer unit health pulled from VCyceneOS | Ryan / Reina | Monitor for error states proactively |
| **8** | **Batch complete** | Push: "Your compost is ready!" | `compost_batches.completed_at` + `notified_at` | Reina | Optional: celebratory follow-up for first batch |
| **9** | **Error state** | Chamber shows red / offline | *(proposed)* Fleet tab: unit `status = error` | Reina / Junaid | Proactive CS outreach; open Service ticket |
| **10** | **OTA update available** | Update banner appears in app | Lovely → Firmware tab shows new version; acceptance count rises | Ryan | Publish update; monitor acceptance rate; follow up on non-acceptors |
| **11** | **Service request** | Submits `/service-request` form or contacts Quo | MakeLila Service ticket created | Reina | Pick up ticket; check Lovely tab for unit health context |
| **12** | **30-day follow-up** | Reina calls or messages | `customers.fu1_sent_at` set | Reina | Log call outcome; update lifecycle stage |
| **13** | **Dormancy** | No app login for 30+ days | *(proposed, via event bus)* Customer flagged in Customers → JourneyTab as `at_risk` | Pedrum / Reina | Retention flow via Klaviyo or manual Quo outreach |
| **14** | **Churn signal** | Unresolved damage report + dormancy | *(proposed)* `churned` candidate flag in JourneyTab | George / Pedrum | Refund or replacement decision |

---

## Current Lovely Module — Tab Status

| Tab | What it does today | Gap |
|---|---|---|
| **Users** | Table: all Lovely users, email, serial, onboarding step, login stats, verified status | No link to MakeLila customer/order record |
| **Verification** | Queue of unverified users; one-click Approve | No confirmation that serial maps to a shipped unit before approving |
| **Onboarding** | Funnel bar chart by step | No drill-down per stuck user; no Reina-facing action queue |
| **Firmware** | OTA CRUD: create/activate versions | No acceptance rate per version; no per-device acceptance visibility |

---

## Ryan's Feature Backlog

### In the Lovely PWA (`E:\Claude\Lovely_Beta`)

**LV-1 — Connect live telemetry (replace mock data)** *(P1)*
The PWA reads from `/public/mock/*.json` (fleet.json, sensor_status_events, machine_state, actuator_events). Connect to VCyceneOS Supabase live tables instead.
- Identify the user's `device_identifier` from `devices` table at login
- Pass it to each `/api/*` route instead of hardcoded suffix `0001`
- Replace mock fetches with `supabase.from('telemetry').select(...)` scoped to that device ID
- Touch: `app/api/chambers/route.ts`, `app/api/dashboard/route.ts`, `app/api/system-health/route.ts`, `lib/supabaseClient.ts`
- Needs: VCyceneOS env vars (`VCYCENEOS_SUPABASE_URL`, `VCYCENEOS_SUPABASE_ANON_KEY`) in Lovely Beta deployment

**LV-2 — Event bus triggers (pg_notify → MakeLila)** *(P1)*
Per the [integration spec](integration-lilalovely-2026-06-07.md), add Postgres triggers in Lovely Supabase on:
- `users` INSERT → emit `lovely.signup`
- `users.serial_number` / `devices` row INSERT → emit `lovely.serial_paired`
- `users.onboarding_step` UPDATE → emit `lovely.onboarding_step` / `lovely.onboarding_done`
- `ota_acceptances` INSERT → emit `lovely.ota_accepted`
- `damage_reports` INSERT → emit `lovely.damage_report`
- `compost_batches.completed_at` UPDATE → emit `lovely.batch_complete`
Each trigger fires a webhook POST to the MakeLila `ingest-lovely-event` edge function.
- Touch: new migration in Lovely Supabase project with trigger definitions + edge function `emit-lovely-event`

**LV-3 — Onboarding step server-side sync** *(P1)*
Ensure every onboarding screen mutation calls `PATCH /api/onboarding/step` which updates `users.onboarding_step`. Confirm all 7 steps write the canonical step code.
- Touch: `app/api/onboarding/` routes; verify `pairing_done` is written when `devices` row is created

**LV-4 — Service request deep-link** *(P2)*
When a unit is in error state (chamber status = `error`), surface a "Contact Support" CTA in the Lovely dashboard that opens MakeLila's public `/service-request?serial=LL01-XXXXX` with the serial pre-filled.
- Touch: `app/page.tsx` or `components/system-health-card.tsx` — add CTA when `connectionStatus = 'disconnected'` or any chamber `status = 'error'`

**LV-5 — Admin push notification endpoint** *(P2)*
A service-role-gated endpoint `POST /api/admin/push` accepting `{ serial_number, title, body, url? }` so MakeLila can trigger push notifications from the Service ticket detail. Reuses the existing `web-push` infra and `push_subscriptions` table.
- Touch: new `app/api/admin/push/route.ts`; add auth check for `x-admin-key` header (Supabase service role secret)

---

### In MakeLila (`app/src/modules/Lovely/`)

**LV-6 — Fleet health tab** *(P1)*
New tab: **Fleet**. Per-customer row: customer name, serial number, chamber status (collecting / composting / complete / error), left/right temperature, last telemetry sync timestamp, firmware version. Pulls live data from VCyceneOS via a new `lovely-fleet` edge function.
- Join: `LovelyUser.serial_number` → VCyceneOS device tables
- Error rows should visually stand out (red badge) and sort to the top
- Clicking a row opens the MakeLila customer record (if `customer_app_links` is populated)
- Touch: `lib/lovely.ts` (add `useLovelyFleet` hook), new `FleetTab.tsx`, new Lovely Supabase edge function `lovely-fleet`
- Needs: VCyceneOS service role key accessible from Lovely Supabase edge function (cross-project secret)

**LV-7 — Serial verification before user approval** *(P1)*
In VerificationTab, when an operator is about to click Approve, do an inline check: is `users.serial_number` (or `devices.device_identifier`) present in MakeLila `units` with `status = 'fulfilled'`? If not, surface a warning: "Serial not found in MakeLila — confirm unit was shipped before approving."
- Touch: `VerificationTab.tsx` — add a cross-project serial lookup before the Approve action; new edge function or extend `lovely-verify-user` to return a `serial_valid` flag

**LV-8 — OTA acceptance rate in FirmwareTab** *(P2)*
After publishing a firmware version, show alongside each version: total devices paired / devices that accepted / acceptance % / list of non-acceptors (serial + customer email).
- Touch: `lib/lovely.ts` (extend `useLovelyOta` or add `useLovelyOtaAcceptances`), `FirmwareTab.tsx`

**LV-9 — Link Lovely user → MakeLila customer in UsersTab** *(P2)*
Surface the matched MakeLila customer name + order ref next to each Lovely user row. Uses `customer_app_links` table (shipped as part of the integration doc's step 1).
- Touch: `lib/lovely.ts`, `UsersTab.tsx`

**LV-10 — Onboarding drop-off action queue for Reina** *(P2)*
In the Onboarding tab, add a list view below the funnel chart: users who have been stuck at the same step for >48h. Each row shows: customer name, email, step stalled at, hours elapsed. "Send follow-up" button opens a Quo message draft (using the serial/email as context).
- Touch: `OnboardingTab.tsx`; `lib/lovely.ts` (add `useStalledUsers` helper)

---

## Lovely Module — Target Tab Structure

| Tab | Audience | Gate | Purpose |
|---|---|---|---|
| Users | Ryan, all internal | All internal | Full Lovely user roster; serial, onboarding, login stats, linked MakeLila customer (LV-9) |
| Verification | Ryan, Huayi, George | Leadership | Pending-approval queue + serial validity check (LV-7) |
| Onboarding | Reina, Ryan | Leadership | Funnel chart + stalled-user action queue (LV-10) |
| Fleet | Ryan, Reina, Junaid | Leadership | Live unit health per customer (LV-6) — replaces manual Quo/dashboard checks |
| Firmware | Ryan | Leadership | OTA version CRUD + per-version acceptance rate (LV-8) |

---

## Ryan's Use Flow in MakeLila

### Daily
1. **Lovely → Users**: scan for overnight signups; confirm email matches a MakeLila order
2. **Lovely → Verification**: approve pending users — confirm serial in MakeLila before clicking Approve (LV-7 makes this automatic once shipped)
3. **Lovely → Fleet** *(once LV-6 ships)*: filter by `status = error`; share serial + customer email with Reina for proactive outreach

### When releasing firmware
1. **Lovely → Firmware → "+ New version"**: enter version, description, release notes
2. Set `is_active = true` (deactivates the previous live version automatically)
3. Monitor acceptance rate over 48h (LV-8); ping Reina with a list of non-acceptors for follow-up

### Weekly
1. **Lovely → Onboarding**: review funnel, note the step with most drop-off
2. Share drop-off data with Reina so she can proactively contact stuck users
3. Review users still at `pairing` (signed up, never paired) — these are the highest-risk churners for onboarding

---

## Dependencies and Sequencing

```
LV-3 (onboarding step sync) → required before LV-2 events are accurate
LV-2 (event bus triggers)   → required before MakeLila JourneyTab automation (integration doc step 2-4)
LV-1 (live telemetry)       → required before LV-6 (Fleet tab) can show real data
LV-6 (Fleet tab)            → enables proactive CS for error-state units
LV-7 (serial verify)        → standalone; ship anytime; low effort
LV-8 (OTA acceptance rate)  → standalone; ship after LV-6 (Fleet tab) if bandwidth allows
```

**Suggested first two weeks for Ryan:**
1. LV-3 → LV-7 → LV-1 (the data pipes, no new UI)
2. LV-6 (Fleet tab) — the single highest-value MakeLila surface for the CS team
3. LV-2 (event bus) — hand off to Huayi for ingest edge fn + JourneyTab automation

---

## Open Questions (for George + Ryan)

1. **VCyceneOS cross-project access**: The `lovely-fleet` edge function (in Lovely Supabase) needs a VCyceneOS service role key. Is it OK to store that as a Lovely Supabase secret? Or should fleet reads go through a MakeLila edge function instead?
2. **Admin push auth**: LV-5 needs a shared secret between MakeLila and the Lovely PWA's admin push endpoint. Supabase service role key or a separate `ADMIN_PUSH_KEY` secret?
3. **Privacy — damage photos**: `damage_reports` rows reference photos in Lovely's `damage-photos` storage bucket. Should these be surfaced in the MakeLila Service ticket when a customer files a ticket after a damage report? If yes, the `ingest-lovely-event` function needs to copy or link the photo URL.
4. **Reina's Quo integration for stalled users (LV-10)**: The "Send follow-up" button — should it open Quo via a deep-link URL, or should it call MakeLila's existing Quo integration to pre-draft a message?
