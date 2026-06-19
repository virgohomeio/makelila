# Backlog

## Features

1. **Mirror Shopify post-payment customer emails** — capture the emails Shopify sends to customers after they pay (order confirmation, etc.) into our system so we have a unified record.
   - _Shopify sync itself has been substantially improved: contact/address re-sync (509c1e0, Alpha P2 #6), apt/non-house auto-flagging (dd41e9b), postal_code capture (6f9fdc6), payment summary sync (45e981f). Customer-facing email mirroring is the remaining piece._

2. **Freightcom auto-tracking + email injection** — auto-fetch tracking numbers from Freightcom (instead of the current manual Excel backfill via 1209f86) and inject them into the fulfillment customer email template.
   - _Related: existing P2 #7 "Freightcom/ClickShip Dedup" in [docs/feature-backlog-alpha-feedback.md](docs/feature-backlog-alpha-feedback.md) investigates whether ClickShip already eliminates manual Freightcom entry — resolve that first since the integration approach depends on it._

3. **Classify Quo conversations before they become tickets** — not every Quo (OpenPhone) conversation is a support ticket. Categories observed in the data:
   - **Outbound onboarding follow-up** — team-initiated check-ins ("Hello [name], this is Ashwini/Reina/Pedrum from LILA…"). Should update the onboarding follow-up calendar / `customers` table, NOT create a `service_tickets` row.
   - **Inbound onboarding/sales request** — new customer inquiry before purchase. Different routing than support.
   - **Real support ticket** — inbound complaint, shipping question, malfunction. Current behavior is correct for these.
   - _Approach:_ design doc at [docs/2026-05-27-quo-conversation-classifier-design.md](docs/2026-05-27-quo-conversation-classifier-design.md). Classifier runs in [sync-quo-tickets](supabase/functions/sync-quo-tickets/index.ts) before the `service_tickets` insert. Signal = first message direction; outbound-then-inbound is promoted to ticket only if the customer reply hits a real category in the existing rule classifier.
   - _Cleanup needed:_ the 53 tickets just synced (1 inbound-first, 52 outbound-first) include many that should not be tickets at all. After the classifier ships, run a one-shot backfill to delete/convert the wrong ones.

4. **Household-unit customer model** — replace the single-person `customers` row with a household-as-unit model. One household has a shared address but multiple contact people (e.g. husband + wife), each with their own name / email / phone. Inbound emails or calls from any household member resolve to the same household so we can see the full service history regardless of who reached out.
   - _Why:_ today a couple living together appears as two unrelated customers; tickets, follow-ups, and unit ownership end up split across rows. Operators have to manually correlate.
   - _Shape (sketch):_ new `households` table (id, address fields, onboard_date, fu1/fu2/notes). Each existing `customers` row becomes a `household_contacts` row (id, household_id, role, full_name, email, phone). Existing FKs (orders, units, tickets) migrate to point at `household_id` rather than the individual contact. Inbound matching (Quo phone, Gmail email) looks up `household_contacts` first, then resolves to the parent household.
   - _Migration risk:_ touches nearly every module (Orders, Fulfillment, Service, Customers, Stock unit ownership). Should be specced carefully before any code — propose a dedicated design doc when prioritized.

5. **Capture Quo message attachments (photos) in tickets** — the [sync-quo-tickets](supabase/functions/sync-quo-tickets/index.ts) edge fn currently stores only `body_text` / `snippet` for each message and silently drops any media (photos/videos) the customer sends. Customers regularly attach photos of defects (cracked latch, broken bin, etc.) and operators currently have to switch to the Quo app to view them.
   - _Concrete trigger:_ 2026-06-08 Leen Schafer (ticket `46af21a0-…`) sent "I'm attaching the picture of the lock" — the photo exists only on Quo's side; nothing in our DB.
   - _Shape (sketch):_ either (a) add `media_urls text[]` column to `ticket_messages` + store Quo's CDN URLs verbatim, or (b) re-host: add a `ticket_attachments` table + Supabase Storage bucket and have the sync fn download + upload + record. (b) is more resilient (Quo URLs may expire) but heavier; start with (a) and migrate later if URLs break.
   - _Surface in UI:_ ticket detail panel shows inline thumbnails for inbound messages with attachments.
