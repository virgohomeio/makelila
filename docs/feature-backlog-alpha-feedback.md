# makeLILA Feature Backlog — Alpha Feedback

> Compiled from the "makeLILA app beta release" email thread (Apr 21 – May 26, 2026)
> 
> Contributors: Pedrum Amin, George Yin, Junaid Siddiqui
> 
> Status: Raymond Zhu feedback still pending (due by May 28 fulfillment day)

---

## P1 — High Priority (multiple requestors or CEO-mandated)

### 1. Google Maps Address Verification
**Source:** Pedrum (Apr 29 + May 26)
**Description:** Auto-check customer addresses against Google Maps API on order sync. Detect postal/ZIP mismatches between what the customer entered and what Google Maps returns. Trigger automated email asking the customer to confirm the correct version.
**Flow:** Order synced → address validated → mismatch detected → email sent to customer with both versions → customer confirms → address updated in makeLILA + Shopify.

### 2. Returns & Refunds Module (move from Google Sheets to makeLILA)
**Source:** Pedrum (Apr 29), George (May 24)
**Description:** Full returns workflow inside makeLILA, replacing the current Google Sheets process.

**Requirements from George:**
- Add "Reason for Return" field with dropdown: Product Defect, Software Issue, Shipping Damage, Customer Service Issue, Financing Issue, Other
- Return & Refund Dashboard showing: Responsible Team, Returns by Channel, Return by Unit Conditions, Monthly Returns Trend (current year)
- Finance Review step with:
  - Button/checkbox for finance review completion
  - Access to correct refund amount (handle partial refunds — e.g. Katrina Dowd case where lila.vip missed a partial refund)
  - Notes field explaining corrections
  - Refund method selection: Shopify, Sezzle financing, QuickBooks credit card, or bank e-transfer
- **Business rule:** No refund processed before receiving returned unit
- **Business rule:** Customer-paid shipping cost is non-refundable

**Requirements from Pedrum:**
- Approval layer (George reviews/approves; Julie may also be involved)

### 3. Email/SMS Templates for Common Scenarios
**Source:** Pedrum (Apr 29 + May 26)
**Description:** Built-in templates for common fulfillment communications:
- Missing phone number follow-up
- Missing email follow-up
- Address verification mismatch (tied to feature #1)
- Return label sent
- Replacement unit shipped
- General status update

Should support both email and SMS channels. Templates should be editable by the team.

### 4. Shopify Order/Payment Summary Sync
**Source:** Pedrum (May 26)
**Description:** Sync the full Shopify order financial breakdown into makeLILA:
- Product subtotal
- Tax amount (if any)
- Shipping amount paid by customer
- Discount codes applied
- Total paid
- Payment method

This data is needed for accurate refund calculations (Finance Review) and operational visibility.

---

## P2 — Medium Priority (single requestor, clear value)

### 5. Machine-Level Tracking Fields (QC/Fulfillment)
**Source:** Junaid (May 26)
**Description:** Per-machine tracking to replace Feishu, with the following fields:

| Field | Description |
|-------|-------------|
| Firmware Version | What firmware version the machine was shipped with |
| Technician | Who last touched the machine before shipping |
| Defect Notes | Editable free-text notes for any defect information |
| Electrical Pass/Fail | Three-state: Pass, Fail, Incomplete (current Feishu tick box doesn't differentiate incomplete from failed) |
| Mechanical Pass/Fail | Same three-state as Electrical |

These fields should live on the Serial Tracker and be visible/editable during the fulfillment flow.

### 6. Shopify Two-Way Sync
**Source:** Pedrum (Apr 29)
**Description:** Currently unclear if address/contact changes in Shopify propagate back to makeLILA after initial order sync. Need:
- Ongoing sync of address/contact changes from Shopify → makeLILA
- Clarify if makeLILA edits should push back to Shopify (bidirectional)
- Define conflict resolution if both sides change

### 7. Freightcom/ClickShip Integration Dedup
**Source:** Pedrum (Apr 29)
**Description:** ClickShip already syncs Shopify order data. Investigate whether the fulfillment team still needs to manually input data into Freightcom. Goal: eliminate double-entry if ClickShip already has the data.

---

## P3 — Lower Priority / Strategic Questions

### 8. HubSpot Relationship Clarification
**Source:** Pedrum (Apr 29)
**Description:** Define whether makeLILA replaces HubSpot for support ticketing or sits alongside it. Current concern: platform overload and data duplication across HubSpot + makeLILA + Shopify. Need a clear "system of record" decision per data type.

### 9. Klaviyo Integration for Email Automation
**Source:** Huayi (May 26, in reply to Pedrum)
**Description:** Integrate with Klaviyo for automated email flows. Could power the email templates (feature #3) and address verification outreach (feature #1) through Klaviyo's infrastructure rather than building email sending from scratch.

---

## Post-alpha additions

### 12. Outbound replies from tickets via support@virgohome.io
**Source:** Huayi (May 27, while wiring Quo→ticket polling)
**Description:** Tickets currently land in makelila from Gmail and (soon) OpenPhone/Quo, but operators can't reply from within makelila. Add a "Reply" composer to the TicketDetailPanel that sends through the `support@virgohome.io` mailbox (probably via Gmail API send-on-behalf or a Resend-from address). Threads outbound replies into the same ticket. Out of scope for v1 of the Quo integration; tracked here for follow-up.

---

## Raymond Zhu Feedback (May 27)

### 10. Link Customer → their Order(s) from the Customers module
**Source:** Raymond Zhu (May 27 email)
**Description:** From the Customers tab, when an operator opens a customer's record they currently see name, email, phone, and location — but there's no jump to that customer's order(s) in the Order Review / Post-Shipment / Fulfillment modules. Add a clickable list (or button) on the customer detail that shows their orders + opens the relevant module's detail panel.

### 11. Customer detail: show full address instead of just "location"
**Source:** Raymond Zhu (May 27 email)
**Description:** The `location` field on the Customer detail is too coarse for workflow use. Show the full address (street + city + region + postal + country) instead. Data exists on `customers` (address_line, city, region, postal_code, country); UI just needs to render all of it.

---

## Feedback Status (as of 2026-05-27)

- ✅ **Pedrum Amin** — items #1, #3, #4 (Apr 29 + May 26)
- ✅ **George Yin** — item #2 (May 24)
- ✅ **Junaid Siddiqui** — item #5 (May 26)
- ✅ **Raymond Zhu** — items #10, #11 (May 27)
- **Reina George** — Was asked to populate Pedrum's feedback onto the CJM (May 7). Status unknown; ops feedback overlaps with the meeting-derived backlog (follow-up calendar, ticket autocomplete, etc.).
- ~~**Aaron, Ashwini**~~ — Co-op terms complete; left the company. No feedback expected.
- ~~**Kevin**~~ — In China; not collecting feedback this round.

Alpha feedback collection window is **closed**. The 11 items above plus the meeting-derived backlog are the working scope.

---

## In-person team walkthrough (2026-05-28)

> Source: in-person review at the office with Pedrum (Sales & Marketing), Raymond + Junaid (Fulfillment & Stock), and Reina (Customer Service). Recap also captured in Fireflies. 32 items below, organized by team area; numbering continues from the alpha-feedback set.

### Sales & Marketing — Pedrum

- **#13** Verify-address: returns "Could not verify" too often. Google Maps Geocoding is unreliable on Canadian rural addresses. Investigate an LLM-backed verifier (Claude) as a fallback or replacement. *Follow-up to shipped #1.* — **SHIPPED** (verify-address edge fn v23, lines 169–215; runs Claude haiku-4-5 only when Google returns "unverifiable" AND `ANTHROPIC_API_KEY` is set; upgrades the match verdict per Claude's plausibility judgment).
- **#14** Freight estimate fails to render on some orders (e.g. Joseph's) — ops had to compute manually.
- **#15** Freight estimate must account for line-item quantity (currently appears to assume single unit).
- **#16** Freight estimate text doesn't show on the order card in some states.
- **#17** Surface the freight-estimate source (ClickShip / Freightcom / Shopify) on the card so ops know which system the number came from.
- **#18** Change freight estimate display currency to **CAD** (currently USD).
- **#19** Pull freight estimate from **ClickShip or Freightcom**, not Shopify. Shopify totals include our free-shipping promo + $100 credit, which makes the number wrong for refund and cost math. *Ties to pending #7 ClickShip dedup.*
- **#20** Shopify Payment Summary: show currency code per line. *Follow-up to shipped #4.*

### Fulfillment & Stock — Raymond & Junaid

- **#21** Reverse the "assign serial" flow. Today the order auto-suggests an available unit and ops chase the machine. Desired: prep a unit to "ready" status in Stock first, then assign it to a customer/order later.
- **#22** Stock state out-of-sync. Serial 284 was shipped to Linda but the app still offers it as available for Joseph. Need a full re-sync from physical inventory + Notion IQC log.
- **#23** Add a search bar for unit serial numbers on the "assign to customer" picker so ops can type a known serial.
- **#24** Create a Google Drive folder for electrical test reports and link it from the unit detail panel so techs can attach reports per unit.
- **#25** Add **Canpar** and **GLS** to the carrier dropdown on the shipment step.
- **#26** Fulfillment back-button bug: after selecting a serial for one customer, navigating back leaves the unit marked unavailable for other customers within the session — needs to release the hold on back-out.
- **#27** Rename "Customer / Location" column header in the Stock tab (label mismatched with what's actually shown).
- **#28** To-dock handoff checklist: add a "Carrier picked up" step.
- **#29** Tracking-link email to customer didn't auto-send during testing — debug the send-template-email trigger on shipment commit.
- **#30** Auto-confirm customer receipt — either delivery webhook from the carrier or a follow-up SMS/email asking the customer to confirm.

### Customer Service — Reina

- **#31** Onboarding tab: split into "needs onboarding — not yet scheduled" vs. "onboarding scheduled" sections so Reina can see who to chase. — **SHIPPED** (OnboardingTab filter chips at lines 112-141, default view picks the cohort with the larger backlog).
- **#32** Calendly sync delay. Reina scheduled an onboarding session with Huayi (using Pedrum's test profile) and Pedrum accepted it, but the booking didn't appear in makeLILA promptly. Tighten the sync cadence or webhook.
- **#33** Onboarding detail panel currently reuses the ticket layout. Needs an onboarding-specific view with a "Mark complete" button instead of ticket fields. — **SHIPPED** (inline `LifecycleActions` row in OnboardingTab lines 174-210 — Mark complete / No-show / Skip buttons on each row, no need to open the ticket panel).
- **#34** Customer picker for new tickets didn't surface Pedrum's secondary profile (`pedruma71@gmail.com`). That profile is also missing from the Customers tab. Customer-sync gap.
- **#35** *(Note for later — strategic.)* If we rule HubSpot out as a customer source, we'll need a robust Shopify → customer sync. Today there's a rare Shopify import path that fails to create the customer profile on order arrival. *Ties to #8 system-of-record decision.*
- **#36** "Create support ticket" form: once a customer is selected, auto-populate their unit serial number(s).
- **#37** Ticket status labels need refresh — action-oriented terms like "Complete", "Needs to reach out", etc.
- **#38** Add a Category field on tickets so we can report issue volume per area (electrical, mechanical, onboarding, billing, etc.).
- **#39** Owner-email list is stale: Aaron and Ashwini still appear (both left); Reina is missing.
- **#40** Follow-up calendar based on onboarding date — auto-schedule 1-week / 1-month check-ins after onboarding completes. — **SHIPPED** (OnboardingTab "Check-ins" filter view lines 379-454; FU1=7d / FU2=30d cadence in lib/customers FU1_DAYS/FU2_DAYS; inline Called/Messaged/Reviewed action buttons per row).
- **#41** Define the support-ticket → Repair tab pipeline. Today it's ambiguous how a defect-flagged ticket moves into the repair queue. — **SHIPPED** (Replacement tab now has a default-open "Triage candidates" section listing service tickets where topic ∈ return_hardware_defect/warranty_replacement AND status not closed/resolved AND replacement_order_id is null; click → ticket panel → "Send replacement" creates the order via #55 flow; row drops off automatically once linked).
- **#42** Customers tab: data sync is incomplete — fields missing on some customers. Likely linked to #34.
- **#43** Add unit serial number to the customer profile card in the Customers tab (currently you have to cross-reference Stock).
- **#44** Auto-invite Reina to every customer onboarding call when it is scheduled in Calendly. — **SHIPPED** (2026-06-04; refined 2026-06-04 per operator feedback). `sync-calendly-events` cron looks up the Calendly-created event on `CALENDAR_INVITER_MAILBOX`'s Google Calendar via `events.list` (±2 min window around `calendly_event_start`, matched by customer email attendee) and PATCHes its attendees to add `REINA_INVITE_EMAIL` with `sendUpdates=all`. Skips Saturday + Sunday in `REINA_TIMEZONE` (default `America/Toronto`). Dedupe via `service_tickets.reina_invited_at`. Originally created standalone "co-host" events instead of patching — replaced after the first 3 went out because Reina's calendar got cluttered with duplicate events.

---

## Codebase Review Follow-up for Claude (2026-06-02)

> Source: codecs-generated codebase review and recommendations. These items are tagged `codecs` so Claude can identify that they were generated by codecs for review.

- **#45** Lock down Edge Function authorization.
  **Tags:** codecs
  **Description:** Several Edge Functions are configured with `verify_jwt = false` while using the Supabase service-role key internally. Re-enable JWT verification where possible, or manually verify the bearer token and require an approved internal profile/role before allowing email sends, Shopify pushes/syncs, HubSpot syncs, Calendly syncs, address verification, or customer-list pushes.

- **#46** Move internal-user authorization into Supabase/RLS.
  **Tags:** codecs
  **Description:** The app currently enforces `@virgohome.io` access in React, while representative RLS policies allow any `authenticated` user. Add a database-side helper or trusted claim/profile check, update broad `authenticated using (true)` policies, and consider disabling open signup or adding an auth hook for non-internal accounts.

- **#47** Make telemetry configuration failure local to the Dashboard.
  **Tags:** codecs
  **Description:** Missing `VITE_TELEMETRY_SUPABASE_URL` or `VITE_TELEMETRY_SUPABASE_ANON_KEY` currently throws during module import and can break unrelated routes like `/login`. Lazy-load the Dashboard route and/or make the telemetry client nullable so only the Dashboard shows a "Telemetry not configured" state.

- **#48** Tighten anonymous service attachment uploads.
  **Tags:** codecs
  **Description:** The `ticket-attachments` storage policy allows anonymous uploads to any UUID-shaped path. Require the path UUID to match an existing `service_tickets.id` with `source = 'customer_form'`, or proxy uploads through a rate-limited Edge Function that validates file type/count/size and creates the attachment row atomically. Add cleanup for orphaned files.

- **#49** Restore lint as a green development gate.
  **Tags:** codecs
  **Description:** `npm run lint` currently fails under React 19 lint rules, mostly from `Date.now()` in render paths, synchronous state updates in effects, and React Refresh mixed exports. Decide whether the app is staying on React 19 or aligning back to the React 18 project brief, then fix or tune lint rules and add lint to CI once green.

- **#50** Stabilize Playwright e2e tests.
  **Tags:** codecs
  **Description:** `npx playwright test` currently fails when telemetry env vars are absent. Provide test env defaults or mock telemetry, then expand e2e coverage beyond unauthenticated redirects to include public form validation/submission and at least one authenticated happy-path smoke test with a seeded or mocked session.

- **#51** Reduce Dashboard/Plotly bundle cost.
  **Tags:** codecs
  **Description:** Production build succeeds after dependencies are refreshed, but the main JS bundle is large because Dashboard/Plotly are pulled into the primary chunk. Dynamically import the Dashboard and Plotly chart module so operational routes load faster.

- **#52** Review dependency audit findings.
  **Tags:** codecs
  **Description:** `npm audit --audit-level=moderate` reports moderate advisories in `brace-expansion` and `ws`. Run `npm audit fix`, review the lockfile changes, and verify tests/build afterward.

---

## Operational follow-ups (post-walkthrough)

- **#53** Dashboard: surface customer name instead of serial number for connected machines.
  **Source:** Huayi (2026-06-03 in-session note)
  **Description:** The telemetry Dashboard currently lists machines by their LL01-*** serials. Operators rarely think in serials — they know customers by name. Replace the serial label in the Dashboard's serial picker / chart legends / status table with the customer's name (fall back to serial when no customer is linked, e.g. team/test units). Data source: join `dashboard.useSerialToUser()` already exposes the link; just thread the resolved name through the UI.

- **#54** Dashboard: click an unassigned serial to assign a customer (with makelila-suggested match).
  **Source:** Huayi (2026-06-04 in-session note)
  **Description:** Complement to #53. When the Dashboard renders a unit by its serial because no customer is linked, make that serial clickable. Opens a small assignment modal: makelila suggests the most likely customer based on the existing serial → customer mapping in `units.customer_name` / `customer_lifecycle.customer_id` (e.g. fuzzy-match on names, or recent orders shipped near that serial's manufacture date). Operator verifies the suggestion (or picks a different customer from a search box) and confirms; on confirm, write the link to `units.customer_name` (and/or `customer_lifecycle`) so the unit appears under that customer everywhere — Dashboard, Customers tab, Service tickets, etc. Should also create a `customer_lifecycle` row if one doesn't exist for the (customer, serial) pair so the FU calendar wires up. Audit: log via `activity_log` who did the assignment + when.
  **Likely touch:** new `lib/dashboard.ts` mutator for assignment; new modal component in `Dashboard/`; light JOIN logic for the suggestion (probably matches against `customers.full_name` ILIKE patterns derived from any partial-name fields already attached to the telemetry record, or surfaces customers without a linked unit as candidates).

- **#55** Service: rename "Repair" tab to "Replacement"; add replacement-parts shipping workflow.
  **Source:** Huayi (2026-06-04 in-session note)
  **Description:** Today the Service module's fourth tab is labelled "Repair" — in practice we don't repair units, we ship replacement parts (or full replacement units). Rename the tab to "Replacement" everywhere it surfaces (Service tab bar in `Service/index.tsx`, route labels, any internal `repair` / `RepairTab` identifiers can stay as code but the user-facing label should be "Replacement"). Then add a "send replacement parts" action on a Service ticket: operator picks which parts/SKUs to ship (drawing from the parts inventory in `lib/parts.ts` and/or `lib/stock.ts`), and on confirm an internal replacement order is created. That replacement order should:
    1. Appear in the Replacement tab (this tab's list view = the queue of in-flight replacements, not the old "repair-this-unit" idea).
    2. Flow through the same downstream pipeline as a regular customer order: Order Review → Fulfillment → Post-Shipment (so it gets address review, freight/label generation, tracking email, and any return handling for free, instead of being a parallel one-off process).
  Implementation considerations: the replacement order likely needs a flag so Order Review / Fulfillment can distinguish replacement vs. paid sales (no Shopify charge, no Sezzle, just an internal order). Decide whether replacement orders write into the existing `orders` table with a `kind = 'replacement'` discriminator or into a new `replacement_orders` table that joins to `service_tickets`. Either way, link bidirectionally: the ticket shows the resulting replacement order; the order shows the originating ticket. Activity log on creation. Also clarify: does a "send replacement unit" (whole machine) follow the same workflow, or only parts? Probably yes — same flow, just different line items.

- **#56** Activity Log: identify the actor on every entry + add a right-side KPI panel.
  **Source:** Huayi (2026-06-04 in-session note)
  **Description:** Two linked enhancements to the Activity Log module:
    1. **Actor identity on every entry.** `logAction()` already attaches `user_id`, but the feed currently renders entries chronologically without the operator's name surfaced prominently. Show the user (full name + initial avatar) on each row so we can track who is doing what over time. Group consecutive entries by the same user into "sessions" (≤90 min gap) per the original design. This sets up cross-time behavioral analysis — e.g. "Reina handled 12 tickets this week", "Pedrum's order-review throughput is X/day".
    2. **Right-side KPI panel.** Add a dashboard panel to the right of the audit feed that surfaces the most critical operational metrics. The original brief in [docs/2026-04-16-make-lila-app-design.md](2026-04-16-make-lila-app-design.md) (§ Activity Log module) specifies the layout: a 5-tile top KPI row + a 3-card "KPI Overview — Fulfillment" row + a 3-card second KPI row + a 2-column team contribution section. Use that as the starting spec; today's traffic patterns (returns/refunds, replacement parts, follow-up SMS volume, address-verify pass rate, etc.) probably warrant tile re-selection during implementation. KPIs should be derived from `activity_log` rows directly so no separate aggregation pipeline is needed.
  **Likely touch:** `app/src/modules/ActivityLog.tsx` (currently single file — likely needs splitting into `ActivityLog/index.tsx` + `Feed.tsx` + `KpiPanel.tsx`); `lib/activityLog.ts` to add aggregate helpers (sessionize, KPI counters); join with `profiles` for full name + avatar initial.

- **#57** Fulfillment: temporary backfill flow so Raymond can record historically-shipped units.
  **Source:** Huayi (2026-06-04 in-session note)
  **Description:** Raymond has been managing previously-shipped LILA units via the Google Sheets fulfillment log. Those units never went through makeLILA's Fulfillment pipeline, so the operational record is incomplete (Stock shows them as `ready` / `reserved` / missing entirely, and Post-Shipment has no row). Add a **temporary** backfill mode in the Fulfillment module — gated behind a feature flag or a hidden "Backfill mode" toggle so it doesn't pollute the default flow — that lets Raymond:
    1. Click into a customer's fulfillment slot as normal, but on the serial picker also expose serials in the `shipped` status (not just `ready`), so he can select a unit that has *already* been shipped and bind it to the customer/order record.
    2. Walk that pairing through a condensed Fulfillment → Post-Shipment sequence to produce the same downstream artifacts (assignment, shipment, tracking row, fulfilled-at timestamp) without re-printing labels or emailing the customer. The flow needs to mark these as backfilled (e.g. `backfilled_at`, `backfill_source = 'google-sheet'`) so we can tell them apart from live shipments in reporting.
    3. Pull the canonical shipping info (carrier, tracking #, ship date, address used) from the Google Sheets export so Raymond doesn't have to retype every row.
  **Why temporary:** Once the historical Sheet is fully imported, this UI should be hidden again — otherwise it becomes a permanent backdoor that lets ops re-assign already-shipped serials, which is exactly the kind of state drift #22 is trying to prevent. Add a TODO/cleanup ticket inline. *Related: #21 (reverse assign-serial), #22 (stock-state re-sync), #29 (tracking-link email auto-send).*
  **Likely touch:** Fulfillment serial picker (`Fulfillment/Queue/SerialPicker.tsx` or similar) — extend the status filter to include `shipped` when the backfill flag is set; new "Backfill" tab or hidden route in Fulfillment; reuse existing `updateUnitFields` for the pairing write; light log entry per backfill via `activity_log`.

- **#58** Customers: per-customer profitability tab with filter/search + insights.
  **Source:** Huayi (2026-06-04 in-session note, mid-brainstorming for #55)
  **Description:** Add a "Profitability" tab to the Customers module that surfaces which customers we're making money on and which we're losing money on. One card per customer; filterable + searchable.
  Per-customer card surfaces:
    1. Lifetime revenue (sum of `orders.total_usd` where `kind='sale'`).
    2. Lifetime cost-of-goods (sum of `orders.cogs_usd` across both sales and replacements, since #55 introduces that column).
    3. Lifetime shipping cost (sum of `orders.shipping_cost_usd` — the actual freight/label cost, also introduced by #55).
    4. Warranty cost (sum of `orders.cogs_usd + shipping_cost_usd` where `kind='replacement'`) — surfaced separately because high warranty cost is the biggest signal of an unhappy / defective-unit customer.
    5. Refunds issued (sum from `refund_approvals`).
    6. Net margin = revenue − COGS − shipping − refunds − warranty.
    7. Counts: # orders, # replacements, # returns, # support tickets opened.
  Filters / sorts:
    (a) "Most profitable" — sort by net margin descending.
    (b) "Losing money" — filter to net margin ≤ 0, sort ascending.
    Search box for customer name. Optional secondary filters: by country (CA vs. US), by onboard-date cohort (helps spot if a specific batch / month has a warranty-rate spike).
  Insights view (small panel above the card grid): aggregate stats — e.g. "Avg margin per CA customer: $X / per US customer: $Y", "Customers with ≥2 replacements: N (avg margin: $Z, vs. baseline $W)". The goal is to reveal customer cohorts where margin is structurally negative.
  **Why now (after #55):** #55 introduces `orders.cogs_usd` + `orders.shipping_cost_usd` on every order, which is the data foundation this tab needs. Without #55, lifetime cost can't be computed.
  **Likely touch:** new `app/src/modules/Customers/ProfitabilityTab.tsx` + `lib/customers.ts` aggregate helpers (likely a SQL view `customer_profitability` for the heavy join across orders + refund_approvals + service_tickets, since per-customer aggregation in the browser would be slow over thousands of orders).

- **#59** Distinguish team-test units from real customer units everywhere.
  **Source:** Huayi (2026-06-04 in-session note)
  **Description:** Units the team uses for internal testing (currently owned by Huayi, Junaid, Pedrum, George) get mixed in with real customer units in too many surfaces — the Dashboard, Stock tab, Customers tab, ticket attribution, and especially anything that rolls up profitability or warranty cost (e.g. #58). They distort the numbers and pollute the picker dropdowns. Today `units.status` has a `team-test` value but it's used inconsistently — some team units sit in `shipped` with the team member's name in `customer_name` and never get tagged as `team-test`.
  Make the distinction explicit and authoritative:
    1. **Add `units.is_team_test` boolean** (default `false`), distinct from `units.status`. A unit can be `team-test` (status) AND `is_team_test=true`, or it can be `shipped` to a team member AND still `is_team_test=true`. The flag is the source of truth — `status` describes the unit's pipeline stage, the flag describes whether it counts as real-customer activity.
    2. **Seed the flag for the four current team members.** Run a one-time backfill: set `is_team_test=true` on every unit where `customer_name` matches Huayi / Junaid / Pedrum / George (resolved via `customers.full_name` or `profiles.full_name`). New units shipped to those four also auto-flag at the Order Review or Fulfillment assignment step.
    3. **Default-filter team-test units OUT of:** Dashboard sidebar (unless toggled on), Customers tab list, Customer Profitability rollups (#58), Stock warranty/cost reports. They should stay visible in the Stock raw table (operators still need to find them) and in the Dashboard when a "Show team units" toggle is on.
    4. **UI badge.** Wherever a team-test unit IS displayed, show a small "team" pill so the operator immediately knows it's not a real customer signal. Same treatment in Service tickets that reference a team-test unit.
    5. **Future-proofing.** The team list (Huayi/Junaid/Pedrum/George) is not hard-coded into the backfill query — it's resolved against `profiles.is_internal=true` people who happen to be linked to a unit. When the team grows or shrinks, the next backfill picks up the new list automatically.
  **Why it matters:** without this, #58 profitability shows Huayi as our worst customer because he has 4 returns and zero revenue, which is technically true but utterly misleading. Same problem for any KPI tile counting "shipped units" or "warranty cost per customer".
  **Likely touch:** SQL migration adding `units.is_team_test` + backfill; `lib/stock.ts` Unit type + filter helpers; default filter in `Dashboard/index.tsx`, `Customers/index.tsx`, and (when #58 ships) `Customers/ProfitabilityTab.tsx`; new "team" pill style in shared CSS.

- **#60** Dashboard: send a Quo SMS to the customer when their machine shows `DRY_SOIL` (and generalize to other statuses).
  **Source:** Huayi (2026-06-04 in-session note)
  **Description:** The Dashboard already classifies machine status (`OK | DRY_SOIL | SOAKED_SOIL | NEW_FOOD | NOT_MIXING | OPEN_LID | DIAGNOSE` — see `STATUS_DESCRIPTIONS` in `lib/dashboard.ts`). When a unit's status is `DRY_SOIL`, the operator should be able to one-click send a Quo (OpenPhone) SMS to the customer asking how their compost is doing and suggesting they add water. Make this a status-keyed action so we can extend it to the other actionable statuses without re-doing the wiring each time.
  Specifically:
    1. On the Dashboard machine detail panel, when `status='DRY_SOIL'` AND the unit is linked to a customer (via #53/#54 `units.customer_name`) AND the customer has a phone number — show a "Send moisture check SMS" button.
    2. Clicking opens a small modal with a pre-drafted message (editable):
       > "Hi {first_name}, your LILA composter is showing low moisture levels. The contents may benefit from a small amount of water — about ½ cup is usually enough. Let us know if you're seeing anything unusual!"
    3. On confirm, the SMS goes through the existing `send-followup-sms` edge function (same path the Customers → Overdue Follow-ups panel uses, so we reuse the auth wrapper, OpenPhone API key, FOLLOWUP_SMS_TEST_PHONE redirect for QA, and activity log integration).
    4. Log to `activity_log` with action `dashboard_status_sms`, target = serial, detail = `{status}: {message[:60]}…`.
    5. Add a small client-side cooldown: if the same serial already had a `dashboard_status_sms` event for the same status code within the last 48 hours, disable the button and show a "Already messaged $TIME ago" tooltip. Prevents accidental spam if the status flickers.
  **Generalize per-status (not just DRY_SOIL):**
    Each of these statuses gets its own action button + canned template:
    - `DRY_SOIL` → "Send moisture check SMS" (add ½ cup water)
    - `SOAKED_SOIL` → "Send drainage check SMS" (run a dry cycle, check drainage)
    - `OPEN_LID` → "Send lid alert SMS" (please close the lid)
    - `NOT_MIXING` → does NOT auto-message; routes to Service (likely warranty / motor issue, needs operator triage, see #55)
    - `NEW_FOOD` / `OK` → no action (no problem to solve)
    - `DIAGNOSE` → does NOT auto-message; the unit hasn't transmitted, customer SMS doesn't help — operator should call instead.
  Templates editable from the Templates module (so they live alongside the other SMS templates and Pedrum/Reina can tune the copy). Status code → template key mapping is hard-coded in `lib/dashboard.ts`.
  **Likely touch:** `Dashboard/MachineDetail` for the button, new `Dashboard/StatusSmsModal.tsx`, `lib/dashboard.ts` for the status→template mapping + cooldown lookup, reuse `lib/customers.ts sendFollowupSms()` (or generalize it to `lib/sms.ts sendOperationalSms()`), new SMS template rows in `templates` table.

- **#61** Dashboard: label telemetry windows as "smelly" / "no smell" for future ML training data.
  **Source:** Huayi (2026-06-04 in-session note, refined 2026-06-04 with concrete labeling target).
  **Key sensor focus:** the `gas_resistivity` field on `bme_sensors` is the primary signal we want each label paired with. Smell correlates strongly with VOC concentration, and BME688 gas resistance drops as VOCs rise — so a window labeled "smelly" + the matching gas_resistivity time series is the canonical training pair. The exported bundle (step 4 below) MUST include `bme_sensors.gas_resistivity` for the labeled window — humidity/temperature/current can come too, but gas resistivity is the must-have.
  **Operator-confirmed labeling targets (validation snapshot 2026-06-04):**
    - **`smelly`** — Kristen Pimentel (customer_id `44748ce9-d08f-436d-849f-1552f90701f3`, unit `LL01-00000000267`, ticket ST-2026-0248). Sour-smell window in late May / early June; pair the label with `bme_sensors.gas_resistivity` for that period.
    - **`dry`** — Rashida Lee (customer_id `36e4c7a1-361f-4939-ad28-59473fdf93fe`, unit `LL01-00000000217`). She replied to the 2026-06-04 22:11 DRY_SOIL wellness-check SMS confirming the compost is indeed dry — a true positive for the existing classifier and a clean canonical example for the model. Pair the label with `bme_sensors.humidity` (the classifier's primary signal) for the window leading up to the SMS.
  Both serve as the first ground-truth labels in the new `dataset_labels` table once the UI ships.
  **Description:** Customers occasionally report whether their compost smells (via SMS, phone, support ticket, or in-person feedback). Today that feedback evaporates into a ticket comment and never gets paired with the underlying telemetry. We want the operator to take that report and *annotate* the dataset — drawing a time-range box on the Dashboard charts and tagging it. Once we have a few hundred labelled windows, that becomes training data for a smell-detection model (likely a small classifier over BME humidity / temperature / gas resistance / motor current features).
  Specifically:
    1. **New `dataset_labels` table** with columns: `id uuid pk`, `serial_number text` (FK→units.serial), `started_at timestamptz`, `ended_at timestamptz`, `label text` (initially `'smelly' | 'no_smell'`, extensible via check constraint with new values added by migration), `confidence text` (`'customer_reported' | 'operator_inferred'`), `source text` (`'sms' | 'phone' | 'ticket' | 'in_person'`, free-form), `notes text`, `linked_ticket_id uuid` nullable, `labeled_by uuid` FK→profiles, `created_at timestamptz default now()`.
    2. **UI on Dashboard machine detail:** below each chart card add a small "Label this window" affordance. Clicking it lets the operator drag-select a time range on the chart (or pre-fills the currently-visible window) and opens a small modal: label = smelly / no_smell (radio), source = sms / phone / ticket / in_person (dropdown), confidence = customer_reported / operator_inferred (radio, default customer_reported), optional ticket link (search), free-text notes. Confirm → INSERT into `dataset_labels`.
    3. **Visual overlay:** any existing labels for the viewed serial render as faint colored bands on the chart (red tint for smelly, green for no_smell). Hover shows the label metadata. Operator can click → edit / delete (with confirmation). Bands stay visible across chart refreshes so the operator can see at a glance what has and hasn't been labeled.
    4. **Export endpoint:** new edge function `export-dataset-labels` (cron-only initially, can later add a UI button) emits a CSV/Parquet bundle joining `dataset_labels` with the matching `bme_sensors` / `ac_current` / `temperature_sensors` rows in the labeled window. This is the artifact the ML training pipeline consumes. Store the export to a private Supabase bucket so it accumulates over time.
    5. **Auditing.** Every label / edit / delete logs to `activity_log` so we can later spot which operator labelled which windows and how consistent the labeling is.
  Out of scope (defer):
    - Multi-class labels beyond smelly / no_smell (e.g. "too dry", "too wet" — though those overlap with telemetry-derived statuses in #60).
    - In-app model inference / live smell prediction — this feature only *collects* the training data. Building or hosting the model itself is a separate effort.
    - Customer-facing labeling (asking customers to label directly in an app or SMS reply). Operator-mediated for V1.
  **Why now:** the telemetry dataset is growing every day; the longer we wait to start labeling, the more catch-up work the operator has to do for any given window. Even sparse labels (few per week) accrue value if collected consistently.
  **Likely touch:** SQL migration for `dataset_labels` table + RLS gating (internal-only read/write); `lib/dashboard.ts` for `useDatasetLabels(serialNumber)` hook + `createLabel()` / `updateLabel()` mutations; new `Dashboard/LabelOverlay.tsx` for the chart bands; new `Dashboard/LabelModal.tsx` for the form; Plotly drag-to-select integration in `Dashboard/PlotlyChart.tsx` (Plotly already supports `selecteddata` events); new edge function `supabase/functions/export-dataset-labels/index.ts`.

- **#62** Shared `.replBadge` CSS token (deduplicate across modules).
  **Source:** Final code review of #55 (2026-06-04)
  **Description:** During #55 implementation, `.replBadge` ended up defined three times — once each in `OrderReview.module.css`, `Fulfillment.module.css`, `PostShipment.module.css` — with identical values. Extract to a shared styles file (or a Badge component) so the visual stays consistent if the design ever tweaks it. Low priority; cosmetic.

- **#63** Deep-link replacement order / ticket from Service module.
  **Source:** Final code review of #55 (2026-06-04)
  **Description:** Several links in `ReplacementTab.tsx` and `TicketDetailPanel.tsx` (and the modal redirect) use bare `#/order-review` / `#/service` because the existing HashRouter doesn't parse query params after the fragment. Operators must search by ref after navigation. Add proper deep-link support: wire `useNavigate` / `useSearchParams` (or extend the route's component to read a `?order_id=` / `?ticket_id=` query) so the link lands on the specific record's detail panel. Touches: OrderReview's top-level route component to honor an order_id param; Service module's tab router to focus a specific ticket; the link href call sites.

- **#65** OrderReview: decouple freight estimate from customer-paid shipping; reflect the $100 CAD shipping credit policy.
  **Source:** Pedrum (2026-06-04, via Huayi)
  **Description:** VCycene's shipping policy gives every Canadian customer a $100 CAD shipping credit. In practice most CA customers' freight quote is under $100 CAD, so the customer pays $0 for shipping after the credit. Today the system reads the shipping number directly from Shopify (which shows the pre-credit amount) AND uses the same column for both:
    1. **Freight estimate** — the operator-facing field on `FreightCard` (used to flag orders where the actual carrier quote exceeds the customer-paid shipping by enough to matter).
    2. **Shipping actually paid** — the customer-facing line on the Payment Summary card, which should mirror what Shopify charged the customer net of the credit.
  Both currently come from `orders.freight_estimate_usd`. The immediate consequence: when an operator edits the freight estimate (e.g., pastes a ClickShip quote), the Payment Summary's "Shipping" line silently changes too — which is wrong, since the customer's invoice isn't being modified.
  Quick fix (already shipped 2026-06-04): added `orders.customer_paid_shipping_usd` column, populated from the same Shopify shipping value at sync time. `LineItemsCard` reads from this new column; `FreightCard` edits remain on `freight_estimate_usd`. The two values are now independent.
  Remaining work (this backlog item):
    1. Audit how Shopify's `shipping_lines[].price` interacts with the $100 CAD credit. Is the value Shopify returns pre- or post-credit? If pre-credit, we need to subtract the credit (or read a different field that already nets it out) so `customer_paid_shipping_usd` reflects what the customer actually paid.
    2. Surface the credit explicitly on the Payment Summary: line item "Shipping $X", line item "Free-shipping credit −$X up to $100", subtotal "Shipping paid: $Y".
    3. Ties to walkthrough #7 (ClickShip dedup) and #19 (pull freight estimate from ClickShip/Freightcom rather than Shopify). The freight ESTIMATE should source from the carrier (ClickShip or Freightcom), since Shopify totals include the credit + promo distortions; the PAID-SHIPPING column should source from Shopify because that's the financial truth.
  **Likely touch:** `sync-shopify-orders` edge fn — figure out the right Shopify field for post-credit shipping (may require expanding Shopify scopes or reading `total_shipping_price_set` instead of `shipping_lines`); `lib/orders.ts` Order type; `OrderReview/detail/LineItemsCard.tsx` (surface the credit row); possibly a new `lib/shipping.ts` if credit math grows beyond a constant.

- **#64** Unit batch cost lookup for replacement orders (replace `cost_usd: 312` placeholder).
  **Source:** #55 deferred follow-up + final code review (2026-06-04)
  **Description:** `ReplacementPickerModal.addUnit` currently hard-codes `cost_usd: 312` for every replacement-unit line item. This flows into `orders.cogs_usd`, the activity log, and the ReplacementTab KPI strip — all of which now report inaccurate numbers. Replace with a real lookup: join the `units` row's `batch` to `batches.unit_cost_usd` (or whatever column holds the per-unit landed cost) and use that. Touches: `ReplacementPickerModal.tsx` `addUnit` function; verify `batches` exposes the cost field (per `lib/stock.ts` `Batch` type, the field is `unit_cost_usd`). Depends on no schema changes.

- **#66** Dashboard: discovery (wellness-check) SMS for soil/mixing status flags; revises #60 mapping.
  **Source:** Huayi (2026-06-04 in-session notes — first naming NOT_MIXING, then broadening to DRY_SOIL + SOAKED_SOIL).
  **Description:** When a customer's machine shows `NOT_MIXING`, `DRY_SOIL`, or `SOAKED_SOIL` on the Dashboard, send a *non-alarming* SMS asking how their compost is doing and whether the LILA is behaving normally. Different from #60's prescriptive lid alert: the goal is **information-gathering**, not telling the customer their unit needs intervention. Many of these flags turn out to be benign (transient state, sensor blip, customer behavior), and a wellness-check confirms what's actually happening before we escalate to a service ticket or push an instruction the customer doesn't need.
  **Initial target list (NOT_MIXING customers as of 2026-06-04, pulled by Huayi from live Dashboard):**
    1. Michael Romans (`LL01-00000000216`)
    2. Suzan Jackovatz (`LL01-00000000218`)
    3. Amelia Smith (`LL01-00000000236` — actually `Amila & Rob Smith` in `customers`)
    4. Kristen Pimentel (`LL01-00000000267`)
  (The same wellness-check template applies to the DRY_SOIL / SOAKED_SOIL cohorts on subsequent days — pull the current list from the Dashboard at send time, not from this snapshot.)
  Tone (operator can edit before send):
    > "Hi {first_name} — quick check-in on your LILA composter! We're seeing some unusual signals in the data and wanted to make sure things are still looking good on your end. How's the compost coming along? Any noises, smells, or anything that doesn't seem right? Reply here and we'll dig in."
  **Supersedes the status→template mapping originally proposed in #60.** Most actionable statuses now use the discovery template, not the prescriptive one. Rationale: telling a customer "add water" when the sensor blipped (or they're in a transient state) creates an annoying false-positive. "How's it going?" is the safer default — operators stay in the loop and can decide whether to follow up with prescriptive guidance based on the customer's reply. The mapping (2026-06-04 final):
    - `DRY_SOIL` → "Send wellness-check SMS" (open-ended discovery)
    - `SOAKED_SOIL` → "Send wellness-check SMS" (open-ended discovery)
    - `NOT_MIXING` → "Send wellness-check SMS" (open-ended discovery)
    - `OPEN_LID` → "Send lid alert SMS" (please close the lid — **only remaining prescriptive case**, since this is unambiguous and immediately actionable)
    - `NEW_FOOD` / `OK` → no action
    - `DIAGNOSE` → no SMS (operator should call)
  Reuses #60's machinery (template in Templates module, `send-followup-sms` edge fn, activity log entry, 48h cooldown). Replies route back via Quo and land as a ticket in the Service Inbox.
  **Likely touch:** see #60 — same surface. Add a fourth template + status mapping. **Ship #66 together with #60** rather than as a separate effort; it's just one more entry in the status→template table.

- **#68** `orders.customer_id` FK + Shopify-sync resolver (mirror #67 on the orders side).
  **Source:** #67 follow-up surfaced 2026-06-04 — `customer_profitability` view (#58) still joins orders↔customers via fuzzy email/name match because Shopify-imported orders don't carry a `customer_id`. Same class of false-positive risk that #67 fixed for units.
  **Description:** Add `orders.customer_id uuid REFERENCES customers(id) ON DELETE SET NULL`. Backfill by running the same exact + token cascade we now have in `resolve_customer_id_from_name()` (already exposed as a Postgres function), but matching on the order's `customer_email` first (more reliable than name on the orders side), falling back to name. Update `sync-shopify-orders` to set `customer_id` at INSERT/refresh time using the same resolver. Migrate the profitability view's `order_match` CTE to prefer the FK and fall back to email/name only when null. Once readers are migrated, drop or strictly-cache `orders.customer_name`/`customer_email`.

- **#76** Activity Log KPI panel: tiles all read zero — re-pick tile types to match the action-type strings actually being written + fix "today" timezone.
  **Source:** Huayi (2026-06-04, observed after #56 V2 shipped — the new 5-tile / 3-card layout renders but most tiles show 0 even though operators have been working).
  **Why:** The KPI aggregator in `app/src/modules/ActivityLog/KpiPanel.tsx` counts a *specific* list of action types per tile (e.g. `order_shipped` → "Orders shipped", `refund_finance_approved` → "Refunds approved", `released_to_fulfillment` → "Released to FQ"). Ground-truth from `activity_log` over the last 7 days at observation time shows almost none of those types are present — the high-volume ops actions are completely different:
    | Action type written | 7-day count | Counted by V2 panel? |
    |---|---|---|
    | `unit_test_report` | 45 | ❌ |
    | `address_verified` | 22 | ❌ |
    | `ticket_status_changed` | 20 | partial (only when detail matches "closed"/"resolved") |
    | `auto_followup_sent` | 9 | ❌ |
    | `dashboard_status_sms` | 9 | ❌ |
    | `stock_status` / `stock_edit` | 10 combined | ❌ |
    | `gmail_sync_manual` | 4 | ❌ |
    | `ticket_created` | 2 | ✅ |
    | `replacement_create` | 1 | ✅ |
    | `fq_test_ok` | 1 | ✅ |
    | `order_shipped` / `order_delivered` / `refund_finance_approved` / `released_to_fulfillment` | **0 each** | ✅ (but no data) |
  Secondary bug: the "today" bucket uses `date_trunc('day', now() at time zone 'UTC')` semantics in the client aggregator. At observation time (~23:03 UTC = ~19:03 ET on the same calendar day), no entry had landed in "today" because the UTC day rolls over while operators are still working ET hours. Operators see "Total entries: 0" until ~5am ET the next morning.
  No data backfill is needed — every operator action of the last few weeks IS in `activity_log`. The fix is purely picking the right action types per tile + using the right TZ for "today".
  **Description / acceptance:**
    1. **Re-pick the tile types** to favor what operators actually do. Suggested mapping (operator-tunable later):
       - Today: Total entries · QC reports filed (`unit_test_report`) · Addresses verified (`address_verified`) · Status SMS sent (`dashboard_status_sms`) · Tickets resolved (`ticket_status_changed` detail ~ resolved/closed)
       - Fulfillment 7d: QC reports (`unit_test_report`) · Tests passed (`fq_test_ok`) · Stock status flips (`stock_status`)
       - Customer ops 7d: Addresses verified (`address_verified`) · Auto-followup SMSes (`auto_followup_sent`) · Tickets created (`ticket_created`) — keep replacements + refunds in a secondary view so they don't render as flat zero when they happen monthly.
    2. **Timezone fix.** Use `America/Toronto` (or the user's profile-stored timezone if we add it) for the "today" bucket boundary so it matches when operators are working. The KpiPanel aggregator currently runs `startOfToday.setHours(0, 0, 0, 0)` which uses the browser's local time — so this might already be fine in practice; the bug surfaces if the server-side aggregator we add later runs in UTC. Add a regression test pinning the expected start-of-day for an ET-based operator at 8pm ET.
    3. **"By module" histogram already works** — it groups by the type-prefix table in `KpiPanel.tsx`. No change needed but should be sanity-checked once the tile changes ship.
    4. **Stretch:** a small "what's logged" debug surface in the empty-state of each card ("0 in last 7d — expected types: foo, bar") so the next time we evolve action-type strings, the gap is obvious immediately instead of three weeks later.
  **Why not just write more action types?** That's a separate, larger task (sweep every mutation in `lib/` to ensure it logs to `activity_log`). For now, accept that operator-action coverage is partial and at least surface what IS being logged.
  **Likely touch:** `app/src/modules/ActivityLog/KpiPanel.tsx` (compute(), tile labels), `lib/activityLog.ts` (no change unless we add a server-side aggregate RPC). Add a focused unit test that feeds synthetic `ActivityLogEntry[]` representative of the real ground-truth above and asserts the tiles non-zero.

- **#75** Diagnosis-call booking link on customer tickets + auto-invite Reina/Junaid to the resulting call. — **SHIPPED** (2026-06-04; pivoted from Google Appointment Schedule to Calendly later same day). `lib/cannedSms.ts` exports `DIAGNOSIS_CALL_BOOKING_URL = 'https://calendly.com/lila-ed/lila-diagnosis-chat'` + `diagnosis_call_request` template; "Send diagnosis link" button on `Service/TicketDetailPanel` opens a confirm modal with the canned body, sends via existing `sendFollowupSms` SMS path, stamps `service_tickets.diagnosis_link_sent_at`. **Cron-fanout** is now folded into the existing `sync-calendly-events` cron — it classifies events by Calendly event-type name (substring match against `DIAGNOSIS_EVENT_NAME_MATCH`, default `diagnosis`), and for matching events PATCHes the Calendly-created event on Huayi's Google Calendar to add the `DIAGNOSIS_COHOST_EMAILS` co-hosts (Reina + Junaid), dedupe via `service_tickets.diag_cohost_invited_at`. Weekend skip from #44 applies (defensive — the Calendly schedule itself is M-F).
  **Pivot note (2026-06-04 same day):** initially shipped as a separate `sync-google-appointments` edge fn polling Huayi's Google Calendar Appointment Schedule. Hit Google's hard cap of 1 invitee per appointment slot, but the diagnosis call needs 2 co-hosts. Switched to a Calendly "Group event" (2 invitees per slot, M-F 1pm-5pm ET, 15min). The `sync-google-appointments` function + cron + the supporting code were retired (source deleted; orphaned deployment in Supabase Functions can be removed manually anytime).
  **Source:** Huayi (2026-06-04 in-session note, follow-up to #44 once that auto-invite pattern was established)
  **Description:** Two coupled pieces — a customer-facing booking flow and the internal co-host auto-invite that runs once the customer books.
    1. **"Send diagnosis call link" action on a service ticket.** Add a button on the ticket detail panel (in `app/src/modules/Service/TicketDetailPanel.tsx`) that sends the customer Huayi's diagnosis-call Calendly/Google booking link: `https://calendar.app.google/fB7amKsS8ekase689`. Channel chosen by the operator (email or SMS), prefilled with a canned template (e.g., "Hi {first_name} — let's get on a quick diagnosis call so we can dig into what's happening with your LILA. Book a time here: <link>. Talk soon — VCycene support."). The link itself lives in `lib/cannedSms.ts` (alongside `TRUSTPILOT_REVIEW_URL` from #72) so it's never typo'd. After send, stamp the ticket with `diagnosis_link_sent_at` for dedupe + audit. Log to `activity_log` as `diagnosis_link_sent`.
    2. **Auto-invite Reina + Junaid when the customer books.** When the diagnosis call lands on Huayi's Google Calendar (the calendar behind `calendar.app.google/fB7amKsS8ekase689`), the same `sync-calendly-events` / Google Calendar polling path that #44 shipped should detect new diagnosis-call events and fire calendar invites to both Reina and Junaid as co-hosts. Detection: events whose `summary` matches the diagnosis-call event type (Calendly event-type URI or Google appointment-schedule name — needs verification against the actual booking link's event type). Dedupe via a new column `service_tickets.diag_cohost_invited_at` (or reuse the existing `reina_invited_at` if we extend it to a JSON or a separate `cohort_invites` table — design decision when implementing).
  **Env:** add `DIAGNOSIS_COHOST_EMAILS` (comma-separated: `reina@virgohome.io,junaid@virgohome.io`). Reuse `CALENDAR_INVITER_MAILBOX` + service-account delegation from #44. Soft no-op when not configured.
  **Why now:** Customer diagnosis calls are the bottleneck whenever a unit is flagged for hardware investigation — today Huayi sends the booking link by hand from chat, and Reina/Junaid get pulled in only if Huayi remembers to forward the calendar event. This automates both steps so any operator can dispatch a diagnosis call and the engineering co-hosts always show up.
  **Likely touch:**
    - `lib/cannedSms.ts` — add `DIAGNOSIS_CALL_BOOKING_URL` constant + new canned template `diagnosis_call_request`.
    - `Service/TicketDetailPanel.tsx` — "Send diagnosis call link" button next to the existing "Send replacement" action; channel toggle (email/SMS) similar to existing template-send UX.
    - Migration: `service_tickets.diagnosis_link_sent_at TIMESTAMPTZ` + `service_tickets.diag_cohost_invited_at TIMESTAMPTZ`.
    - `sync-calendly-events/index.ts` — extend the #44 invite path: if the event summary matches the diagnosis-call event type AND `diag_cohost_invited_at` is null AND event is in the future, invite all addresses from `DIAGNOSIS_COHOST_EMAILS` (and stamp the timestamp). May require classifying events by their Calendly event-type URI rather than parsing summary text; needs a probe call to confirm what `name` the diagnosis booking events come back with.
    - Activity log: `diagnosis_link_sent`, `diagnosis_cohosts_invited` action types.

- **#74** Verify the diagnosis-call booking link's event-type before wiring #75's auto-invite. — **SHIPPED + OBSOLETED** (2026-06-04: the original probe targeted Google Appointment Schedule event JSON; that path was retired same-day for Calendly, where the event-type name is the obvious discriminator. Surviving knob: `DIAGNOSIS_EVENT_NAME_MATCH` substring on the Calendly event-type `name` field, default `diagnosis` matches `LILA Diagnosis Chat`).
  **Source:** 2026-06-04 — split off from #75 because the detection logic depends on how Google appointment-schedule bookings vs. Calendly bookings differ in the `scheduled_events` API response.
  **Description:** The booking link `https://calendar.app.google/fB7amKsS8ekase689` is a Google Calendar Appointment Schedule, not a Calendly event. Today `sync-calendly-events` only polls the Calendly API. To detect when a customer books a diagnosis call through the Google link, we need to either:
    1. **Add a parallel Google Calendar poll** — list events on Huayi's primary calendar via the Calendar API (same service-account-with-delegation pattern as #44's invite path), filter for events whose `eventType='workingLocation'` or `appointmentSchedule` extended properties match the diagnosis-call schedule, and upsert them as `service_tickets` with `category='diagnosis_call'`. This is the right architectural move long-term but doubles the polling surface area.
    2. **Add a webhook** — Google Calendar push notifications (`channel.watch`) would notify us on new events without polling. More complex setup (renewal cron, public webhook endpoint, signed payload verification) but eliminates the polling.
  Recommended: option 1 for V1 (mirrors the Calendly pattern; one more cron job; estimated 1-2 days of work), option 2 as a follow-up if polling latency becomes a problem.
  Prereq: probe what the booking events actually look like in the Calendar API (run a `events.list` against Huayi's calendar after manually booking one to inspect the schema). Document the discriminator (eventType, extendedProperties.appointmentSchedule, or summary prefix) so #75 can rely on it.
  **Likely touch:** new edge function `supabase/functions/sync-google-appointments/index.ts` (or extend `sync-calendly-events` and rename it `sync-meetings`). Migration for any new appointment-distinct columns on `service_tickets`. Documentation of the discriminator field in `docs/`.

- **#73** Dashboard classifier — residual work after #70 V1.
  **Source:** Captured 2026-06-04 after shipping #70 V1 (BME humidity cross-check that suppresses NOT_MIXING when the chamber is being actively turned over).
  **What's still open:**
    1. **Apply the same skeptical pattern to other status classifiers.** DRY_SOIL fired 1-of-1 correctly today (Rashida Lee), but the same single-sensor brittleness exists for SOAKED_SOIL, NEW_FOOD, and the lid-open check. Each should have a cross-check against a complementary signal (e.g. SOAKED_SOIL vs. temperature + gas resistivity; NEW_FOOD vs. weight if/when we add load cells).
    2. **Per-unit current-sensor drift QC** (#70 path 2). For units whose `chamber_motor_left/right` reads near-zero for extended periods despite humidity activity, flag the SENSOR — not the chamber — as suspect. Surface this on the Stock unit detail panel as a `defect_reason` candidate (current sensor calibration issue). A weekly batch job that scans units and writes a soft "sensor drift suspected" note is enough for V1.
    3. **Add a `SENSOR_DIAGNOSE` machine status** so the dashboard can distinguish "I can't trust this signal" from "the unit is OK". Today the suppression-by-cross-check is invisible to the operator — the unit shows as one of the BME-derived statuses (OK / DRY_SOIL / etc.) with no indication that NOT_MIXING was almost flagged. A diagnostic chip would help.
    4. **Classifier-validation tracking** infrastructure (loops back into #61's `dataset_labels` table). For every wellness-check / status SMS we send, record the resulting customer-confirmed outcome (true positive / false positive / unconfirmed) so we can compute per-classifier accuracy and watch the regressions as we tune thresholds. The validation log section in #70 is the spec source.
    5. **Per-unit threshold tuning** for `NOT_MIXING_CURRENT_THRESHOLD` (#70 path 3). Once we have per-unit history, calibrate the threshold against each unit's baseline current rather than the global 0.05 A floor.
  **Why deferred to follow-up:** #70 V1 fixes the most visible problem (NOT_MIXING false positives flooding wellness-check SMS) without paying for the bigger investment. The rest can ship incrementally as the operator team collects more validation data.

- **#72** Centralize Trustpilot review link + canned SMS / email templates in one source of truth.
  **Source:** Surfaced 2026-06-04 — an SMS to Michael Romans went out with `trustpilot.com/review/vcycene.com` (a guessed URL). The actual link is `trustpilot.com/review/lilacomposter.com`. Operator had to send a correction SMS. Today there's no central place where the review URL lives; each operator typing a customer-facing message has to remember the right link.
  **Description:** Build a `templates` table (or extend an existing config table) holding:
    - **External URLs:** Trustpilot review (`https://www.trustpilot.com/review/lilacomposter.com`), Google review link, support email signature URL, etc.
    - **Canned message bodies:** wellness-check (already inline in `lib/dashboard.ts STATUS_SMS_TEMPLATES`), lid alert, review-request SMS, defective-unit acknowledgment, etc. — all parameterized on `{first_name}`, `{order_ref}`, etc.
  Surface in two places:
    1. **Backing the existing inline templates** in `lib/dashboard.ts` so operators can edit copy without code deploys.
    2. **The `StatusSmsModal` "Send template" picker** — let the operator pick from any template (not just the status-keyed one) when sending a one-off message from the Dashboard. Same for the Quo reply UI in Service tickets.
  This also resolves the Quo-reply-via-template gap in #3 / #12 (the existing Templates module was scoped to Order Review email templates only).
  **Likely touch:** new `templates` table migration; `lib/templates.ts` extension with non-tab-specific templates; `Dashboard/StatusSmsModal.tsx` to pull templates from the DB instead of `STATUS_SMS_TEMPLATES`; future Templates-module UI for ops to edit.

- **#71** Replacement orders: first-class "awaiting inbound batch" state + visible queue.
  **Source:** Surfaced 2026-06-04 — Kristen Pimentel's cracked-shell replacement (R-0001) needs a P100X unit, but no P100X units are `ready` yet (batch is in production in China, expected end of July). Today the only signal is `orders.line_items = []` + `cogs_usd = null` on a `status='pending'` row, plus a free-text note in `batches.notes`. Operators have no list view of "what's waiting on which batch", and customers get vague "we'll queue it" replies.
  **Description:**
    1. Add an explicit signal to `orders` — either a new status enum value `awaiting_inventory`, or a `awaiting_batch_id` text/FK column referencing `batches.id`. The latter is more informative (lets the UI render "Awaiting P100X · expected late July" without a join).
    2. In the Replacement tab (Service module), add a filter chip / section "Awaiting batch" that groups these orders by `awaiting_batch_id` and shows each batch's expected `arrived_at` / notes.
    3. When a batch's units actually become `ready` (the batch flips its `arrived_at` and units get bulk-flipped from `inbound` → `ready`), surface a "promote to fulfillment" sweep that lets the operator pick which queued order gets which unit, then assigns and flips order status to `pending` for full fulfillment review.
    4. **Customer-facing knock-on:** the Service ticket detail panel (and any auto-reply machinery) should pull the batch ETA so the operator's reply doesn't have to copy-paste the expected date manually.
  **Why now:** the Replacement workflow (#55) shipped today already routes everything through `orders.status='pending'`. Without a way to distinguish "ready to ship" from "waiting on inventory", the Fulfillment queue treats batch-blocked orders the same as actionable orders — and operators have to keep mental track of which is which.
  **Likely touch:** SQL migration adding the column / enum value; `ReplacementTab.tsx` filter chip + grouping; `Service/TicketDetailPanel.tsx` to surface the batch ETA when the linked replacement order is awaiting one; touch `lib/orders.ts` Order type.

- **#70** Dashboard classifier: `NOT_MIXING` false-positive when motor works but current doesn't peak.
  **Source:** Huayi (2026-06-04) — surfaced via replies to the wellness-check SMS sent to the four NOT_MIXING customers:
    - **Michael Romans** (`LL01-00000000216`) — unit running normally, producing good compost (minor smell when meat goes in).
    - **Suzan Jackovatz** (`LL01-00000000218`) — compost is mixing well, no issue. Confirmed false positive.
    - **Kristen Pimentel** (`LL01-00000000267`) — also clearly mixing fine (her separate complaint is a cracked main body, not the motor).
  **Three of four** flagged customers confirm the motors are mechanically operating — a 75% false-positive rate at the current threshold.

  **Cross-classifier validation log (today's wellness-check campaign):** for tracking ground truth from operator-customer conversation:
    - `DRY_SOIL` → Rashida Lee (`LL01-00000000217`) — **TRUE positive** confirmed 2026-06-04 (operator told her to add water).
    - `NOT_MIXING` → Michael Romans (`LL01-00000000216`) — false positive (motor works).
    - `NOT_MIXING` → Suzan Jackovatz (`LL01-00000000218`) — false positive (motor works).
    - `NOT_MIXING` → Kristen Pimentel (`LL01-00000000267`) — false positive on the motor flag (motor works) but a true positive on the unrelated `smelly` signal she reported.
    - `NOT_MIXING` → Amila & Rob Smith (`LL01-00000000236`) — unconfirmed (no reply yet).
  This snapshot is the raw input for #61's `dataset_labels` table when the labeling UI ships. The classifier triggered because `chamber_motor_left` / `chamber_motor_right` current readings never crossed `NOT_MIXING_CURRENT_THRESHOLD` (0.05 A) over the lookback window — yet the motors are mechanically operating.
  **Description:** Today `isNotMixing()` in `app/src/lib/dashboard.ts` only consults AC current readings (`liveData[RecordType.Current]`). If the **current sensor itself** drifts low or fails calibration, the classifier reports `NOT_MIXING` regardless of whether the motor is actually turning. This produces alarming UX (wellness SMS asking what's wrong) for customers whose unit is fine, and erodes operator trust in the classifier.
  **Fix paths to investigate (likely all three, in priority order):**
    1. **Cross-check against another mechanical signal before classifying NOT_MIXING.** Candidates: BME humidity/temperature variance (a stirring chamber shows oscillation if the food is being mixed), chamber temperature stability, lid/microswitch events. If the secondary signal contradicts the zero-current reading, downgrade to a softer "diagnose current sensor" status instead of "not mixing".
    2. **Investigate / characterize the current-sensor drift on Michael's specific unit** (LL01-???). Pull 48h+ of `ac_current` readings; compare with similar-batch units. If the sensor reads near-zero when the motor is provably running, this is a hardware QC issue worth flagging in the unit's defect_notes and (longer-term) into a Stock module health report.
    3. **Loosen the `NOT_MIXING_CURRENT_THRESHOLD` or `NOT_MIXING_LOOKBACK_HOURS` constants**, or move them per-unit-calibrated. The current 0.05 A / 48h thresholds assume sensor accuracy that may not hold across batches.
  **Out of scope (for now):** rebuilding the classifier as an ML model. This is a deterministic-rules tweak, not a model-training effort.
  **Likely touch:** `lib/dashboard.ts` `isNotMixing()` (add the secondary-signal check + soft fallback status), `classifyMachineStatus()` (route the new status); possibly a new `'SENSOR_DIAGNOSE'` MachineStatus to surface the difference between "machine broken" and "sensor unreliable".

- **#69** Sweep the ~47 still-orphaned `units.customer_name` values (no matching customer record).
  **Source:** #67 backfill leftover. The original backfill + parenthetical-strip pass linked 132/181 customer-assigned units; the rest are mostly customers that exist in Shopify or HubSpot but were never imported into the makelila `customers` table.
  **Description:** Operator-driven cleanup: present an "Unlinked units" view that shows each orphan with its customer_name and a "Find or create customer" picker. Let the operator either link to an existing customer (via the same search the Replacement picker uses) or create a new customer record from the unit's known data. Updates `units.customer_id` and any other refs. Lower-priority than #68 since #67 V1 + the auto-resolve trigger already fix forward; this is just historical cleanup.

- **#67** Canonicalize the units → customers link (replace free-text `units.customer_name` with a proper FK).
  **Source:** Surfaced during #60/#66 SMS send — operator hit "no customer linked" for unit LL01-00000000236 because `units.customer_name = "Amila Smith"` while the canonical customer record is `"Amila & Rob Smith"` (joint account). Patched 2026-06-04 with a tolerant last-name + first-name-starts-with cascade in `customerForSerial()`, but the underlying schema is the actual bug.
  **Description:** Today `units.customer_name` is a free-text column populated at fulfillment time. The corresponding `customers.full_name` may differ (spouse appended, nickname vs. legal, typos, Shopify-imported vs. HubSpot-imported representation). Every cross-module lookup that wants "the customer record for this unit" has to do fuzzy resolution. This will keep biting us as more features (#58 profitability rollups, #60/#66 status SMS, #54 Dashboard click-to-assign, etc.) cross from units → customers.
  Fix path:
    1. **Add `units.customer_id uuid REFERENCES customers(id) ON DELETE SET NULL`** as the new authoritative link. Index it.
    2. **Backfill** by running the existing fuzzy resolver against every shipped unit. Cases where the resolver returns >1 candidate get flagged for manual operator review (rather than silently picking wrong).
    3. **Update the fulfillment serial-assignment flow** so it sets `customer_id` from the picked customer's ID (Order Review already has the customer in scope when the operator approves) rather than copying the name string. Keep `customer_name` as a denormalized display cache for now to avoid breaking everything that reads it.
    4. **Migrate readers one module at a time** to prefer `customer_id` lookups over name resolution. The tolerant cascade in `customerForSerial()` becomes the legacy code path that only kicks in when `customer_id IS NULL`.
    5. Once every reader is on `customer_id`, drop the free-text column (or keep it as a one-way denormalized cache and stop relying on it for joins).
  **Why now:** the longer we wait, the more code paths get written against the fuzzy join. Doing the FK + backfill now is a small migration; redoing five tabs later is a bigger one.
  **Likely touch:** SQL migration (column + FK + backfill); `lib/stock.ts` Unit type; `lib/dashboard.ts` `customerForSerial` to prefer `customer_id`; `Fulfillment/queue/StepAssign.tsx` (or wherever assignment writes the unit) to populate the FK; reviews of every `units.customer_name` reader for migration.

## Reference

- Email thread: "makeLILA app beta release, VCycene, Huayi" (started Apr 21, 2026)
- Demo video: [Google Drive link](https://drive.google.com/file/d/1Mqx-wjIzedkeNfkR-0c-nDJw_lrAeWPP/view?usp=sharing)
- Fireflies recap: [makeLILA beta demo v1](https://app.fireflies.ai/view/makeLILA-beta-demo-v1-mp4::01KPVHNYP2K58QRFFVQ2R1FZYT)
- Return checklist reference: Google Sheet "VCycene_Return_Checklist" (per George)
