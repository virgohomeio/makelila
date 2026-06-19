# makeLILA Feature Backlog — Alpha Feedback

> Compiled from the "makeLILA app beta release" email thread (Apr 21 – May 26, 2026)
> 
> Contributors: Pedrum Amin, George Yin, Junaid Siddiqui
> 
> Status: Raymond Zhu feedback still pending (due by May 28 fulfillment day)

---

## New capabilities shipped (not from alpha feedback — full log for reference)

| Date | Feature | Commits |
|------|---------|---------|
| 2026-06-07 | **RBAC** — `profiles.role` enum, `canDo`/`canView` helpers, `is_finance`/`is_manager` RLS, replaced MANAGER/FINANCE email allow-lists | `6cf6f1e` `7c6cf77` `5d10e5f` `6ed2660` |
| 2026-06-07 | **activity_log entity refs** — `entity_type`/`entity_id`/`unit_serial` columns + indexes; `useActivityForEntity()` hook; entity refs at unit/return/ticket call-sites | `8d7f630` `e08fc1e` `7326f64` |
| 2026-06-07 | **Mobile V1 + V2** — viewport-fit, PWA manifest, safe-area insets, bottom tab bar; MobileHome card-drilldown per module | `2ebe867` `24d968d` `4ab795d` `3db2b3b` `acb3181` `910c529` |
| 2026-06-07 | **lilalovely integration V1** — customer-events substrate (makelila side); lovely-side triggers deployed end-to-end | `622c40c` |
| 2026-06-10 | **Marketing module** — Facebook ads sync + CAPI, Klaviyo track + profile sync, CAC dashboard, attribution chips on Customers, HubSpot insert-only, System of Record card | `69d4865`–`ec2535c` (13 commits) |
| 2026-06-10 | **Junaid J1–J7** — warranty_registrations (J1), units.status quarantine (J2), UnitTimeline per-serial (J3), DeviceContextHeader (J4), SLA aging + auto-escalation (J5), telemetry-driven ticket auto-create (J6), build_station_passes QC dashboard (J7) | `37ac060`–`a72c83e` (11 commits) |
| 2026-06-10 | **Freight quotes** — `freight_quotes` table + quote history table in FreightCard; carrier chip on OrderRow | `14a6ae7` `9798547` `baf1109` `a0de9aa` |
| 2026-06-10 | **Shopify PaymentCard** — subtotal/tax/shipping/discounts/total/method on OrderReview detail | `6e47f59` `c76ee41` |
| 2026-06-11 | **Finance module F5–F7** — QBO journal automation, ProductionProjectionPanel, SalesProjectionPanel; 3-layer enforcement (nav-hide + RequireRole + RLS) | `055723a`–`c5fc9a5` (10 commits) |
| 2026-06-11 | **Module restructure** — Team module (first tab: member cards), Fleet tab absorbed into Customers, Manufacturing tab absorbed into Stock, PostShipment absorbed into Fulfillment, nav reorder | `818b78d` `e699960` `bababa4` `173393a` `07c548f` |
| 2026-06-11 | **Claude classifier** — Sonnet-powered `reclassify-ticket` edge fn; auto-assigns `status`/`issue_area`/`root_cause`; fetches live Quo SMS for context | `e90630e` `e5de4b3` |

---

## P1 — High Priority (multiple requestors or CEO-mandated)

### 1. Google Maps Address Verification
**Source:** Pedrum (Apr 29 + May 26)
**Description:** Auto-check customer addresses against Google Maps API on order sync. Detect postal/ZIP mismatches between what the customer entered and what Google Maps returns. Trigger automated email asking the customer to confirm the correct version.
**Flow:** Order synced → address validated → mismatch detected → email sent to customer with both versions → customer confirms → address updated in makeLILA + Shopify.

### 2. Returns & Refunds Module (move from Google Sheets to makeLILA) — **SHIPPED** (2026-06-08)
**Source:** Pedrum (Apr 29), George (May 24)
**Description:** Full returns workflow inside makeLILA, replacing the current Google Sheets process.

**SHIPPED status (2026-06-08):** The module (`lib/postShipment.ts` + `PostShipment/` tabs) implements the full spec — `return_category` 6-value dropdown, Returns & Refund Dashboard (`DashboardTab`), dual sign-off finance review (`submitted → manager_review (George) → finance_review (Julie) → refunded`, RBAC-gated via `lib/permissions.ts`), `refund_method` selection (shopify/sezzle/quickbooks_cc/bank_etransfer/original_card), partial-refund amount correction with required note (`financeApprove`), the "no refund before unit received" guard, and cancellations. Two remaining spec gaps were closed on branch `feat/postshipment-returns-gaps`: (a) the dashboard's **Responsible Team** chart (derived from `return_category` via `returnTeamCounts()`), and (b) the finance modal's "non-refundable shipping" hint now reads `customer_paid_shipping_usd` (customer's actual payment) instead of `freight_estimate_usd`, per #65. Open follow-on: **#79** (net out recoverable value of returned units) — separate item.

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

### 4. Shopify Order/Payment Summary Sync — **SHIPPED** (2026-06-10)
**Source:** Pedrum (May 26)
**SHIPPED status (2026-06-10):** `PaymentCard.tsx` added to OrderReview detail panel between LineItems and Notes; shows subtotal, tax, shipping, discounts, total, and payment method sourced from Shopify — `6e47f59` / `c76ee41`. Currency-per-line (#20) still pending.
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

### 9. Klaviyo Integration for Email Automation — **SHIPPED** (2026-06-10, core infrastructure)
**Source:** Huayi (May 26, in reply to Pedrum)
**SHIPPED status (2026-06-10):** `klaviyo-track` edge function (`0f7ee31`), `sync-klaviyo-profiles` bulk-upsert cron (`e447903`), `klaviyo_sync_log` table + daily pg_cron (`2204ee4`), `klaviyo_profile_id` on customers (`a9de1f9`), `logAction()` Klaviyo fire-and-forget at 6 lifecycle call-sites (`c6d0dec`). Remaining: using Klaviyo to drive outbound email flows — drip emails (#88), win-back (#89), Templates module integration (#3).
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

- **#56** Activity Log: identify the actor on every entry + add a right-side KPI panel. — **SHIPPED** (entity refs 2026-06-07; KPI panel 2026-06-04 via #76)
  **Source:** Huayi (2026-06-04 in-session note)
  **SHIPPED status:** `activity_log` columns `entity_type`, `entity_id`, `unit_serial` + composite indexes (`8d7f630` 2026-06-07); `logAction()` signature extended with optional entity opts + `useActivityForEntity()` hook (`e08fc1e`); entity refs wired at unit/return/ticket call-sites (`7326f64`). KPI panel re-mapped to real action types + timezone fix shipped 2026-06-04 (see #76). Activity Log tab now lives inside the Team module (`818b78d` 2026-06-11).
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

- **#58** Customers: per-customer profitability tab with filter/search + insights. — **SHIPPED** (V4 as of 2026-06-05)
  **Source:** Huayi (2026-06-04 in-session note, mid-brainstorming for #55)
  **SHIPPED status (V1–V4 2026-06-04–05):** `ProfitabilityTab.tsx` with per-customer cards — lifetime revenue, COGS, shipping, warranty cost, refunds issued, net margin, counts (orders / replacements / returns / tickets). `customer_profitability` SQL view. Insights panel (CA/US avg margin + high-warranty-cost cohort). 4-bucket cost model (COGS + shipping + expected warranty + expected refunds) — `56d2d1f`. Shipping backfill + tax split out of revenue — `e5db157`. Filter/sort (Most profitable / Losing money / country / cohort). Remaining: #79 (net out returned-unit recovered value for V5); #59 (exclude team-test units from rollups).
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

- **#68** `orders.customer_id` FK + Shopify-sync resolver (mirror #67 on the orders side). — **SHIPPED** (2026-06-04)
  **Source:** #67 follow-up surfaced 2026-06-04 — `customer_profitability` view (#58) still joins orders↔customers via fuzzy email/name match because Shopify-imported orders don't carry a `customer_id`. Same class of false-positive risk that #67 fixed for units.
  **SHIPPED status (2026-06-04):** `orders.customer_id uuid REFERENCES customers(id) ON DELETE SET NULL`; auto-resolve trigger + `sync-shopify-orders` sets FK at upsert time; `customer_profitability` view migrated to prefer FK — `11fa8ef`.
  **Description:** Add `orders.customer_id uuid REFERENCES customers(id) ON DELETE SET NULL`. Backfill by running the same exact + token cascade we now have in `resolve_customer_id_from_name()` (already exposed as a Postgres function), but matching on the order's `customer_email` first (more reliable than name on the orders side), falling back to name. Update `sync-shopify-orders` to set `customer_id` at INSERT/refresh time using the same resolver. Migrate the profitability view's `order_match` CTE to prefer the FK and fall back to email/name only when null. Once readers are migrated, drop or strictly-cache `orders.customer_name`/`customer_email`.

- **#83** Return/refund must hold or void any queued replacement for that customer.
  **Source:** Huayi (2026-06-10 in-session note).
  **Description:** If a customer goes through the **return & refund** process, any **replacement order they're queued up for must be held or voided** automatically. Today a replacement order (`orders.kind='replacement'`) and a return/refund live in separate flows with no cross-check, so we can hit the worst case: **refund the customer AND still ship the replacement they were queued for** — paying twice. This is the refund-side mirror of the ticket-delete cleanup (a deleted ticket already removes its queued replacement; a refund should do the equivalent for the replacement, by customer).
  **What this should do:**
    1. When a return is marked received/refund is approved (or a refund is issued) for a customer, find that customer's **un-shipped** replacement orders (`kind='replacement'`, `shipped_at`/`delivered_at` null — `replacement_state in ('ready','awaiting')`) and **hold or cancel** them. Prefer a **hold** state (reversible) with an operator confirmation rather than a silent delete, since a refund + replacement can occasionally be intentional (e.g. partial refund + still send the part).
    2. Free any **reserved units** back to `ready` and restore decremented **parts on_hand** when a ready replacement is voided (so stock isn't stranded).
    3. Surface a clear **warning banner** on the Refund/Return detail when the customer has a queued replacement: "⚠ This customer has a queued replacement (R-####, <items>) — hold/void it before refunding?" so the operator can't miss it.
    4. Match by **customer** (email + the #67 `customer_id` FK / household link), not just the originating ticket, since the refund may come through a different ticket/return than the one that created the replacement.
  **Why now:** double-paying (refund + replacement shipped) is a direct money-loss bug, and the queued-replacement and return/refund flows currently have zero awareness of each other.
  **Likely touch:** `lib/postShipment.ts` (return/refund status transitions + refund approval) and/or `lib/orders.ts` (a `holdReplacement`/`voidReplacement` helper that frees units + restores parts, mirroring the ticket-delete cascade); a new `replacement_state` value like `'held'` (or a `held_reason`); warning banner in `PostShipment/RefundsTab.tsx` / `ReturnsTab.tsx`; reuse the unit-free / parts-restore logic from the delete-ticket cascade.

- **#90** "Replacement Base" replacement option — must carry a new serial number through the queue.
  **Source:** Huayi (2026-06-12 in-session note).
  **Description:** When queueing a customer up for a replacement (the Service → Replacement picker), add **"Replacement Base"** to the available replacement options alongside the existing parts / consumables / full-unit options. A base is the serialized portion of the machine — unlike a part or consumable, **a replacement base carries its own serial number**, so a customer who's queued for a replacement base must also get the **new serial number assigned (or queued to be assigned)** as part of the same flow, not as a separate manual step.
  **What this should do:**
    1. Add a **"Replacement Base"** entry to the replacement picker (`ReplacementPickerModal`) — its own item type, distinct from parts/consumables and from a full P100/P150 unit. Give it a tag in `replacementTags.ts` (e.g. a `base` item kind + SKU like `P-BASE`) so it shows in the Replacement tab item chips and feeds demand counts correctly.
    2. Because the base is serialized, **reserve / queue a new serial** for the replacement, the same way a full-unit replacement does: if base stock with a serial exists, reserve it; if not, route it through Manufacturing ("To Build") so a serial is created via the normal `assignSerial()` path — mirroring the unit vs. unit_pending split (`P100X`/awaiting-batch handling in #71).
    3. When the replacement base ships, the customer's **canonical unit serial must be updated** to the new base's serial, and that needs to propagate to the customer's `units` row and to their **support ticket's `unit_serial`** (so the device context / DeviceContextHeader and the auto-serial trigger reflect the machine they actually have now). Decide whether the old serial is retired/marked replaced or kept as history on the unit.
    4. Make sure **demand counting** in Stock → Parts & Consumables / the Replacement tab treats a base as serialized supply (a build/PO need), not a loose part on_hand.
  **Why it matters:** if a base is queued like a normal part, the new serial never gets created or linked — the customer ends up with a machine whose serial doesn't match any record, breaking telemetry/dashboard lookups, warranty, and the just-shipped auto-serial-on-ticket trigger.
  **Likely touch:** `Service/ReplacementPickerModal.tsx` (new "Replacement Base" section/option); `lib/replacementTags.ts` (`base` item kind + SKU + demand mapping); `lib/orders.ts` (`createReplacementOrder` / `createPendingReplacement` to reserve-or-queue a base serial like a unit); `lib/build.ts` `assignSerial()` + Manufacturing "To Build" routing (#71) for base-needs-stock; serial-swap logic to update `units.serial` + propagate to `service_tickets.unit_serial` (the `set_ticket_unit_serial` trigger / migration `20260612120000`); Stock Parts/Replacement demand treating base as serialized supply.

- **#82** Quo contact-resolution at sync time — stop creating duplicate customer records, stop storing our own inbox number as `customer_phone`.
  **Source:** 2026-06-07 inbox triage pass (see [docs/session-notes/inbox-triage-2026-06-07.md](session-notes/inbox-triage-2026-06-07.md)). Of 104 untriaged inbox conversations, **36 (bucket D) were orphaned** because the Quo sync stored our own LILA Pro Service inbox number `+13658253070` as `customer_phone` instead of the actual customer's phone — so the conversations never bound to any `customers` row. Separately, **the Dowd household had a duplicate customer record**: Quo created a standalone "RJ Dowd" (`5bfc8713…`) when his number `+18134925113` didn't directly match Katrina's `+18135986409` on the joint household record (`7563fb08…`). Manually cleaned up today, but the same root cause will keep regenerating both bugs on every sync.
  **Why this matters:** Operator triage is the costliest part of the Service module's daily workflow today (104 untriaged inbox rows is roughly 30 min/day for Reina). Half of that work is just figuring out who the customer is. Fixing it at sync time eliminates the bucket-D problem entirely, prevents household-duplicate proliferation, and unblocks the auto-merge pattern from bucket A (the [2026-06-07 triage script](session-notes/inbox-triage-2026-06-07.md) merged 30 follow-ups in one shot when the linkage was correct — without it that flow can't run automatically).
  **Description:** Modify `supabase/functions/sync-quo-tickets/index.ts` to add a contact-resolution step before falling back to creating a new customer row:
    1. **Never store our own inbox number as `customer_phone`.** If the conversation phone matches any of our Quo inbox numbers (today: `+12899012997` Primary, `+18445695452` 844-Joy-LILA, `+13658253070` LILA Pro Service — discoverable via `list-inboxes` MCP call or a hardcoded list), set `customer_phone = null` and rely on the Quo `contact_id` lookup instead. Optionally add a `quo_contact_id` column to `service_tickets` (text, nullable) so the linkage survives the sync rerun.
    2. **Fuzzy resolution before standalone-customer create.** When the Quo contact's phone doesn't directly match `customers.phone`, run a 3-tier cascade (mirror the existing `resolve_customer_id_from_name()` Postgres helper used by `sync-shopify-orders` and the customer_profitability view):
       - Tier 1: exact email match (`lower(quo_contact.email) = lower(customers.email)`)
       - Tier 2: phone last-7-digits match (handles `+1` vs no-`+1` and area-code variants without false positives)
       - Tier 3: last-name + first-name-starts-with on the Quo contact's display name (handles joint accounts like "Amila & Rob Smith", "Katrina & RJ Dowd", "Chris & Renata Grant")
       Only fall through to creating a standalone `customers` row when all three tiers miss and we have an email or name we can store.
    3. **Backfill pass.** After deploying, run a one-shot script that re-resolves every existing `service_tickets` row where `customer_id IS NULL` against the new cascade. Probably reduces bucket-D from 36 → single digits.
    4. **Soft-delete the duplicates** that surface during backfill. Add `customers.merged_into_id uuid REFERENCES customers(id) ON DELETE SET NULL` so future syncs that re-create a duplicate (because Quo's contact lookup returns the dupe's `contact_id`) immediately point readers at the canonical record instead of orphaning. Hard-delete is reversible-via-backup but the soft-link prevents the re-orphan loop.
  **Likely touch:** `supabase/functions/sync-quo-tickets/index.ts` (the resolution cascade + own-inbox filter); new migration adding `customers.merged_into_id` + `service_tickets.quo_contact_id`; possibly extend the existing `resolve_customer_id_from_name()` Postgres helper (from migration `20260604310000_customer_profitability_use_fk.sql` area) so the resolver lives in one place for both Shopify + Quo sync. Pairs with backlog #67 (units.customer_id FK, similar fuzzy-resolution pattern, already shipped) and #68 (orders.customer_id FK, same pattern, in progress).

- **#81** lilacomposter.com support page renders blank for some customers — fix and add a customer-facing self-serve landing page.
  **Source:** Huayi (2026-06-07) — Christine Reese (`shyhrslvr@gmail.com`, +1 760-532-4452, new customer, Shopify contact form 2026-06-05) reported: *"there is no instruction manual and when I tried the support info it comes up blank."* She also reached out to Sona (the AI assistant routed via Quo / OpenPhone) the same day asking whether she needs carbon or pellets and how to set the unit up — both of which the support page should be answering. Reply has been drafted pointing her to the mandatory onboarding (https://calendly.com/lila-ed) and a Quo SMS is being sent to dig deeper into exactly what she clicked and what rendered blank.
  **Why this matters:** New customers hitting a blank support surface within the first 48 hours of unboxing is the single highest-stakes friction point in the onboarding funnel. Today the "fix" is to route every newly-shipped customer through the mandatory onboarding call with Reina, but that takes ~30 min of operator time per customer and depends on the customer actually booking. If the support page worked, ~50%+ of "do I need carbon or pellets" / "where's the manual" inbound would self-serve. Also a Trustpilot risk — first-week confusion drives the 1–2-star reviews that surface in backlog #72 / Junip / Okendo P3 review-loop work.
  **Description:** Two tracks, ship together:
    1. **Diagnose + fix the broken surface.** Walk through what a customer sees today: lilacomposter.com nav → "Support" / "Help" / "FAQ" / wherever. Identify which page or link renders blank for Christine's case (likely a Shopify storefront page that's mid-migration, a HubSpot-hosted help page that 404s, or a Notion-hosted FAQ behind auth). Fix the broken render. Track in the issue: what URL she hit, what browser/device, what the screen actually showed.
    2. **Add a self-serve "New machine setup" landing page** at a stable URL (e.g. `lilacomposter.com/setup` or `/start`) that answers the onboarding-call FAQ inline: carbon vs. starter pellets (when each applies), first food load, daily/weekly maintenance, dashboard intro, where to find the diagnosis-call link. This becomes the page Christine *should* have found on the unboxed device. Promote it on the unboxing card + the `Your LILA is on its way` email + the bottom of the Shopify confirmation. Onboarding call stays mandatory but the page reduces inbound asking the same five questions.
  **Likely touch:** website (Shopify storefront or HubSpot CMS — depends on where lilacomposter.com lives today), `support@lilacomposter.com` template emails to add the new URL, possibly a new `lib/canonicalUrls.ts` constant in makelila so any future operator comms reference the same canonical setup link (mirrors backlog #72's pattern of centralizing customer-facing URLs).
  **Pairs with:** #72 (Trustpilot URL + canned SMS centralization), #3 (Email/SMS templates — the new setup URL should be a template variable), #80 mobile V1 (the setup page must render correctly on the phone Christine is unboxing with).

- **#80** Mobile / responsive layout across every module. — **SHIPPED** (V1 2026-06-07; V2 2026-06-07)
  **Source:** Huayi (2026-06-05, after installing makeLILA to an iPhone home screen and trying to operate it on-device).
  **SHIPPED status:** V1 — viewport `viewport-fit=cover`, PWA `manifest.json`, safe-area insets on AppShell + GlobalNav, `dvh` in modals, narrow-aware bottom tab bar (`2ebe867` 2026-06-07 — ~2h actual vs 15h projected). V2 — `MobileHome` landing page with `NavCard` tiles per module, card-drilldown pattern across Service/PostShipment/Fulfillment/Customers/Stock/Build/OrderReview/Dashboard/ActivityLog/Templates, row → detail drill + Inbox tap-to-read (`24d968d`, `4ab795d`, `3db2b3b`, `acb3181`, `910c529` 2026-06-07). CSS scroll-blocking fix + CI unblock (`fbad3bd`). V3 (sheet/drawer detail panels) deferred.
  **Symptom:** Once added to the home screen as a PWA-style icon, the app loads and the tab buttons at the top of a module respond to taps (e.g. swapping between Pending / Out / Flagged / Confirmed / Replacement / All on Order Review). But nothing else works: tables don't scroll horizontally to reveal the rest of the columns, side panels can't be opened or dismissed by drag, and the page itself doesn't scroll vertically past the first viewport. The desktop layout assumes a wide viewport + cursor; on iPhone widths the operator is stuck on the first screen of every module.
  **Why this matters:** Operators (Raymond / Junaid on the floor, Pedrum / George traveling, Huayi for after-hours triage) increasingly want to glance at the queues, mark a ticket, or sanity-check an order from their phone without booting a laptop. Today the app is effectively desktop-only despite being a web app installable to home screen.
  **Scope — every module needs a responsive treatment:**
    - **Dashboard** — sidebar machine list collapses to a top sheet on narrow widths; chart area takes full width; status SMS modal becomes a bottom sheet.
    - **Order Review** — left order list collapses to a sliding drawer; detail cards stack single-column; readiness checklist + address card / line items / payment summary become accordion sections instead of side-by-side.
    - **Fulfillment** — Queue / Shelf / History tabs each need to stack their dense tables into card-style rows on phone widths; step controls (assign → test → dock → label → email) should be vertical with full-width buttons.
    - **PostShipment** — Returns / Refunds / Replacements / Cancellations / History tabs use the same dense tables as Fulfillment; same card-row treatment + bottom-sheet detail.
    - **Service** — Inbox / Onboarding / Support Tickets / Replacement tabs all use a table + side detail panel pattern; on phone the detail panel should be a full-screen takeover with an explicit back button.
    - **Stock** — Units / Parts / Batch tables need horizontal scroll *or* a card-row mode; serial-detail panel becomes a bottom sheet.
    - **Customers** — directory list + Journey tab + detail panel — same drawer/takeover pattern as Service.
    - **Build** — pipeline board doesn't fit on mobile at all today; needs a stacked-list fallback layout under ~700px.
    - **Templates / ActivityLog** — read-only enough that a single-column stack with wider tap targets should be sufficient.
  **Cross-cutting fixes:**
    1. **Viewport meta + safe-area insets** — confirm `<meta name="viewport" ...>` is set with `viewport-fit=cover`; use `env(safe-area-inset-*)` on the AppShell + GlobalNav so the iPhone notch / home indicator doesn't clip controls.
    2. **PWA manifest** — add `manifest.json` (display: standalone, theme + background colors matching the crimson brand, full-bleed icons for iOS) so the home-screen install behaves like an app rather than a clipped Safari window. This is what was used to install today and explains why the user sees the chrome-less broken layout.
    3. **GlobalNav** — collapse the module switcher into a hamburger menu or bottom tab bar on narrow widths so the active module label is visible without consuming the full top row.
    4. **Touch targets** — bump minimum interactive size to 44px (Apple HIG); replace hover-only affordances (e.g. the new attachment delete X that only appears on `:hover`) with always-visible controls on coarse-pointer devices (`@media (hover: none)`).
    5. **Modals & lightboxes** — the existing CSS-module modal pattern uses fixed widths; switch to `max-width: 100vw` + `max-height: 100dvh` with `dvh` (dynamic viewport units) so the iOS URL bar doesn't crop the bottom controls.
    6. **Tables — pick one strategy per module and apply consistently.** Either (a) wrap in a horizontally-scrollable container with sticky first column, or (b) at narrow widths re-render the same data as stacked cards. Mixing both within one module is the most likely source of inconsistent "I can't scroll" complaints.
  **Suggested phasing (so this doesn't have to ship as one giant PR):**
    1. **V1 — make every module *survivable* on phone:** add the viewport meta + manifest, fix `dvh` units in modals, make the AppShell + GlobalNav narrow-aware. After V1 operators can at least scroll and reach every control even if it's ugly.
    2. **V2 — module-specific table layouts:** convert the highest-traffic tables (Order Review list, Fulfillment Queue, Support Tickets) to card-row mode under a breakpoint. Lower-traffic modules can keep horizontal scroll.
    3. **V3 — sheet / drawer patterns for detail panels** so opening a ticket / order takes over the full screen on mobile with a clear back affordance.
  **Out of scope:**
    - Native iOS / Android apps. PWA installable to home screen is sufficient.
    - Offline-first / sync-when-online. The operator UX explicitly assumes a live connection (Supabase realtime).
    - Tablet-specific layout (iPad in landscape behaves close enough to desktop today).
  **Likely touch:** every `*.module.css` (responsive breakpoints), `components/AppShell.tsx` + `components/GlobalNav.tsx` (narrow-aware navigation), `index.html` (viewport meta + manifest link), new `public/manifest.json` + icons, and a follow-up audit pass per module for the table strategy in V2.

- **#79** Profitability: net out returned-unit recoverable value from `expected_refund_usd`.
  **Source:** Huayi (2026-06-05, follow-up after V4 tax-split shipped).
  **Why:** Today `expected_refund_usd` treats every refund approval as pure unrecoverable cost. In practice, when a customer returns the unit:
    1. If undamaged → it gets **restocked** and the unit value comes back into inventory (net cost of the return is just shipping + restocking labor, not the full refund).
    2. If damaged → it goes to the **claims department**; carrier insurance pays out up to the declared value, so part of the refund cost is recovered from the carrier rather than absorbed.
  Brand-new units shipped back have a baseline declared value of **$500 USD** for claim purposes — this is the floor we use when filing damage claims against the carrier, regardless of what we paid for the unit (so we always have insurance cover even when COGS drops below $500 in future batches).
  **Description:**
    1. **Schema additions** on the `returns` (or `refund_approvals`) table:
       - `unit_returned_condition text` enum: `pending`, `undamaged_restock`, `damaged_in_transit_claim_open`, `damaged_in_transit_claim_paid`, `damaged_not_recoverable`
       - `unit_recovered_value_usd numeric(12,2)` — what we actually got back (restock value if undamaged, insurance payout if damage claim succeeded, $0 if not recoverable)
       - `claim_declared_value_usd numeric(12,2) default 500.00` — the value we declared to the carrier when filing the claim (defaults to the brand-new floor)
    2. **Operations workflow** in the PostShipment module: a "Receive return" step that captures unit condition + photos, then routes to either restock (auto-stamp `unit_recovered_value_usd` = current per-unit cost from #58 V3 schedule) or claims (open a claim record, stamp once paid).
    3. **Profitability view update** (V5): change `expected_refund_usd` calc to subtract `coalesce(unit_recovered_value_usd, 0)` per linked return — so the profitability view shows the *net* refund cost to VCycene rather than the gross customer-facing refund amount. Keep the gross amount surfaced separately for accounting reconciliation.
    4. **Edge cases to handle:**
       - Partial refund (customer keeps the unit but gets a partial refund) — no return, no recovery, refund = pure cost.
       - Return lost in transit before reaching us — escalate to a claim against the *return* carrier, but no unit value recovered.
       - Restock-then-resold — the recovered value technically becomes new revenue at the next sale; need to decide whether to double-count or net out. (Suggest: net out so the original customer's profitability only credits the unit-cost recovery, and the resale shows as fresh revenue.)
  **Why this matters:** Without this, the Profitability tab over-states warranty/refund cost for any customer whose returned unit was actually recovered. Brent Neave's $1396 in-flight refund currently fully offsets his $1396 revenue → $0 margin. If his unit is undamaged and gets restocked, the real net cost to VCycene is closer to $1396 - $500 (restock value) - shipping cost of the return = much less than $1396, so the actual margin is positive.
  **Likely touch:** SQL migration for the `returns` schema additions; `lib/postShipment.ts` for the new "Receive return" mutations + condition enum; `PostShipment/ReturnsTab.tsx` for the UI; `customer_profitability` view V5 to net out the recovered value.
  **Source:** Huayi (2026-06-05, observed during the V4 tax-split rollout).
  **Description:** `sync-shopify-orders` extracts `subtotal_usd`, `tax_usd`, `discount_total_usd` since some point in mid-2026, but the 40 sale orders that pre-date that sync code change still have all three columns NULL. V4's customer_profitability view coalesces tax_usd → 0 when NULL, so revenue for those rows falls back to `total_usd` (same as V3 behavior — no regression, but the tax split is incomplete). Fix: trigger a re-sync against the gap-set order IDs (or simply re-run `sync-shopify-orders` with the existing "always-safe fields" refresh path, which Shopify exposes — these fields are documented as the kind that's safe to refresh without clobbering operator-curated state). After re-sync, the V4 view auto-corrects margins downward (by the tax amount) without code changes. Out of scope: enriching the Shopify pull with full invoice lines (taxes per jurisdiction, individual promo codes per line) — captured separately.
  **Likely touch:** `supabase/functions/sync-shopify-orders/index.ts` (verify the always-safe-fields code path covers tax/discount columns); ops one-time run of the sync against the 40 gap orders by order_ref or date window.

- **#77** Profitability: 97 spreadsheet shipping rows belong to customers not in the orders table.
  **Source:** Huayi (2026-06-05, observed during shipping-cost backfill).
  **Description:** When backfilling `orders.shipping_cost_usd` from the `LILA customer fulfillment-20260605.xlsx` + `LILA customer shipping via MaxxUs.xlsx` files, 97 rows ($9,685 total carrier cost) matched no DB order by customer name. These are real LILA customers whose Shopify orders weren't synced into `orders` — the orders table starts at ref `#1070` (Ron Russell, Apr 2026) but the MaxxUs file goes back to Oct 2025. Fix: extend the `sync-shopify-orders` window backward (currently bounded to recent orders) to import the pre-#1070 history. Once those orders land, a re-run of the shipping backfill (`supabase/migrations/20260605040000_backfill_shipping_costs.sql` followed by a fresh extraction from the xlsx) catches the 97 strays.
  **Likely touch:** `supabase/functions/sync-shopify-orders/index.ts` (drop the date floor or add an `import_historical=true` mode); after sync, regenerate the shipping backfill via `match_shipping.py` against the now-larger orders table.

- **#76** Activity Log KPI panel: tiles all read zero — re-pick tile types to match the action-type strings actually being written + fix "today" timezone. — **SHIPPED** (2026-06-04). Re-mapped tiles to the action types that operators actually write daily: Today = Total / QC reports filed (`unit_test_report`) / Addresses verified (`address_verified`) / Status SMS sent (`dashboard_status_sms`) / Tickets resolved (`ticket_status_changed` w/ detail match); Fulfillment-7d = QC reports / FQ tests passed / Stock status flips; Customer-ops-7d = Addresses verified / Auto follow-ups / Tickets created. Refactored compute() to drive off a `TILE_DEFS` array so adding/renaming tiles + their counted types is one entry. Each tile's tooltip surfaces `0 in last 7d — expected types: X, Y` when the value is zero so the next time an action-type string drifts (rename, retire) the gap is visible on the panel instead of silently reporting flat-zero. "Today" boundary continues to use the browser's local timezone (correct for operator perception today; flagged in the compute() comment to be made explicit if a server-side aggregator is added later).
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

- **#72** Centralize Trustpilot review link + canned SMS / email templates in one source of truth. — **SHIPPED** (2026-06-04)
  **Source:** Surfaced 2026-06-04 — an SMS to Michael Romans went out with `trustpilot.com/review/vcycene.com` (a guessed URL). The actual link is `trustpilot.com/review/lilacomposter.com`. Operator had to send a correction SMS. Today there's no central place where the review URL lives; each operator typing a customer-facing message has to remember the right link.
  **SHIPPED status (2026-06-04):** `lib/cannedSms.ts` centralizes `TRUSTPILOT_REVIEW_URL`, `DIAGNOSIS_CALL_BOOKING_URL`, and all SMS templates (`10d3237`). Remaining: surfacing templates from DB (editable via Templates module) rather than hard-coded constants — planned but deferred.
  **Description:** Build a `templates` table (or extend an existing config table) holding:
    - **External URLs:** Trustpilot review (`https://www.trustpilot.com/review/lilacomposter.com`), Google review link, support email signature URL, etc.
    - **Canned message bodies:** wellness-check (already inline in `lib/dashboard.ts STATUS_SMS_TEMPLATES`), lid alert, review-request SMS, defective-unit acknowledgment, etc. — all parameterized on `{first_name}`, `{order_ref}`, etc.
  Surface in two places:
    1. **Backing the existing inline templates** in `lib/dashboard.ts` so operators can edit copy without code deploys.
    2. **The `StatusSmsModal` "Send template" picker** — let the operator pick from any template (not just the status-keyed one) when sending a one-off message from the Dashboard. Same for the Quo reply UI in Service tickets.
  This also resolves the Quo-reply-via-template gap in #3 / #12 (the existing Templates module was scoped to Order Review email templates only).
  **Likely touch:** new `templates` table migration; `lib/templates.ts` extension with non-tab-specific templates; `Dashboard/StatusSmsModal.tsx` to pull templates from the DB instead of `STATUS_SMS_TEMPLATES`; future Templates-module UI for ops to edit.

- **#71** Replacement orders: first-class "awaiting inbound batch" state + visible queue. — **SHIPPED** (2026-06-04, extended 2026-06-09)
  **Source:** Surfaced 2026-06-04 — Kristen Pimentel's cracked-shell replacement (R-0001) needs a P100X unit, but no P100X units are `ready` yet (batch is in production in China, expected end of July). Today the only signal is `orders.line_items = []` + `cogs_usd = null` on a `status='pending'` row, plus a free-text note in `batches.notes`. Operators have no list view of "what's waiting on which batch", and customers get vague "we'll queue it" replies.
  **SHIPPED status:** `orders.awaiting_batch_id` column + `awaiting_inventory` status — `c4c50fe` (2026-06-04). Replacement tab "Awaiting batch" filter chip + item/stage tags (Unit / Awaiting batch / Parts-Consumables) — `364d465`, `58a6540`, `081f495`, `8b51a9e` (2026-06-09). Order Review Ready/Awaiting sub-tabs also added. Remaining: batch-arrival "promote to fulfillment" sweep (step 3 in original spec).
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

- **#67** Canonicalize the units → customers link (replace free-text `units.customer_name` with a proper FK). — **SHIPPED** (2026-06-04)
  **Source:** Surfaced during #60/#66 SMS send — operator hit "no customer linked" for unit LL01-00000000236 because `units.customer_name = "Amila Smith"` while the canonical customer record is `"Amila & Rob Smith"` (joint account). Patched 2026-06-04 with a tolerant last-name + first-name-starts-with cascade in `customerForSerial()`, but the underlying schema is the actual bug.
  **SHIPPED status (2026-06-04):** `units.customer_id uuid REFERENCES customers(id)` added; backfill via fuzzy resolver; FK-preferring `customerForSerial()` cascade; `lib/stock.ts` Unit type updated; fulfillment assignment flow sets FK — `c2026ff`. ~132/181 customer-assigned units linked; ~47 orphans remain (#69).
  **Description:** Today `units.customer_name` is a free-text column populated at fulfillment time. The corresponding `customers.full_name` may differ (spouse appended, nickname vs. legal, typos, Shopify-imported vs. HubSpot-imported representation). Every cross-module lookup that wants "the customer record for this unit" has to do fuzzy resolution. This will keep biting us as more features (#58 profitability rollups, #60/#66 status SMS, #54 Dashboard click-to-assign, etc.) cross from units → customers.
  Fix path:
    1. **Add `units.customer_id uuid REFERENCES customers(id) ON DELETE SET NULL`** as the new authoritative link. Index it.
    2. **Backfill** by running the existing fuzzy resolver against every shipped unit. Cases where the resolver returns >1 candidate get flagged for manual operator review (rather than silently picking wrong).
    3. **Update the fulfillment serial-assignment flow** so it sets `customer_id` from the picked customer's ID (Order Review already has the customer in scope when the operator approves) rather than copying the name string. Keep `customer_name` as a denormalized display cache for now to avoid breaking everything that reads it.
    4. **Migrate readers one module at a time** to prefer `customer_id` lookups over name resolution. The tolerant cascade in `customerForSerial()` becomes the legacy code path that only kicks in when `customer_id IS NULL`.
    5. Once every reader is on `customer_id`, drop the free-text column (or keep it as a one-way denormalized cache and stop relying on it for joins).
  **Why now:** the longer we wait, the more code paths get written against the fuzzy join. Doing the FK + backfill now is a small migration; redoing five tabs later is a bigger one.
  **Likely touch:** SQL migration (column + FK + backfill); `lib/stock.ts` Unit type; `lib/dashboard.ts` `customerForSerial` to prefer `customer_id`; `Fulfillment/queue/StepAssign.tsx` (or wherever assignment writes the unit) to populate the FK; reviews of every `units.customer_name` reader for migration.

---

## CJM signals — Jun 2026

> Source: customer journey analysis grounded in live Gmail signals (Jotform return forms, Fireflies call recaps, Zipchat AI inquiry log, Calendly booking patterns). Surfaced 2026-06-07.

- **#83** Fill Zipchat AI's 15 unanswered customer questions (operational — no code).
  **Source:** Zipchat dashboard notification (2026-06-07). 15 unresolved questions in "Pending Corrections" as of Jun 1.
  **Description:** Go to app.zipchat.ai → LILA AI → Training → Pending Corrections and answer every open question. Confirmed gaps: country of manufacture, official phone support hours (365-825-3070), and compost output mass per full 22L chamber. Answering all 15 stops customers from hitting dead ends on the chatbot and reduces inbound DMs/tickets for questions the AI should handle.
  **Owner:** Huayi / Edward (product facts); Reina (copy review). **Effort:** ~30 min operational, no code.

- **#84** Post-order address confirmation email — prevent Phayvanh-type returns.
  **Source:** CJM analysis 2026-06-07 — Phayvanh's return (#1110) was caused entirely by Shopify defaulting the wrong shipping address at checkout with no recovery path.
  **Description:** When `sync-shopify-orders` pulls in a new order, trigger a `send-template-email` call within 1 hour of order placement with a new `address_confirmation` template. The email shows the address on file and two CTAs: "This is correct ✓" (no-op, logs confirmed timestamp to `orders.address_confirmed_at`) and "I need to change this →" (links to `support@virgohome.io` or a short Jotform). Fires before the fulfillment queue picks up the order. If `address_confirmed_at` is null after 48h, surface a yellow badge "Address unconfirmed" on the OrderReview card.
  **Likely touch:** `supabase/functions/sync-shopify-orders/index.ts` (call `send-template-email` post-upsert); new `address_confirmation` template row; `orders` migration adding `address_confirmed_at TIMESTAMPTZ`; OrderReview address card badge.

- **#85** Shipping exception → proactive customer notification.
  **Source:** CJM analysis 2026-06-07 — Phayvanh: "UPS is slow to respond." Customers left to chase carriers alone when a shipment hits Exception status.
  **Description:** In the Freightcom/ClickShip tracking poll, when a shipment's `status` changes to `exception`, immediately trigger `send-template-email` with a new `shipping_exception` template. Copy: "We noticed a delivery delay on your LILA order. Here's what we know: {carrier_last_event}. Our team is on it — you don't need to contact the carrier yourself." Stamp `fulfillment_queue.exception_notified_at` for dedupe (fires once per exception episode).
  **Likely touch:** the edge function that polls carrier tracking; new `shipping_exception` template row; `fulfillment_queue` migration adding `exception_notified_at TIMESTAMPTZ`.

- **#86** Pre-call primer document + Calendly call routing to Reina (process, no code).
  **Source:** CJM analysis 2026-06-07 — onboarding calls running 45–52 questions because customers arrive cold; Edward's calendar is the only booking option.
  **Description:** Two process changes:
    1. **Pre-call primer document.** Write a 1-page "Before your LILA Pro onboarding" doc (Notion or PDF): what LILA Pro composes (and doesn't — no citrus, no meat), realistic first-cycle timeline (2–3 weeks per chamber), what "moist" means in the chamber, the 3 things to check if it smells. Attach to the Calendly booking confirmation email 24h before the call.
    2. **Add Reina's Calendly event type.** Create "LILA Pro Onboarding with Reina (CS)" alongside Edward's. Update the fulfillment step-5 email template's booking link to default to Reina's calendar; reserve the Edward link for B2B or escalation cases.
  **Owner:** Reina (write the primer); Huayi (update booking link + Calendly setup). **Effort:** ~2h, no code.

- **#87** Post-call follow-up email template — close the 48-hour drop-off after onboarding.
  **Source:** CJM analysis 2026-06-07 — Fireflies recaps show calls end with a verbal summary only; customers have no written reference for the first 48h when they need it most.
  **Description:** 1 hour after an onboarding call ends (based on `service_tickets.onboarding_completed_at`), trigger `send-template-email` with a new `post_onboarding_followup` template. Content: "Here's what we covered: {call_summary_bullets}" — three points (first food load, when to expect the first batch, moisture check). Until Fireflies API integration is built, the summary bullets are a static editable block; show a "Review and send" modal in the Service Onboarding tab before sending. Log to `service_tickets.followup_email_sent_at`.
  **Likely touch:** `sync-calendly-events/index.ts` (schedule 1h delayed call on event completion); new `post_onboarding_followup` template; `service_tickets` migration adding `followup_email_sent_at TIMESTAMPTZ`; "Review and send" modal on Onboarding tab.

- **#88** Day 3 + Day 7 first-week drip emails — prevent Brent-style returns.
  **Source:** CJM analysis 2026-06-07 — both of Brent's return reasons (messy chamber access, output below expectations) were directly addressable with expectations-setting content before frustration set in. He returned without ever contacting support.
  **Description:** Two automated Klaviyo emails triggered by `customer_events.event_type = 'first_use'` (captured via the lilalovely integration):
    - **Day 3:** "Your first week with LILA — what's normal." Content: chamber moisture/damp = active composting; smell tips (lid closed, dry layer on top); what goes in vs. what doesn't; CTA → book a diagnosis chat if concerned.
    - **Day 7:** "Your first batch is on its way." Content: first tray takes 2–3 weeks; volume per tray ~{X cups} — ideal for plants, not bulk gardening; how to empty the tray cleanly (specifically addresses the wet/messy access pain Brent reported).
  Klaviyo flow: trigger on `first_use`, delay 3d → email 1, delay 4d → email 2. Content to be drafted by Reina. Flow setup ~2h once copy is approved. No makelila code changes.

- **#89** Win-back email 30 days post-return — recover "Maybe / Unsure" returners.
  **Source:** CJM analysis 2026-06-07 — both 2026 returners (Brent Neave, Phayvanh Xayasane) left "Maybe / Unsure" on next-gen consideration. ~$2.8k recoverable pipeline.
  **Description:** When `returns.status` changes to `refunded`, schedule a Klaviyo email for T+30 days. Subject: "We heard your feedback." Content: acknowledge the specific return reason (pull `return_category` to personalize the opening sentence), brief note on what's being worked on for the next generation, soft CTA → "Want first access? Join the waitlist: {waitlist_link}." No discount, no hard sell — reopen the door. Requires a Typeform/Jotform waitlist form first.
  **Klaviyo trigger:** `refunded` event with `return_category` as a property. Flow setup ~1h. No makelila code changes beyond emitting the Klaviyo event on refund completion.

---

## George × Huayi strategy meeting — 2026-06-18

> Source: Plaud Notes recording [06-18 Meeting: Product Defect Management, Customer Support Troubleshooting, and MakeLila System Development Strategy](https://drive.google.com/drive/folders/1Z1DaCRHEHN3GtICQZUkgj7b8hBLiJA6f).
> Attendees: Huayi, George (Speaker 3). Key decisions: ship current 50-unit batch despite known cracking risk; implement stricter water-test QC for future batches; establish roadmap for QB ↔ MakeLila finance integration.

- **#91** Finance: onboard Julie to the refund approval workflow. ✅ *Role already correct — action needed is training only.*
  **Source:** George (2026-06-18 — "Julie can only review, not approve")
  **Investigated 2026-06-19:** Julie's Supabase profile (`yueli@virgohome.io`) already has `role = 'finance'`. The permissions code (`canDo(role, 'approve_refund_finance')`) correctly gates the finance-approval buttons on that role. The "Approve (finance, paid)" button and the finance amount-correction modal are fully implemented in `PostShipment/RefundsTab.tsx`. **No code or DB change needed.**
  **Root cause:** Julie hasn't been shown the interface. When a refund reaches the Finance review column, she sees her role displayed as "Finance" in the KPI chip and the "Approve (finance, paid)" button appears on the card. She's never been walked through this.
  **Remaining action (Huayi + Julie):** 30-minute walkthrough — show Julie the Refunds tab, walk through a real refund card in `finance_review` status, and demo the amount-correction modal (where she can adjust the amount before confirming payment). Also write a one-page reference doc for her covering: how a refund reaches her queue, how to change the amount if needed, which payment method to choose for each channel, and what "Deny" does.

- **#92** Finance: QuickBooks sales invoice integration — resolve zero-refund-amount bug.
  **Source:** George (2026-06-18 — spotted a $0 refund entry and immediately questioned the system's reliability)
  **Description:** MakeLila currently cannot calculate accurate refund amounts because it has no access to QuickBooks sales invoices. Invoices contain customer-specific details — tax rates (vary by region), discount codes, promotional adjustments, Sezzle vs. Shopify payment splits — that aren't fully captured in Shopify's transaction record. Without them, refund fields default to $0. This was the first thing George noticed and it immediately eroded his trust in the system.
  **Interim (until integration ships):** Patrick manually inputs invoice data prepared by Julie from QuickBooks into MakeLila. Julie prepares → Patrick enters → MakeLila shows accurate amounts. This is the exact process previously used with HubSpot.
  **Long-term:** Build a read-only QuickBooks API integration that pulls sales invoices directly into MakeLila on order sync. Treat QuickBooks as a **read-only data source** — MakeLila never writes to QB without George's explicit approval. Prioritize one platform at a time (Freightcom first, then Shopify, then QuickBooks — don't do them simultaneously).
  **Constraint:** Any new QuickBooks categories or data flows require George's review before implementation. Reference incident: Linda's team accidentally deleted QB invoices and Julie's team spent two weeks recovering them.
  **Likely touch:** new edge function `supabase/functions/sync-qb-invoices/index.ts` (read-only QB API via OAuth); `lib/orders.ts` — add invoice fields; `PostShipment/FinanceReview.tsx` — populate refund amount from invoice data; interim: document the Patrick-entry workflow in the Julie instruction doc (#91).

- **#93** Fulfillment: handle multi-unit orders spanning multiple order IDs.
  **Source:** Huayi (2026-06-18 — live example: customer ordered 3 machines, split as 2+1 across two Shopify orders)
  **Description:** The fulfillment module assumes one unit per order. An edge case arose where a single customer had two linked Shopify orders for the same delivery (a 2-machine order and a 1-machine order). MakeLila treated them as independent, making it impossible to coordinate fulfillment (e.g. ship all three on the same skid, generate a single tracking communication). George and Huayi agreed this is an "R&D phase" workflow — it hasn't happened enough to warrant premature codification. **Do not build this yet.** Track it here so Raymond (fulfillment module owner) can flag when the edge case recurs and request the feature once the workflow is understood. When it does ship: link orders by `customer_id` + delivery window; surface linked orders on the fulfillment queue row; allow a single serial-picker session to assign units to multiple linked orders.
  **Status:** Deferred (R&D phase — workflow not yet stable enough to codify).

- **#94** Stock QC gate — block fulfillment of units with failed or incomplete tests.
  **Source:** Huayi (2026-06-18 — a unit with an incomplete test record was inadvertently shipped to Kevin)
  **Description:** The fulfillment serial picker currently surfaces all units with `status = 'ready'`, regardless of QC test results. Because Janet's stock data has gaps (missing test reports, incomplete entries), units with failed or untested QC fields slip through. Operators have no visual warning that they're assigning a problematic unit.
  **What this should do:**
    1. In the fulfillment serial picker, evaluate each candidate unit's QC fields (Electrical Pass/Fail/Incomplete, Mechanical Pass/Fail/Incomplete — per #5). If any required field is `fail` or `incomplete`, mark the unit non-selectable with a "QC incomplete" badge and a tooltip listing the failing fields. Only units where all required QC fields are `pass` can be assigned.
    2. If an operator needs to override (rare, deliberate decision), require a manager-level confirmation with a required note.
    3. Surface a "Units with QC gaps" count on the Stock module header so Janet can see her backlog at a glance.
  **Prerequisite:** #5 (Machine-Level QC Tracking fields) must be populated — gate is only as good as the data. Janet needs to be the responsible owner for keeping QC data current.
  **Likely touch:** `Fulfillment/Queue/SerialPicker.tsx` — add QC field evaluation + non-selectable state; `lib/stock.ts` — QC status helper; `Stock/index.tsx` — "QC gaps" count chip.

- **#95** Finance: QuickBooks backup protocol — snapshot QB data within MakeLila.
  **Source:** George (2026-06-18 — recounted incident where Linda's team deleted QB invoices; recovery took Julie's team two weeks of late nights)
  **Description:** MakeLila already reads from QuickBooks (once #92 ships). Each read-sync is an opportunity to also snapshot the pulled data into a `qb_backups` table, giving VCycene a local recovery point if QB data is accidentally modified or deleted. George agreed this is worth building as a safety net.
  **Scope:** Read-only snapshot of imported invoice/payment records at sync time. Not a full QB mirror — only the records MakeLila pulls. Backups keyed by `(record_type, qb_record_id, snapshot_at)`. Operators can view the snapshot history on the Finance module for any record. In a recovery scenario, the snapshot gives Julie a reference to reconstruct deleted entries manually. Full automated push-back to QB is out of scope (too risky without strict change control).
  **Prerequisite:** #92 (QB invoice integration) must ship first — this is a bolt-on to that sync.
  **Likely touch:** new `qb_backups` table (migration); append snapshot write to the QB sync edge function; light read view in `Finance/` module.

- **#96** Finance: AI-driven bookkeeping auto-classification. *(P3 — strategic)*
  **Source:** Huayi (2026-06-18)
  **Description:** Julie currently categorizes every QuickBooks transaction manually, assigning expenses to tax codes, SR&ED-eligible buckets, and account categories. Once MakeLila has access to QB data (#92), a classifier trained on Julie's historical categorization patterns could auto-assign categories for new transactions and present them to Julie as suggested classifications. Her role reduces from manual data entry to review-and-approve ("click yes / no"). George acknowledged the value; agreed it's a later-phase effort once the foundational QB integration is stable.
  **Out of scope for now:** building or hosting the model. The immediate prerequisite is #92 (QB invoice data in MakeLila) and a sufficient history of labeled transactions.

- **#97** Finance: SR&ED report automation. *(P3 — strategic)*
  **Source:** Huayi (2026-06-18)
  **Description:** VCycene currently relies on external consultants to prepare SR&ED (Scientific Research and Experimental Development) tax credit filings. Once MakeLila integrates QB bookkeeping data (#92) and the AI classifier (#96) can identify SR&ED-eligible expenses, MakeLila could auto-generate the filing report from historical data — reducing or eliminating the consultant dependency. George is responsible for SR&ED alongside Julie managing the accounting. Huayi confirmed Julie also handles this area (he had assumed George was managing it directly).
  **Out of scope for now:** this is a long-horizon item. No implementation until #92 and #96 are stable and Julie has validated the categorization accuracy.

## Surebright warranty management integration — 2026-06-19

- **#98** Service: integrate MakeLila with Surebright (Shopify warranty management app).
  **Source:** Huayi (2026-06-19)
  **Description:** Surebright is a Shopify-native warranty management app that handles warranty registration, claim submission, and claim adjudication on behalf of merchants. VCycene sells the LILA Composter through Shopify; Surebright sits on top of that to manage the extended warranty product. Currently, warranty claims submitted through Surebright are invisible to MakeLila — operators learn about them via email or manually. This creates a gap in the PostShipment module where returns, refunds, and replacements exist but warranty claims do not.
  **What this should do:**
    1. **Inbound sync:** Pull warranty registrations and claim events from Surebright into MakeLila. A new `warranty_claims` table (or extension of `warranty_registrations`) stores claim ID, Shopify order ID, claim type (repair/replacement/refund), status (open/approved/denied/closed), decision date, and payout amount. Sync cadence: webhook-driven on claim status change, with a polling fallback.
    2. **PostShipment visibility:** Surface active warranty claims in a new "Warranty Claims" tab alongside Returns, Refunds, and Replacements. Operators can see claim status without leaving MakeLila. Read-only initially — MakeLila does not write back to Surebright.
    3. **Customer linkage:** Join warranty claims to MakeLila customers by Shopify order ID → `orders.shopify_order_id`. Link from the Customers module detail panel ("Active warranty claim" chip → claim detail).
    4. **Service ticket bridging:** When a warranty claim is approved and requires physical repair/return, auto-create or link a Service ticket so the Reina/Junaid support flow can track fulfillment.
  **Open questions before implementation:**
    - Surebright API availability: confirm whether Surebright exposes a merchant-facing REST or webhook API, or whether sync must go through Shopify metafields/order tags that Surebright writes.
    - Auth model: API key per shop vs. OAuth.
    - Write-back scope: determine if MakeLila should ever push claim decisions back to Surebright (likely out of scope for V1 — Surebright adjudicates, MakeLila observes).
  **Likely touch:** new `warranty_claims` table (migration); new edge function `supabase/functions/sync-surebright/index.ts`; `lib/postShipment.ts` — add warranty claim types and hook; `PostShipment/` — new `WarrantyClaimsTab.tsx`; `Customers/` — warranty chip in detail panel; `Service/` — auto-link claim → ticket.
  **Prerequisite:** confirm Surebright API access with George/Shopify admin before starting.
  **Priority:** P2 — clear operational gap, single owner (PostShipment), no competing requestors yet.

- **#99** Shipping: replace Freightcom damage claim workflow with Surebright shipping protection.
  **Source:** Huayi (2026-06-19 — raised in Surebright pre-meeting prep)
  **Current pain:** Shipping damage claims through Freightcom are a multi-step, weeks-long process entirely owned by VCycene operations:
    1. Customer reports damage to VCycene support via email
    2. Operator logs an internal claim in MakeLila (Shipping → Claims tab), linked to `freightcom_shipment_id`
    3. VCycene separately files a formal claim through Freightcom's own portal — gathering damage photos, original invoice, packing list, proof of declared value, and sometimes a carrier inspection report
    4. Freightcom adjudicates on their timeline (typically several weeks; longer for high-value claims)
    5. If approved, Freightcom reimburses VCycene. VCycene then reshipsthe replacement or issues a refund to the customer separately — out of pocket until the claim resolves
  The customer has no visibility and waits weeks. VCycene carries the documentation burden, back-and-forth with Freightcom, and upfront reshipment cost while the claim is pending.
  **With Surebright shipping protection:**
    1. Customer self-files at customer.surebright.com in under 5 minutes
    2. Surebright adjudicates directly with the insurer — typically resolved in 24 hours
    3. Customer receives repair, replacement, or refund without VCycene support involvement
    4. VCycene sees claim status in MakeLila automatically via webhook (once #98 integration ships)
    5. VCycene earns revenue share on shipping protection sold at checkout — no claim cost exposure
  **Open questions (to confirm with Surebright on 2026-06-24 call):**
    - For shipping damage specifically: does the customer go directly to Surebright, or does VCycene need to initiate anything?
    - Does Surebright shipping protection apply from when the label is booked, or only when the customer purchases it at checkout?
    - Does this replace Freightcom's native claims process entirely, or run in parallel?
  **What this means for MakeLila (post-Surebright integration):**
    - The Claims tab in `Shipping/tabs/ClaimsTab.tsx` currently files claims against `claims` table linked to `freightcom_shipment_id`. Once Surebright shipping protection is live, transit damage claims will flow through Surebright (#98 webhook), not the internal Freightcom claim form.
    - Likely outcome: MakeLila Claims tab becomes read-only for Surebright-covered orders; Freightcom claim form retained only for orders without Surebright coverage or for delay/late claims Surebright doesn't cover.
  **Likely touch:** `Shipping/tabs/ClaimsTab.tsx` — add coverage indicator (Surebright vs. Freightcom) and suppress internal claim form for Surebright-covered shipments; `lib/shipping.ts` — check warranty_claims for existing Surebright shipping claim before showing the Freightcom form.
  **Prerequisite:** #98 (Surebright integration) must ship first; Surebright shipping protection confirmed active for VCycene account.
  **Priority:** P2 — significant ops time saved per damaged shipment; prerequisite on #98.

---

## Reference

- Email thread: "makeLILA app beta release, VCycene, Huayi" (started Apr 21, 2026)
- Demo video: [Google Drive link](https://drive.google.com/file/d/1Mqx-wjIzedkeNfkR-0c-nDJw_lrAeWPP/view?usp=sharing)
- Fireflies recap: [makeLILA beta demo v1](https://app.fireflies.ai/view/makeLILA-beta-demo-v1-mp4::01KPVHNYP2K58QRFFVQ2R1FZYT)
- Return checklist reference: Google Sheet "VCycene_Return_Checklist" (per George)
