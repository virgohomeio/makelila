# Onboarding flow + Follow-Ups calendar — Design Spec

**Date:** 2026-06-11
**Author:** Huayi Gao (with Claude)
**Status:** Approved (proceed; iterate during build)

---

## 1. Goal

Make the onboarding → follow-up flow explicit and visual:
- Onboarding flow surfaces two primary statuses — **Call scheduled** and **Call complete** (other states retained).
- When an onboarding **call completes**, two follow-ups are scheduled: **FU1 = call + 2 weeks**, **FU2 = call + 4 weeks**.
- A new **Service → Follow-Ups** tab presents a **month calendar** (format of the `lila-customer-followup-calendar` artifact) showing onboarding calls + FU1/FU2 due dates.
- Seed it by importing the artifact's snapshot of onboarding calls.

This **replaces** the prior follow-up cadence (FU1 = onboard + 7d, FU2 = onboard + 30d) with one unified, call-anchored cadence.

## 2. Decisions (locked in)

| Decision | Choice |
|----------|--------|
| Follow-up model | **One unified system**, re-cadenced to 2wk/4wk, anchored on the onboarding call. |
| Onboarding statuses | **Keep all** (`not_scheduled`/`scheduled`/`completed`/`no_show`/`skipped`); surface `scheduled`→"Call scheduled", `completed`→"Call complete" as the two primary. |
| Data import | Import the artifact's **onboarding calls** (`SNAPSHOT_GCAL_EVENTS`) to seed the schedule. |
| Follow-up storage | **Derived, no new table** — FU dates computed from the call/anchor date, same as today's `computeFuState`. |

## 3. Anchor (already in place)

`markOnboardingComplete()` already mirrors `onboarding_completed_at` → `customers.onboard_date` (it's the documented FU anchor). So follow-ups remain anchored on `customers.onboard_date`, which equals the onboarding-call-complete date. **The only cadence change is the day counts.**

## 4. Components

### 4.1 Cadence change (unified)
- `app/src/lib/customers.ts`: `FU1_DAYS 7 → 14`, `FU2_DAYS 30 → 28` (+ comment). `computeFuState` unchanged otherwise. This re-cadences the **Customers → Overdue Follow-ups** panel + everything reading `computeFuState`.
- `supabase/functions/generate-followup-drafts/index.ts`: `FU1_DAYS 7 → 14`, `FU2_DAYS 30 → 28`; redeploy via MCP so the SMS drafting matches.

### 4.2 Onboarding status labels
- Display map: `scheduled` → **"Call scheduled"**, `completed` → **"Call complete"** (in `OnboardingTab` chips/labels). Underlying enum values unchanged (no migration). Other states keep their labels.

### 4.3 Service → Follow-Ups tab (calendar)
- New `app/src/modules/Service/FollowUpsTab.tsx`: a **month grid** (‹ Month Year ›, today highlight) like the artifact.
- Events per day, from live data:
  - 🚀 **Onboarding calls** — from onboarding tickets' `calendly_event_start` (and lifecycle), with customer + Meet link where present.
  - 📞 **FU1** = `onboard_date + 14d`, **FU2** = `onboard_date + 28d`, per customer with an `onboard_date` and the matching FU not yet done (`fu1_status`/`fu2_status` null). Color-coded; click → open the customer/ticket.
- Add tab to `Service/index.tsx` `TABS` (order: Onboarding · Support Tickets · Replacement · **Follow-Ups** · Inbox) + mobile meta. Pure date math; no new table.

### 4.4 Data import (one-time)
- Migration/seed: from the artifact's `SNAPSHOT_GCAL_EVENTS` (onboarding calls — customerEmail, customerName, start, conferenceUrl), match to `customers` by email; ensure a `customer_lifecycle` row + set `onboarding_status` = `scheduled` (future call) or `completed` (past call, + `onboarding_completed_at` = call date + mirror `onboard_date`). Insert-only / no-clobber per system-of-record rules. This populates the calendar with real upcoming calls + derived follow-ups.

## 5. Out of scope
- Auto-creating follow-up *tickets* or SMS at FU due (the existing queue handles outreach).
- Two-way Google Calendar sync (snapshot import only for now).
- Rescheduling FUs off ticket-close dates (the artifact's `SNAPSHOT_CLOSED_DATES` behavior) — deferred.

## 6. Testing
- `customers.test` / tag tests: `computeFuState` boundaries at 14/28 days.
- `FollowUpsTab`: renders calls + FU markers on correct days; month nav; empty state.
- Edge fn cadence is config-only (manual verify after redeploy).

## 7. File touch list
| File | Action |
|------|--------|
| `lib/customers.ts` | cadence 14/28 |
| `supabase/functions/generate-followup-drafts/index.ts` | cadence 14/28 + redeploy |
| `modules/Service/OnboardingTab.tsx` | "Call scheduled" / "Call complete" labels |
| `modules/Service/FollowUpsTab.tsx` | new calendar tab |
| `modules/Service/index.tsx` | mount Follow-Ups tab |
| `modules/Service/Service.module.css` | calendar styles |
| seed migration | import onboarding calls from snapshot |
