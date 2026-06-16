# makeLILA Competitive Landscape and Improvement Proposal

> Synthesis date: 2026-06-06. Authors: research synthesis across MVP-first, risk-first, and hardware-product-first drafts plus adversarial review.
> Scope: a single ranked roadmap for the next ~6-9 months at current scale (50-200 units/mo, 5-7 operators, one connected SKU).

## Competitive landscape

The 2026 ops-software market has bifurcated. On one side are the heavy ERPs — NetSuite, SAP Business One, Odoo, Katana, Cin7 — which assume mid-market headcount and a multi-quarter implementation, and they price accordingly. On the other side are the modular best-of-breed layers — Shopify + ShipBob + ReturnLogic + Klaviyo + QBO + Synder + Zendesk — that bolt onto a DTC stack and run themselves. makeLILA is neither: because the team already owns a typed Supabase schema, a realtime channel layer, an `activity_log` audit spine, and email/SMS plumbing, most leverage from the modular tier is reachable as a hundred lines of edge-function or a single migration — but only when we treat those external tools as event sinks, not systems of record. The discipline documented in [docs/system-of-record.md](docs/system-of-record.md) is the right posture; the gap is acting on it consistently.

In CRM and lifecycle marketing, the canonical 2026 stack is HubSpot or Klaviyo carrying customer state, with a Customer 360 timeline as the primary triage view (Kustomer, Plain, Front). Klaviyo specifically has matured into a usable predictive layer (CLV, expected next order, churn risk) that is more reliable for a 200-customer base than any homegrown formula. Borrow the event-firehose pattern and the predictive properties (one-way pull, no journey rewrites in-app); ignore the conversation-merging architectures, which require rewriting Quo and Gmail integrations for marginal triage benefit.

Service and field-ops software (Salesforce Field Service, Aquant, Zendesk, ServiceWorks) all converge on the same hardware-shaped primitives: a device record joined into every ticket, an SLA clock with automated escalation, a warranty registration as its own entity, and parts kits with kit serials. Field Service Lightning is overkill — it assumes dispatched techs we do not have — but the primitives map cleanly to our depot-only model. The 2026 best practice is also telemetry-to-ticket auto-creation: a connected appliance with persistent error states should open its own ticket. That is the single largest unrealized leverage point given Dashboard already classifies seven telemetry states per unit.

In ERP, fulfillment, and finance, the durable patterns are the daily-summary journal sync into QBO (Synder, A2X), the RMA quarantine-and-grade state machine (ReturnLogic, Loop), and per-currency ledger discipline. Big-MES patterns — Tulip station passes, Critical Manufacturing genealogy, 21 CFR Part 11 — are tempting but unwarranted for one SKU at our volume. The 80/20 is to promote existing implicit fields (station passes, freight quotes, refund methods) into queryable rows and feed downstream tools from those rows on a scheduled job rather than per-event. That keeps makeLILA the system of record and keeps the integration code understandable by one engineer reading the repo on a Sunday.

## P1 — Next 90 days

These initiatives are either prerequisites for everything else, finish in-flight work whose absence is causing operator pain weekly, or eliminate a current silent-failure mode.

### 1. Klaviyo Track API event firehose

**Problem.** Klaviyo is wired for email broadcasts only. Every operational state change — `unit_shipped`, `replacement_shipped`, `return_received`, `refund_approved`, `service_ticket_resolved` — lives in Supabase and never reaches Klaviyo, so customer-facing comms cannot branch off internal reality. Dashboard telemetry classifications never surface to the customer at all.

**Proposal.** Ship a Supabase edge function `klaviyo-track` that accepts `{customer_email, event_name, properties}` and POSTs to Klaviyo's Track API. Extend `logAction()` in [lib/activityLog.ts](app/src/lib/activityLog.ts) with an optional `klaviyo_event` argument — when set, the same call that writes `activity_log` also fires the event. Bootstrap with eight events: `unit_shipped`, `unit_delivered`, `service_ticket_opened`, `service_ticket_resolved`, `replacement_shipped`, `refund_approved`, `journey_stage_changed`, `telemetry_status_changed`. Add `customers.klaviyo_profile_id` populated lazily on first event. Klaviyo owns branching; no journey-builder UI in app.

**Touches.** [lib/activityLog.ts](app/src/lib/activityLog.ts), [lib/fulfillment.ts](app/src/lib/fulfillment.ts), [lib/service.ts](app/src/lib/service.ts), [lib/postShipment.ts](app/src/lib/postShipment.ts), [lib/customers.ts](app/src/lib/customers.ts), [lib/dashboard.ts](app/src/lib/dashboard.ts), new `supabase/functions/klaviyo-track/index.ts`, migration `customers_add_klaviyo_profile`.

**Effort.** S. **Inspired by.** Klaviyo Track API + Customer.io event-driven engineering model (lifecycle/finance research). **Sequencing.** Ships first because every other initiative below benefits from chaining to a customer event.

### 2. Telemetry-driven service-ticket auto-creation

**Problem.** Dashboard already classifies units into seven states (DRY_SOIL, SOAKED_SOIL, NEW_FOOD, NOT_MIXING, OPEN_LID, NO_BME_DATA, DIAGNOSE, OK), but no rule converts a persistent non-OK state into a Service ticket or a customer-facing nudge. This is the single largest "we already have the signal, we just don't act on it" gap in the codebase — and exactly what Aquant and Salesforce Field Service charge five figures a year to enable.

**Proposal.** Add a pg_cron job `telemetry_ticket_autocreate` running every 30 minutes. It queries the Dashboard classifier output for units where the same non-OK state has held for N hours (DIAGNOSE = 6h, NO_BME_DATA = 24h, DRY_SOIL/SOAKED_SOIL/NOT_MIXING = 48h). For each, if no open `service_tickets` row exists for that unit with `source = 'telemetry_auto'`, insert one with priority P2, classification from the Dashboard enum, and a system-comment linking back. Fire `telemetry_status_changed` in parallel. Operator override: a `telemetry_autoticket_suppress` flag for known beta participants.

**Touches.** [lib/service.ts](app/src/lib/service.ts), [lib/dashboard.ts](app/src/lib/dashboard.ts), [lib/supabaseTelemetry.ts](app/src/lib/supabaseTelemetry.ts), new `supabase/functions/telemetry-ticket-autocreate/index.ts`, migration `service_tickets_add_source_and_suppress`.

**Effort.** M. **Inspired by.** Aquant + Peloton/Rachio connected-asset alerting; reviewer-flagged missing initiative. **Sequencing.** Depends on Initiative 1 to fire the Klaviyo event; ticket creation works standalone.

### 3. Device-record join header on every Service ticket

**Problem.** Service tickets carry `unit_serial` but the UI does not surface firmware version, latest QC station results, latest telemetry classification, or repair history. Agents open Stock, Dashboard, and Build in parallel tabs to triage a single ticket. Closing this gap also grounds future AI-drafted replies and is a prerequisite for Initiative 2's auto-created tickets to be triage-ready.

**Proposal.** Build a `DeviceContextHeader.tsx` rendered at the top of [Service/SupportTickets](app/src/modules/Service) and Repair detail panels. It joins [units](app/src/lib/stock.ts) (existing `firmware_version`, `electrical_check`, `mechanical_check`, `defect_notes`, `technician`, `batch_id`), the latest telemetry classification from the second Supabase project via the existing [lib/supabaseTelemetry.ts](app/src/lib/supabaseTelemetry.ts) helper, and counts of prior `service_tickets` and `returns` for the same `unit_serial`. Add a `useDeviceContext(unit_serial)` hook in [lib/service.ts](app/src/lib/service.ts). Chips: firmware (green if current, amber N-1, red older), telemetry state (mirrors Dashboard enum), open-tickets-this-unit count, in-warranty badge once Initiative 7 lands.

**Touches.** [lib/service.ts](app/src/lib/service.ts), [lib/stock.ts](app/src/lib/stock.ts), [lib/supabaseTelemetry.ts](app/src/lib/supabaseTelemetry.ts), [modules/Service](app/src/modules/Service), new `app/src/components/DeviceContextHeader.tsx`.

**Effort.** M. **Inspired by.** Salesforce Field Service Asset object + Aquant device-context diagnosis. **Sequencing.** No prerequisites; visible payoff immediately after ship.

### 4. Finish Returns & Refunds overhaul — grade, disposition, responsible team, quarantine

**Problem.** Backlog #2 has refund_method, finance_review FSM, and approver gates already in [lib/postShipment.ts](app/src/lib/postShipment.ts) (refund_method enum, MANAGER_EMAILS, FINANCE_EMAILS, approveRefund, denyRefund, finance_review state). What is missing is the physical-disposition half: grade (A_resale / B_refurbish / C_secondary / D_scrap), disposition (restock / refurbish / RTV / scrap / parts_harvest), inspection findings, responsible_team, and the quarantine-receiving-location ATP gate. Without these, returned units silently re-enter available stock and finance cannot roll up loss-on-return.

**Proposal.** Add to `returns`: `grade`, `disposition`, `responsible_team`, `inspection_findings`, `inspection_photos jsonb`, `recoverable_value_usd`, `received_at`, `inspected_at`, `inspected_by`. Extend `units.status` enum with quarantine and grade values; default Fulfillment queue queries to exclude them. Build a `PostShipment/InspectionPanel.tsx` that requires scan-verified serial + grade + disposition + responsible_team before the existing refund-approval gate unlocks. Static auto-suggest map (`Product Defect → manufacturing`, `Shipping Damage → shipping`, etc.) is operator-overridable. Add a reason × responsible_team Pareto tile and a Grade Distribution tile to the existing ReturnDashboard. Closes backlog #2 and #79 in one migration window.

**Touches.** [lib/postShipment.ts](app/src/lib/postShipment.ts), [lib/stock.ts](app/src/lib/stock.ts), [modules/PostShipment](app/src/modules/PostShipment), new `modules/PostShipment/InspectionPanel.tsx`, migrations `returns_add_disposition`, `units_status_quarantine`.

**Effort.** M. **Inspired by.** ReturnLogic grade/disposition + responsible-team Pareto; reviewer-flagged backlog #79. **Sequencing.** Lands before Initiative 5 (QBO sync) so refund and disposition data is trustworthy.

### 5. QBO daily-summary journal sync

**Problem.** QuickBooks Online sync is manual. Per-order push hits API caps, miscodes Sezzle/Shop Pay/Canadian marketplace facilitator tax, and partial-refund-with-replacement gets double-counted. Reconciliation eats George's Mondays. Payment-summary fields are already on `orders` (migration `20260526120000_orders_payment_summary.sql` shipped `subtotal_usd`, `tax_usd`, `discount_total_usd`, `payment_methods`, `financial_status`) so the source data exists.

**Proposal.** Add `qbo_daily_journals` (date, currency, payment_channel, gross_sales, discounts, refunds, tax_collected, shipping, fees, net_deposit, qbo_journal_id, posted_at). Nightly scheduled function `qbo-daily-summary` aggregates the day's orders + refunds + Sezzle payouts grouped by `(currency, payment_channel)`, posts one journal entry per group via QBO OAuth2. Finance tab in PostShipment shows the last 30 days with Repost and View-in-QBO buttons. Replacement orders (the `$0 draft order tagged 'replacement'` pattern) are excluded from revenue and routed to a `warranty_reserve` GL account.

**Touches.** new [lib/finance.ts](app/src/lib/finance.ts), new `modules/PostShipment/FinanceTab.tsx`, new `supabase/functions/qbo-daily-summary/index.ts`, migration `qbo_daily_journals`.

**Effort.** M. **Inspired by.** Synder / A2X daily-summary journal pattern; explicitly rejects buying Synder ($50/mo) because the aggregation SQL is forty lines and we want the rules in the repo. **Sequencing.** Depends on Initiative 4 for clean refund disposition data.

### 6. PaymentCard UI on OrderReview detail

**Problem.** Backlog #4 financial columns are on `orders` but no detail-panel UI surfaces them. Operators re-open Shopify to confirm subtotal, tax, shipping, and discount before approving an order or processing a partial refund — a friction point that compounds the Initiative 4 and 5 flows.

**Proposal.** Add a read-only `PaymentCard.tsx` to OrderReview detail rendering subtotal_usd, tax_usd, discount_total_usd, total, currency, payment_methods (as chips), financial_status. Pure UI on top of existing columns; no migration. Insert-only on conflict per [docs/system-of-record.md](docs/system-of-record.md) — never overwrites operator edits.

**Touches.** new `app/src/modules/OrderReview/detail/PaymentCard.tsx`, [lib/orders.ts](app/src/lib/orders.ts) (type extension only if needed).

**Effort.** S. **Inspired by.** lifecycle/finance research payment-method split; reviewer downscope of MVP-6 to "UI on top of existing columns." **Sequencing.** Can ship anytime in P1; pairs naturally with Initiative 5.

### 7. Warranty registration as a first-class entity

**Problem.** Coverage today is reconstructed each ticket from Shopify order date plus tribal knowledge. Refund and replacement decisions are inconsistent across operators, there is no defensible record of coverage tier, and the current replacement pattern (refund + new order) silently extends "lifetime warranty via serial-chain abuse" because nothing tracks that a replaced unit inherits the original coverage clock.

**Proposal.** New `warranty_registrations` (id, unit_serial unique FK, customer_id FK, original_order_id FK, coverage_tier default `standard_1y`, coverage_start, coverage_end computed, parent_registration_id nullable, voided_reason, registered_at, registered_by). Auto-create on Fulfillment completion. Add `service_tickets.warranty_registration_id` FK and `coverage_state` computed at read time. Render a warranty badge in the device-context header and on Customers/JourneyTab. Replacement flow writes a child registration with `parent_registration_id` set and `coverage_tier='replacement_no_warranty'` — closing the chain-abuse vector. Even with a single-tier policy today, the entity is small and unlocks future tier changes without retroactive data work.

**Touches.** new [lib/warranty.ts](app/src/lib/warranty.ts), [lib/service.ts](app/src/lib/service.ts), [lib/fulfillment.ts](app/src/lib/fulfillment.ts), [lib/postShipment.ts](app/src/lib/postShipment.ts), [modules/Service](app/src/modules/Service), [modules/Customers](app/src/modules/Customers), migration `warranty_registrations`.

**Effort.** S. **Inspired by.** ServiceWorks / InsightPro warranty-as-entity pattern; explicitly rejects the customer-facing registration portal. **Sequencing.** Lands alongside Initiative 3 (the badge wants the header to live in).

### 8. SLA aging + auto-escalation on Service tickets

**Problem.** Service tickets have priority and owner but no SLA clock. A P1 ticket sitting unassigned over a long weekend is indistinguishable from a P1 being actively worked. Customers escalate by emailing support@ for the third time or charging back — both of which we discover after the fact.

**Proposal.** Add `service_tickets.sla_policy_id` FK to `sla_policies` (priority, first_response_minutes, resolution_minutes, escalate_to_user_id). Compute `first_response_due_at` and `resolution_due_at` on create. pg_cron `sla_aging_check` runs every 15 minutes, sets `sla_status` (ok / warning / breached), writes an `activity_log` entry on breach, auto-bumps priority by one level, notifies owner plus George. Defaults: P1 = 1h / 24h, P2 = 4h / 72h, P3 = 24h / 7d. UI: SLA chip plus sortable "time to breach" column.

**Touches.** [lib/service.ts](app/src/lib/service.ts), [modules/Service](app/src/modules/Service), new `supabase/functions/sla_escalation_notify/index.ts`, migration `sla_policies_and_service_tickets_sla`.

**Effort.** M. **Inspired by.** Zendesk SLA triggers; explicitly rejects the full no-code trigger/automation/macro builder. **Sequencing.** Independent of other P1 items; can run parallel.

## P2 — Next 2 quarters

### 9. Promote build_station_passes from columns to event rows

**Problem.** `units` already has `electrical_check`, `mechanical_check`, `defect_notes`, `firmware_version`, `technician` (migration `20260527180000_units_qc_fields.sql`). What it cannot do is preserve rework attempts, capture station-level photos, support per-station defect categorization, or answer "first-pass yield by station this week." The existing columns serve a single attempt per unit; the moment a unit is reworked, the old result is overwritten.

**Proposal.** New `build_station_passes` (id, unit_serial FK, station enum, pass_status `pass`/`fail`/`incomplete`/`rework`, attempt_seq, defect_category, defect_notes, technician_id, firmware_version, photo_urls jsonb, created_at). The existing `units` QC columns become a denormalized view of latest pass per station. Build module gets a `StationPassLogger.tsx` panel with mobile-friendly buttons and Supabase Storage photo upload. New `BuildQCDashboard.tsx` view: defects by station, by technician, first-pass-yield trend.

**Touches.** [lib/build.ts](app/src/lib/build.ts), [modules/Build](app/src/modules/Build), [lib/stock.ts](app/src/lib/stock.ts), new `modules/Build/StationPassLogger.tsx` and `BuildQCDashboard.tsx`, migration `build_station_passes`.

**Effort.** M. **Inspired by.** Tulip station-pass MES pattern. **Sequencing note.** Wait for Initiative 4 to ship so we are not racing two migrations on the same `units.status` enum.

### 10. Klaviyo predictive properties mirrored back to customers

**Problem.** Klaviyo computes EDNO, predicted CLV, and churn risk natively and on richer data than we would produce ourselves. Operators in makeLILA never see those values, so cannot sort "at-risk customers" or trigger a manual check-in.

**Proposal.** Nightly Supabase scheduled function `klaviyo-pull-predictive` GETs Klaviyo profiles by email and writes back to `customers`: `predicted_clv`, `expected_next_order_date`, `churn_risk_pct`, `klaviyo_last_synced_at`. Surface as three chips on Customers/JourneyTab plus a "churn risk > 60%" filter chip. Explicitly chosen over building a homegrown 0-100 health score: Klaviyo's training data is richer, and we can layer custom signals later only if the predicted-churn signal proves weak in practice. Reviewer correctly flagged that the multi-input weighted health-score proposals were numerology without validation cohorts; this is the cheaper, more honest substitute.

**Touches.** [lib/customers.ts](app/src/lib/customers.ts), [modules/Customers](app/src/modules/Customers), new `supabase/functions/klaviyo-pull-predictive/index.ts`, migration `customers_add_predictive`.

**Effort.** S. **Inspired by.** Klaviyo predictive analytics as filterable segment properties. **Sequencing.** Depends on Initiative 1 having populated `klaviyo_profile_id`.

### 11. Freight quote history child table + best-rate chip

**Problem.** `orders.freight_estimate_usd` and `freight_estimate_source` exist (migration `20260604350000`), but each ClickShip / Freightcom re-quote overwrites the previous value. Operators cannot answer "what did we quote on this order three days ago" without re-running the call, and there is no rate-shop history for negotiation or vendor-performance review.

**Proposal.** New `freight_quotes` child table (order_id FK, provider enum `clickship`/`freightcom`, service_level, rate_cad, rate_usd, transit_days, quoted_at, selected bool, raw jsonb). Wrap the existing ClickShip and Freightcom calls behind [lib/freight.ts](app/src/lib/freight.ts) so every quote pull inserts a row. Keep the winner on `orders.freight_estimate_usd` for backwards compatibility. "Re-quote" action inserts new rows, never updates. Best-rate chip on OrderReview row reads latest `selected=true`. Does not change vendors — ClickShip's negotiated CA pricing stays intact.

**Touches.** new [lib/freight.ts](app/src/lib/freight.ts), [lib/orders.ts](app/src/lib/orders.ts), [modules/OrderReview](app/src/modules/OrderReview), migration `freight_quotes`.

**Effort.** S. **Inspired by.** EasyPost rate-shop pattern; explicitly rejects swapping vendors. **Sequencing.** Independent.

### 12. Activity-log entity refs + per-serial timeline

**Problem.** `logAction()` captures actor and action_type but lacks stable `entity_type` and `entity_id` columns plus a denormalized `unit_serial`. So "show me everything that ever happened to serial X" requires text-pattern matching across `details`. This also blocks the per-operator throughput dashboard the reviewer flagged as a missing initiative.

**Proposal.** Extend `activity_log` with `entity_type` (enum: order, unit, return, ticket, build_station_pass, depot_repair, warranty_registration, customer, parts_kit_shipment), `entity_id`, `unit_serial` (denormalized for query speed), and a unique index on `(entity_type, entity_id, created_at)`. Update `logAction()` signature to accept entity refs; existing call sites stay working (new fields nullable). Build a `UnitTimeline.tsx` used in Stock/UnitDetail and inside the device-context header (Initiative 3). Skip the before/after JSON wrapping the risk-draft proposed — reviewer correctly flagged that as materially more invasive than scored, and a Postgres trigger writing to a sibling audit table is the cleaner architecture if we later need full diffs.

**Touches.** [lib/activityLog.ts](app/src/lib/activityLog.ts), [modules/Stock](app/src/modules/Stock), [modules/ActivityLog](app/src/modules/ActivityLog), new `app/src/components/UnitTimeline.tsx`, migration `activity_log_entity_refs`.

**Effort.** S. **Inspired by.** Tulip eDHR shape, downscoped. **Sequencing.** Best after Initiative 9 so build station passes flow through the new shape on day one.

### 13. RBAC profiles + canDo helper

**Problem.** `MANAGER_EMAILS` and `FINANCE_EMAILS` are hardcoded arrays in [lib/postShipment.ts](app/src/lib/postShipment.ts). Initiatives 4 (disposition gating), 7 (warranty voiding), and any future approval surface compound that pattern. The audit story is also weak: there is no `profiles.role` to filter activity-log entries by.

**Proposal.** Add `profiles.role` enum (`operator`, `manager`, `finance`, `admin`) seeded from current `MANAGER_EMAILS` / `FINANCE_EMAILS`. Central `canDo(role, action)` helper in a new [lib/permissions.ts](app/src/lib/permissions.ts). Replace email-list checks with role checks across [lib/postShipment.ts](app/src/lib/postShipment.ts). Reviewer-flagged missing initiative.

**Touches.** new [lib/permissions.ts](app/src/lib/permissions.ts), [lib/postShipment.ts](app/src/lib/postShipment.ts), [lib/auth.tsx](app/src/lib/auth.tsx), migration `profiles_add_role`.

**Effort.** S. **Inspired by.** Standard RBAC pattern; reviewer concern. **Sequencing.** Lands before any new approval surface (so before Initiatives 4 finalizes the gating UI ideally, or as part of the same migration window).

## P3 — Strategic, conditional pickup

These are items we considered carefully and chose to defer. Each entry names the conditions that would justify revisiting.

### 14. Unit-to-component-lot genealogy

A `unit_component_lots` table linking shipped serials to incoming auger / motor / BME / PCB / firmware lots, with forward and reverse queries powering a Stock/RecallSearch page. Deferred because supplier-lot recalls have happened zero times, lot codes would have to be entered at receiving by people in China not in makeLILA today, and the migration is large. Revisit on: one actual recall, volume crossing 500/mo, or a second SKU with supplier-quality variance.

### 15. Unified customer timeline across 9+ sources

A materialized view UNION-ing activity_log, orders, returns, replacements, service_tickets, support_messages, sms, gmail, and cross-project telemetry. Foreign data wrappers alone are multi-week. We get most of the value from Initiative 3 plus Initiative 12. Revisit on: customer count crossing 1000, or a dedicated CX role joining who would live in that view full-time.

### 16. Per-unit COGS view

Parts cost + inbound freight + outbound freight + warranty reserve - recovered value, surfaced as a margin chip on OrderReview. Depends on Initiative 14 and would be best-effort for every pre-substrate unit. Revisit on: Initiative 14 shipping and accumulating six months of populated rows, or finance audit pressure making per-unit margin a board metric.

### 17. Customer-facing portal (warranty registration, RMA self-service, status)

Internal hardening precedes external surface. Revisit on: alpha-feedback window closing cleanly, "where is my order" volume exceeding 20/week, and Initiatives 3 and 7 operating without churn for a quarter.

## Explicit out-of-scope

- **Replace makeLILA with NetSuite / SAP B1 / Odoo / Katana / Cin7.** At 50-200 units/mo the licensing plus implementation cost exceeds the entire ops headcount budget, and every research domain agreed independently.
- **Salesforce Field Service Lightning or Aquant install.** Built for fleets of dispatched technicians; VCycene is depot-only.
- **Full Tulip / eDHR / 21 CFR Part 11 compliance.** Non-regulated consumer hardware; 10x Build UX cost for no compliance return.
- **In-app workflow editor (n8n-style GUI for rules).** Klaviyo plus Supabase scheduled functions cover all 90-day automation needs; SQL seed tables are simpler than a GUI builder at team size 5-7.
- **Per-order Shopify-to-QBO sync (manual or Synder/A2X install).** Daily-summary journal (Initiative 5) gives better grouping control at zero vendor cost.
- **Bidirectional Shopify two-way sync (backlog #6 beyond payment fields).** Risks clobbering operator-curated data and conflicts with the system-of-record discipline already documented; payment fields are the only "always-safe" piece worth shipping.
- **Homegrown weighted customer health score.** Klaviyo's predictive model (Initiative 10) is trained on richer data; weights chosen without a validation cohort become operator wallpaper within a sprint.
- **Conversation-merging omnichannel inbox across Gmail + OpenPhone + Resend.** Quarter-long rebuild of the messaging spine for marginal triage benefit over the per-serial timeline + device-context header.

## Suggested ordering

The numbering reflects dependency, not calendar — several pairs can run in parallel if a second engineer is available.

1. **Initiative 1 — Klaviyo Track API firehose.** Days of work. Unblocks all later customer-event chaining (Initiatives 2, 4, 5, 7, 10).
2. **Initiative 6 — PaymentCard UI on OrderReview detail.** Days of work, no migration. Validates the existing payment columns are populated and gives operators an immediate visible win while substrate work proceeds.
3. **Initiative 13 — RBAC profiles + canDo helper.** Lands before any new approval surface so Initiative 4's gating code is written against `canDo()` from the start rather than refactored later.
4. **Initiative 4 — Returns disposition + grade + quarantine.** Closes the active backlog #2 work plus #79 in one migration window. Depends on Initiative 13 for clean approver gating; unblocks Initiative 5 (clean refund data) and Initiative 9 (shared `units.status` enum migration window).
5. **Initiative 7 — Warranty registration entity.** Small migration, no upstream dependencies, but the badge wants the device-context header to render in — so sequenced with Initiative 3.
6. **Initiative 3 — Device-context header on Service tickets.** Hosts the warranty badge from Initiative 7 and the telemetry status from Initiative 1 / Initiative 2. Reads only from existing tables plus the telemetry project; ships without further migrations.
7. **Initiative 2 — Telemetry-driven service-ticket auto-creation.** Depends on Initiative 1 (Klaviyo event) and Initiative 3 (so auto-created tickets are immediately triage-ready). Highest-leverage hardware-specific automation in the proposal.
8. **Initiative 8 — SLA aging + auto-escalation.** Parallelizable with Initiatives 3, 5, 7 once Initiative 2 is producing the ticket volume that makes SLA discipline matter.
9. **Initiative 5 — QBO daily-summary journal.** Depends on Initiative 4 for clean refund disposition data and on Initiative 6 / existing payment columns. Run after both have stabilized for two weeks.
10. **Initiative 9 — build_station_passes promotion.** P2 priority. Best after Initiative 4 to avoid racing `units.status` enum migrations; pairs naturally with Initiative 12 (activity-log entity refs) so the new station-pass rows flow through the new audit shape on day one.
11. **Initiative 12 — Activity-log entity refs + per-serial timeline.** Runs alongside Initiative 9.
12. **Initiative 11 — Freight quote history.** Independent; fits between larger sprints whenever an operator has a quiet week.
13. **Initiative 10 — Klaviyo predictive properties pull.** Depends on Initiative 1 having populated `klaviyo_profile_id` across the customer base. P2 polish.

Initiatives 14-17 remain P3 with the conditions above. P1 is six to eight weeks of focused engineering plus operator-side testing; P2 adds another six to eight weeks. The proposal contains zero new modules, zero new vendors, and zero rebuilds of working code — every initiative extends an active backlog item, fills a reviewer-flagged gap, or wraps an existing edge function with a child table.
