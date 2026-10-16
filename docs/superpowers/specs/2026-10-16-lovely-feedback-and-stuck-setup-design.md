# Design: Lovely app feedback as support tickets, and a "stuck in setup" list

**Date:** 2026-10-16
**Modules:** Service › Support Tickets, Lovely › Onboarding
**Ask:** make everything customers report in the Lovely app reach makeLILA, so
nothing is lost; and show who is stuck in setup so the team can reach out
before the customer has to email (a customer's machine sat on "waking up" for
over a week before anyone knew).

## 1. In-app feedback → support tickets

The Lovely app's "Send feedback" button writes `public.feedback` in the Lovely
project: `kind` (bug, idea, other), `message`, `page_path`, `app_version`,
`user_agent`, an optional screenshot in the private `feedback-photos` bucket.
Damage reports already become tickets (2026-10-05 spec); feedback did not, so
nobody saw it. As of this spec there are 7 rows (6 bugs, 1 other).

**Same pipeline as damage reports.** `sync-lovely-tickets` (every 15 min) now
runs a second, independent half for feedback. Same rules: insert-only,
first run is the backfill, a unique violation means "already synced", same
customer resolution (serial → unit → customer, then app account link).

**Why a new Lovely-side function.** `feedback` is service-role only (unlike
`damage_reports`, it is not anon-readable), so the cron can't read it with the
anon key. `lovely-feedback` (deployed to the Lovely project) reads it with the
Lovely service role and returns it only to callers presenting the shared secret
`LOVELY_FEEDBACK_SYNC_SECRET`. This keeps the Lovely service role key inside
the Lovely project. It also joins each sender's account email, so a sender
makeLILA can't match to a customer still has an address to reply to.

**Ticket fields:**

| Column | Value |
|---|---|
| `source` | `lovely_app` (same "From Lovely app" badge as damage reports) |
| `kind` / `category` / `status` | `ticket` / `support` / `waiting_on_us` |
| `priority` | `normal` for bug and other, `low` for idea |
| `issue_area` | `software` for bug and idea, `other` for other |
| `subject` | `App bug: <first line of message>` (or `App idea:` / `App feedback:`), cut to 60 characters |
| `description` | the message, then the page, app version, device and name in the app |
| `customer_*` | from resolution; when unresolved, the app name and account email |
| `lovely_feedback_id` | the feedback id (dedupe key, unique) |
| `lovely_feedback_photo_path` | the screenshot's path, or null |

The photo path is copied onto the ticket because the detail panel can't look
the feedback row up (not anon-readable). The panel signs it on demand through
`lovely-damage-photos`, which now takes an optional `bucket`
(`damage-photos` default, or `feedback-photos`; anything else is a 400).

## 2. Stuck-in-setup list (Lovely › Onboarding)

- Each funnel step is now clickable. It lists the customers on that step: name,
  email and phone (click to email or call), serial, the screen they're on now,
  how long they've been there, machine status and signup date. Longest wait
  first.
- A customer on a mid-setup step for 3+ days is marked **Stuck**, and the
  funnel row shows how many are stuck.
- A red callout lists customers who **finished setup 3+ days ago but whose
  machine isn't sending data**: machine never seen, or silent for the whole
  3-day telemetry window when setup was in the last 30 days (older history
  can't always be checked; past 30 days a silent machine is more likely one
  that ran and died, which the Activity tab already shows as Unit down). A
  failed telemetry read is never flagged, same as the Activity tab.
- The step list now includes `install_done` ("Installed the app"), which the
  Lovely app added and the funnel was missing.

**How long on a step** needed a new field. `users.updated_at` changes on every
write to the row (logins, approvals), so it can't say when the step changed.
The Lovely project gets `users.onboarding_step_at`, stamped by a trigger
whenever `onboarding_step` changes (Lovely repo
`schema/migrations/onboarding_step_at_2026_10_16.sql`). Users still on the
signup step are backfilled from `created_at`; everyone else shows
"Not tracked" until their next step change. `lovely-users` now also returns
`phone_number` and `onboarding_step_at`.

Not built: opening a support ticket automatically for a never-online machine.
The list makes the cases visible first; auto-tickets can follow once the
threshold has proven itself.

## Deploy order

1. **Lovely database:** apply `schema/migrations/onboarding_step_at_2026_10_16.sql`
   (Lovely repo). Must come before step 3, or `lovely-users` selects a column
   that doesn't exist and the Users tab breaks.
2. **Secret, both projects, same value:**
   `supabase secrets set LOVELY_FEEDBACK_SYNC_SECRET=<value> --project-ref arfdopgbvlfmhmcfghhl`
   and the same with `--project-ref txeftbbzeflequvrmjjr`.
3. **Lovely functions** (`app/supabase/functions`, project `arfdopgbvlfmhmcfghhl`):
   deploy `lovely-feedback`, and redeploy `lovely-users` and
   `lovely-damage-photos`, all with verify_jwt off (as the existing ones are).
4. **makeLILA database:** apply `supabase/migrations/20261016120000_lovely_feedback_tickets.sql`.
5. **makeLILA function:** redeploy `sync-lovely-tickets`. The next cron run
   backfills the existing feedback as open tickets.
6. **makeLILA app:** ship the frontend as usual.

Until step 2 is done the feedback half reports `skipped` and the damage half
runs as before.
