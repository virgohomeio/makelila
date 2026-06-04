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

- **#13** Verify-address: returns "Could not verify" too often. Google Maps Geocoding is unreliable on Canadian rural addresses. Investigate an LLM-backed verifier (Claude) as a fallback or replacement. *Follow-up to shipped #1.*
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

- **#31** Onboarding tab: split into "needs onboarding — not yet scheduled" vs. "onboarding scheduled" sections so Reina can see who to chase.
- **#32** Calendly sync delay. Reina scheduled an onboarding session with Huayi (using Pedrum's test profile) and Pedrum accepted it, but the booking didn't appear in makeLILA promptly. Tighten the sync cadence or webhook.
- **#33** Onboarding detail panel currently reuses the ticket layout. Needs an onboarding-specific view with a "Mark complete" button instead of ticket fields.
- **#34** Customer picker for new tickets didn't surface Pedrum's secondary profile (`pedruma71@gmail.com`). That profile is also missing from the Customers tab. Customer-sync gap.
- **#35** *(Note for later — strategic.)* If we rule HubSpot out as a customer source, we'll need a robust Shopify → customer sync. Today there's a rare Shopify import path that fails to create the customer profile on order arrival. *Ties to #8 system-of-record decision.*
- **#36** "Create support ticket" form: once a customer is selected, auto-populate their unit serial number(s).
- **#37** Ticket status labels need refresh — action-oriented terms like "Complete", "Needs to reach out", etc.
- **#38** Add a Category field on tickets so we can report issue volume per area (electrical, mechanical, onboarding, billing, etc.).
- **#39** Owner-email list is stale: Aaron and Ashwini still appear (both left); Reina is missing.
- **#40** Follow-up calendar based on onboarding date — auto-schedule 1-week / 1-month check-ins after onboarding completes.
- **#41** Define the support-ticket → Repair tab pipeline. Today it's ambiguous how a defect-flagged ticket moves into the repair queue.
- **#42** Customers tab: data sync is incomplete — fields missing on some customers. Likely linked to #34.
- **#43** Add unit serial number to the customer profile card in the Customers tab (currently you have to cross-reference Stock).
- **#44** Auto-invite Reina to every customer onboarding call when it is scheduled in Calendly.

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
  **Source:** Huayi (2026-06-04 in-session note)
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

---

## Reference

- Email thread: "makeLILA app beta release, VCycene, Huayi" (started Apr 21, 2026)
- Demo video: [Google Drive link](https://drive.google.com/file/d/1Mqx-wjIzedkeNfkR-0c-nDJw_lrAeWPP/view?usp=sharing)
- Fireflies recap: [makeLILA beta demo v1](https://app.fireflies.ai/view/makeLILA-beta-demo-v1-mp4::01KPVHNYP2K58QRFFVQ2R1FZYT)
- Return checklist reference: Google Sheet "VCycene_Return_Checklist" (per George)
