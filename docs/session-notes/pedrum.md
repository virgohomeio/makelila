# Pedrum — Session Notes for makeLILA Shipping

> Reference for Pedrum's Claude Code sessions. Owner: Sales + Pre-sale modules only.
> Read this at session start. Each feature below is a complete shipping brief.
> Last updated 2026-06-06 (PRD v1.2 / interactive review v1.4.1).

## Quick links
- PRD: `docs/PRD-2026-06-06.md`
- Competitive proposal: `docs/competitive-landscape-and-proposal-2026-06-06.md`
- Feature backlog: `docs/feature-backlog-alpha-feedback.md`
- System of record: `docs/system-of-record.md`

## Your domain

Pedrum owns the **top-of-funnel and pre-sale surface** of makeLILA: everything that touches a prospect before the unit ships and everything that decides whether the funnel is healthy. Concretely that is `modules/OrderReview/` (only the read-side and freight-quote enrichment — not the operator-curated Fulfillment hand-off), the new `modules/Marketing/` namespace you are about to create (`CampaignsTab.tsx`), `modules/Customers/JourneyTab.tsx` for the pre-sale half of the 10-stage CJM (stages 1–4: lead, qualified, quoted, ordered), and the marketing/lifecycle side of the Klaviyo + HubSpot + Facebook stack. Per §3 of the PRD his weekly flow is: Monday Campaigns review (CAC by channel, last-week spend vs. revenue), Tuesday/Wednesday quote follow-up via OrderReview Pending tab, Thursday lifecycle audit (churn-risk filter on JourneyTab), Friday close-of-week marketing report.

What Pedrum **does not touch**: `modules/Service/` (Aaron — support tickets, onboarding, repair), `modules/PostShipment/` Returns/Refunds/Replacements/Cancellations (Julie + George — these have hard finance gates), `modules/Stock/` and `modules/Build/` (Huayi + ops), and any column or table prefixed `finance_` or routed through the `refund_approvals` table (Finance domain restricted to George + Huayi). If a feature crosses a boundary — for example Feature 1 (Klaviyo Track firehose) extends `lib/activityLog.ts` which Service and PostShipment also write through — make the change additive and non-breaking, ship it behind an optional argument, and call out the cross-cutting nature in the PR description so Aaron and Julie can sanity-check their flows.

## How to start a session

1. `cd e:\Claude\makelila\app` — every npm/supabase command runs from `app/`, never from the repo root.
2. `git pull --rebase origin main` — Huayi is the only other person merging into main right now; expect 1–3 incoming commits per day on weekdays.
3. Re-read `e:\Claude\makelila\CLAUDE.md` and the parent `e:\Claude\CLAUDE.md` (Behavioral guidelines). Then re-read the **Conventions** section of this file.
4. Open the feature brief below for whatever feature is next in dependency order. Don't skip features; the dependency arrows are real (Feature 5 needs profile IDs populated by Feature 1; Feature 6 needs the campaign IDs created in Feature 7).
5. Read the relevant `lib/*.ts` file end-to-end before touching it — they are 200–600 line files and have inline conventions (typed row interface, `useX` hook, `createX/updateX` mutations, every mutation calls `logAction`). Mirror the shape of the closest existing sibling.
6. `npm run dev` (Vite, defaults to http://localhost:5173). Log in with your VCycene Google account. If Supabase env vars are missing, copy `app/.env.example` to `app/.env.local` and pull values from the VCycene Notion access index (project_make_lila memory).
7. Ship in small commits — one migration per commit, one component per commit, one edge function per commit. Each commit should have a green `npm test` and a manual smoke pass. Push to a branch named `pedrum/feature-<N>-<slug>`, open the PR against `main`, request Huayi for review on anything that touches `lib/activityLog.ts`, `lib/customers.ts`, or migrations.

## Conventions to follow

- **CSS Modules, not Tailwind.** Each component has a sibling `Foo.module.css`. Minor inline overrides (`style={{ marginTop: 4 }}`) are fine but anything reusable goes in the module. Match spacing/typography of the closest existing card (e.g. `OrderReview/detail/AddressCard.tsx` is the canonical card pattern).
- **`lib/*.ts` is the data layer.** Components must never `import { supabase } from '../lib/supabase'`. They import `useOrders`, `useCustomers`, `createFreightQuote`, etc. If a query doesn't have a hook yet, add one — don't inline it. Realtime is set up by subscribing to a channel inside the hook's `useEffect`; mirror `useOrders` (lib/orders.ts) for the pattern.
- **Every mutation calls `logAction()`.** This is non-negotiable — the activity log is the audit trail and the source for the Customer Journey timeline. Feature 1 extends `logAction()` itself, so until that's shipped, just use the existing `logAction(actionType, entityType, entityId, payload?)` signature.
- **No AI-summary doc prose.** No "This component is a beautifully designed React component that…". Comments explain *why*, never *what*. PR descriptions are bullet points, not essays. See `docs/feature-backlog-alpha-feedback.md` for tone.
- **Minimum code per `e:\Claude\CLAUDE.md`.** If a feature brief says "S, ~5h" and you're at 300 LOC, stop. No speculative abstractions, no "while I'm here" refactors, no error handling for impossible paths. Surgical changes only.
- **Migrations.** Naming `YYYYMMDDHHMMSS_description.sql` under `app/supabase/migrations/`. Use UTC for the timestamp prefix. Always make schema additive (`ADD COLUMN ... NULL`, never `ALTER COLUMN ... NOT NULL` on an existing populated table without a backfill + default). Never drop a column in the same migration that adds its replacement.
- **Edge functions.** Live under `app/supabase/functions/<name>/index.ts`. Deno runtime. Use `_shared/cors.ts` and `_shared/auth.ts`. Secrets via `Deno.env.get('FOO')`; never log them. Deploy with `supabase functions deploy <name> --project-ref txeftbbzeflequvrmjjr`.
- **Two Supabase projects:** main is `txeftbbzeflequvrmjjr`, telemetry is `arfdopgbvlfmhmcfghhl` (read-only — your features never write to it).

---

## Features (10 total, ~90h)

### Feature 1: Klaviyo Track API event firehose
**Priority:** P1 · **Effort:** S (~5h) · **Tokens:** ~1.2M
**Files to touch:** `app/src/lib/activityLog.ts`, `app/src/lib/customers.ts`, `app/supabase/functions/klaviyo-track/index.ts` (new), `app/supabase/migrations/20260606120000_klaviyo_profile_id.sql` (new)
**Depends on:** Nothing — this is the foundation for Features 5 and 10.

#### Goal
makeLILA's audit trail (`activity_log` table) already records every meaningful state change, but none of it leaves the building. Klaviyo's lifecycle flows (welcome series, post-delivery education, churn-recovery) need server-side event signals because client-side Shopify webhooks don't fire for operator-driven state changes like `replacement_shipped` or `journey_stage_changed`. Wiring `logAction()` to mirror selected actions to Klaviyo's Track API gives marketing a single firehose without scattering Klaviyo SDK calls across modules. Backlog #9.

#### Work to do
- Schema migration: `ALTER TABLE customers ADD COLUMN klaviyo_profile_id text NULL;` and an index `CREATE INDEX idx_customers_klaviyo_profile_id ON customers(klaviyo_profile_id) WHERE klaviyo_profile_id IS NOT NULL;`.
- `lib/activityLog.ts`: extend `logAction()` signature to `logAction(actionType, entityType, entityId, payload?, opts?: { klaviyoEvent?: string })`. When `opts.klaviyoEvent` is present, after the successful `activity_log` insert, fire-and-forget POST to the `klaviyo-track` edge function with `{ event: opts.klaviyoEvent, email, properties }`. Don't await — never block the operator UI on a marketing API.
- New edge function `klaviyo-track/index.ts`: accepts `{ event, email, properties, customer_id? }`. Resolves or lazily creates the Klaviyo profile via `POST /api/profiles/` with email; writes the returned `profile_id` back to `customers.klaviyo_profile_id` if absent. Then `POST /api/events/` with `{ properties: { $event_id: activity_log_id, ... }, metric: { name: event }, profile: { id } }`. Use `Klaviyo-API-Key` header (private key, `revision: 2024-10-15`).
- Bootstrap the 8 events at call-sites: `unit_shipped` (lib/fulfillment.ts `markFulfilled`), `unit_delivered` (lib/postShipment.ts delivery webhook handler), `service_ticket_opened` (lib/service.ts `createTicket`), `service_ticket_resolved` (lib/service.ts `resolveTicket`), `replacement_shipped` (lib/postShipment.ts `shipReplacement`), `refund_approved` (lib/postShipment.ts `approveRefund`), `journey_stage_changed` (lib/customers.ts `setJourneyStage`), `telemetry_status_changed` (lib/dashboard.ts mixing-status watcher).
- Activity log entries: every call already logs; the Klaviyo mirroring is additive — no new action_types.
- Tests: `lib/activityLog.test.ts` add cases for (a) call without `klaviyoEvent` does not invoke fetch, (b) call with `klaviyoEvent` invokes fetch with the right body, (c) fetch failure does not throw.

#### Validation
- Unit tests pass with a mocked `fetch`.
- E2E: ship a test order through Fulfillment, check Klaviyo dashboard → Profiles → search by email → Activity feed shows `unit_shipped`.
- Operator UAT: Pedrum himself — fire each of the 8 events via the relevant module, confirm appearance in Klaviyo within 60s.
- Acceptance criteria: (1) `klaviyo_profile_id` is populated on first event for each new customer; (2) edge function returns 2xx and logs nothing sensitive; (3) `activity_log` continues to insert even if Klaviyo is down (fire-and-forget is correctly non-blocking); (4) no console errors when `VITE_KLAVIYO_*` is unset in dev.

#### Watch-outs
- The edge function path runs in Deno; don't import npm-only Klaviyo SDKs. Use raw `fetch`.
- RLS: `klaviyo_profile_id` write must be allowed from the edge function (service role). Operators should not be able to set it directly from the client.
- Klaviyo rate limit is 350 req/s per account for events; we're nowhere near that, but if you batch backfills, throttle.
- The Shopify-triggered Klaviyo emails Huayi already wired (see `project_klaviyo_integration` memory) use the OAuth PKCE flow. The Track API uses a **separate private API key** — add `KLAVIYO_PRIVATE_API_KEY` as a secret on the main project. Don't reuse the OAuth client secret.

#### Files to load into Claude context at session start
- `app/src/lib/activityLog.ts`, `app/src/lib/activityLog.test.ts`
- `app/src/lib/customers.ts` (mirror typed row + hook pattern)
- `app/supabase/functions/send-template-email/index.ts` (closest existing fetch-to-vendor edge function — mirror the auth/CORS shape)
- Search keyword: `logAction(` to find every call-site to thread the optional arg through

---

### Feature 2: PaymentCard UI on OrderReview
**Priority:** P1 · **Effort:** S (~5h) · **Tokens:** ~0.8M
**Files to touch:** `app/src/modules/OrderReview/detail/PaymentCard.tsx` (new), `app/src/modules/OrderReview/detail/PaymentCard.module.css` (new), `app/src/modules/OrderReview/Detail.tsx` (wire in)
**Depends on:** Nothing — pure read-side feature.

#### Goal
Backlog #4 part 2. Shopify financial breakdown is already synced into `orders` (`subtotal_usd`, `tax_usd`, `discount_total_usd`, `total`, `currency`, `payment_methods`, `financial_status`). Today the operator has to bounce to Shopify to see "did they pay full vs. Sezzle, what discount applied, what's the tax-vs-shipping split". Surfacing this in OrderReview Detail saves ~30s per order and is the prerequisite for Pedrum's CAC + LTV reports downstream.

#### Work to do
- Schema migration: **none**. Columns already exist (verified in `feature-backlog-alpha-feedback.md`).
- `lib/`: **none**. `useOrders` already returns the typed row including these fields. If a field is missing from the TS type, add it to the `OrderRow` interface in `lib/orders.ts` — that is the only library touch.
- UI: new `PaymentCard.tsx` mirroring `AddressCard.tsx` structure (header row, key-value grid, no actions). Render: total + currency big at top, then a 2-col grid for subtotal / discount / tax / shipping, then a row of payment-method chips (one chip per method in the `payment_methods` array — Shopify returns `["shopify_payments"]`, `["sezzle"]`, etc.), then `financial_status` badge color-coded (paid=green, partially_paid=amber, pending=gray, refunded=blue, voided=red).
- Wire into `Detail.tsx` between `LineItemsCard` and `NotesCard`.
- Activity log: no mutations, so no `logAction` calls.
- Tests: vitest snapshot of PaymentCard with three fixtures (full Shopify Payments, Sezzle partial, refunded). Playwright: add one assertion to existing OrderReview e2e that PaymentCard renders the total.

#### Validation
- Unit tests: snapshot stability + a render test for missing currency (should fall back to `USD` not blow up).
- E2E: load `/order-review` → open any order → PaymentCard visible with total > 0.
- Operator UAT: Pedrum spot-checks 5 orders against Shopify admin; numbers must match exactly. Discount sign convention: stored as positive, display with leading `−`.
- Acceptance criteria: (1) renders cleanly when any subset of fields is null; (2) currency formatting respects `currency` column (USD, CAD); (3) no edits possible — read-only per system-of-record.md insert-only rule.

#### Watch-outs
- `payment_methods` is `text[]` in Postgres and arrives as a JS array — don't `.split(',')` it.
- `discount_total_usd` can be 0 or null; treat both as "no discount" and hide the row.
- Don't render `financial_status` as raw enum string; map to human label (`partially_paid` → "Partially paid").
- This is **insert-only sync** from Shopify — never write back. There is no edit UI to build.

#### Files to load into Claude context at session start
- `app/src/modules/OrderReview/detail/AddressCard.tsx` + its `.module.css` (mirror exactly)
- `app/src/modules/OrderReview/detail/LineItemsCard.tsx` (closest sibling for currency formatting)
- `app/src/modules/OrderReview/Detail.tsx` (where to wire it)
- `app/src/lib/orders.ts` (`OrderRow` type)
- `app/src/lib/money.ts` (formatting helpers — reuse, don't reinvent)

---

### Feature 3: Lead attribution fields
**Priority:** P1 · **Effort:** S (~5h) · **Tokens:** ~1.0M
**Files to touch:** `app/supabase/migrations/20260607120000_customer_lead_attribution.sql` (new), `app/src/lib/customers.ts`, `app/src/modules/Customers/JourneyTab.tsx`, `app/supabase/functions/sync-shopify-orders/index.ts`, `app/supabase/functions/sync-hubspot-customers/index.ts`
**Depends on:** Nothing schema-wise. Feature 5 and 6 both read these columns, so do this before them.

#### Goal
Pedrum has no way to answer "where do customers come from" inside makeLILA today. UTM parameters land on the originating Shopify order's `landing_site_ref` or on the HubSpot contact's `hs_analytics_source` but never make it to the customer record. Adding first-touch + last-touch attribution unblocks CAC-by-channel (Feature 6) and CampaignsTab (Feature 8), and gives the Customer JourneyTab a visible "Acquired via Facebook lookalike-Q2-2026" chip that operators can use in conversations.

#### Work to do
- Schema migration:
  ```sql
  ALTER TABLE customers
    ADD COLUMN first_touch_source text NULL,
    ADD COLUMN first_touch_campaign_id text NULL,
    ADD COLUMN first_touch_at timestamptz NULL,
    ADD COLUMN last_touch_source text NULL,
    ADD COLUMN last_touch_campaign_id text NULL,
    ADD COLUMN last_touch_at timestamptz NULL;
  CREATE INDEX idx_customers_first_touch_campaign ON customers(first_touch_campaign_id) WHERE first_touch_campaign_id IS NOT NULL;
  CREATE INDEX idx_customers_last_touch_campaign ON customers(last_touch_campaign_id) WHERE last_touch_campaign_id IS NOT NULL;
  ```
- `lib/customers.ts`: extend `Customer` type with the 6 fields. Add `updateLastTouch(customerId, source, campaignId)` mutation (writes both `last_touch_*` and `last_touch_at = now()`). First-touch is written only at customer-create and never overwritten (insert-only per system-of-record.md).
- Edge function `sync-shopify-orders/index.ts`: when inserting a new customer row, parse `landing_site_ref` for `utm_source`/`utm_campaign` (Shopify stores the referring URL with UTM intact) and populate `first_touch_*` from it. If the order has `landing_site_ref` but no UTM, set `first_touch_source = 'shopify_direct'`.
- Edge function `sync-hubspot-customers/index.ts`: on new contact, map HubSpot's `hs_analytics_source` (`PAID_SOCIAL`, `ORGANIC_SEARCH`, etc.) into `first_touch_source` and `hs_analytics_source_data_1` into `first_touch_campaign_id`. Set `first_touch_at = createdate`.
- UI: `JourneyTab.tsx` — render a chip row above the stage timeline. Two chips: "First touch: facebook · spring-2026-q1" and "Last touch: klaviyo · welcome-series-v3". Null state shows "Attribution unknown" with `color: var(--muted)`.
- Activity log: on `updateLastTouch`, `logAction('customer_last_touch_updated', 'customer', id, { source, campaign_id })`.
- Tests: unit test on the UTM parser (extract function into `lib/customers.ts` as `parseUtm(landingUrl)`); snapshot test on JourneyTab attribution chips.

#### Validation
- Unit: `parseUtm('https://lila.vip/?utm_source=fb&utm_campaign=q2-launch&fbclid=abc')` → `{ source: 'fb', campaign: 'q2-launch' }`.
- E2E: trigger a fake Shopify webhook with a UTM'd landing URL via the staging project; confirm `customers.first_touch_source = 'fb'`.
- Operator UAT: Pedrum opens 10 customer journeys, confirms chips look right for orders he remembers running ads against.
- Acceptance criteria: (1) first-touch never overwritten on subsequent syncs (insert-only); (2) last-touch updates on every Klaviyo click event (wire via Feature 1's firehose in a follow-up — out of scope here); (3) JourneyTab renders chips even when only one of first/last is populated.

#### Watch-outs
- HubSpot's `hs_analytics_source` is an enum (`PAID_SOCIAL`), but Shopify gives free-text UTM source (`facebook`). Don't try to normalize — keep raw strings, normalize at read-time in the Campaigns view (Feature 8).
- A customer can exist before their first order if HubSpot synced them as a lead first. Order priority in the sync: if the customer already has `first_touch_source` set, never overwrite.
- The Shopify `landing_site_ref` can be 2000+ chars — UTM extraction with `new URL()` is fine but wrap in try/catch (malformed URLs exist in production).

#### Files to load into Claude context at session start
- `app/src/lib/customers.ts` (current `Customer` type + hooks)
- `app/src/modules/Customers/JourneyTab.tsx`
- `app/supabase/functions/sync-shopify-orders/index.ts`
- `app/supabase/functions/sync-hubspot-customers/index.ts`
- `docs/system-of-record.md` (insert-only rule for first-touch)

---

### Feature 4: Freight quote history table
**Priority:** P2 · **Effort:** S (~5h) · **Tokens:** ~1.1M
**Files to touch:** `app/supabase/migrations/20260608120000_freight_quotes.sql` (new), `app/src/lib/freight.ts` (new), `app/src/lib/orders.ts`, `app/src/modules/OrderReview/detail/FreightCard.tsx`, `app/src/modules/OrderReview/OrderRow.tsx`
**Depends on:** Nothing.

#### Goal
Backlog #7. Today operators re-quote freight every time they reopen an order and we have zero historical record. This blocks (a) the "is ClickShip cheaper than Freightcom on this lane" answer Pedrum wants for the dedup investigation, and (b) the best-rate-chip on the OrderRow that would save an hour/day of "which carrier did we book?". A child table with insert-only quote history + a selected flag is the minimum change.

#### Work to do
- Schema migration:
  ```sql
  CREATE TABLE freight_quotes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider IN ('clickship','freightcom')),
    service_level text NOT NULL,
    rate_cad numeric(10,2) NULL,
    rate_usd numeric(10,2) NULL,
    transit_days int NULL,
    quoted_at timestamptz NOT NULL DEFAULT now(),
    selected boolean NOT NULL DEFAULT false,
    raw jsonb NOT NULL
  );
  CREATE INDEX idx_freight_quotes_order ON freight_quotes(order_id, quoted_at DESC);
  CREATE UNIQUE INDEX idx_freight_quotes_one_selected ON freight_quotes(order_id) WHERE selected = true;
  ```
- `lib/freight.ts` (new): exports `quoteClickShip(orderId, dest)`, `quoteFreightcom(orderId, dest)`, `selectQuote(quoteId)`, `useQuotes(orderId)`. The two `quoteX` calls hit the existing provider APIs (currently called directly from OrderReview — move that code into `lib/freight.ts`), persist the result via `INSERT INTO freight_quotes`, and return the new row. `selectQuote` sets `selected = true` on the target row and `false` on all siblings.
- `lib/orders.ts`: add `best_freight_quote` virtual field on `OrderRow` (read via a join in `useOrders` — `latest selected=true freight_quote`). Don't denormalize into `orders`.
- UI:
  - `FreightCard.tsx` — render the quote history as a table sorted desc by `quoted_at`, "Select" button per row, current selection highlighted. Keep the existing "Re-quote" buttons; they now insert a new row instead of overwriting.
  - `OrderRow.tsx` — add a freight chip: e.g. "ClickShip $187 CAD · 3d" pulled from `best_freight_quote`.
- Activity log: `logAction('freight_quote_created', 'order', orderId, { provider, rate_cad })` and `logAction('freight_quote_selected', 'order', orderId, { quote_id, provider })`.
- Tests: `lib/freight.test.ts` for the select-flips-siblings logic + unique-selected constraint; Playwright test re-quotes an order and confirms the chip updates.

#### Validation
- Unit: selecting quote B on an order that has A selected results in exactly one `selected=true` row (test against staging Supabase).
- E2E: open an order in Pending tab, hit "Re-quote ClickShip", confirm new row appears in FreightCard table.
- Operator UAT: Pedrum quotes 5 real orders across both providers, confirms history is intact after a reload.
- Acceptance criteria: (1) re-quote never deletes prior rows; (2) unique selected per order enforced at DB level; (3) `raw jsonb` preserves the full provider response for forensic debugging.

#### Watch-outs
- ClickShip rates are CAD-native, Freightcom returns both. Store whichever you get; the chip prefers `rate_cad` when present.
- The `raw` jsonb column will get big over time — fine, but don't `SELECT raw` in the list view.
- The existing ad-hoc quote code in `OrderReview/detail/FreightCard.tsx` calls the providers directly. Move it cleanly into `lib/freight.ts` — don't leave two code paths.

#### Files to load into Claude context at session start
- `app/src/modules/OrderReview/detail/FreightCard.tsx` (existing inline-quote code to extract)
- `app/src/lib/orders.ts` (join pattern for `best_freight_quote`)
- `app/supabase/migrations/20260420300000_post_shipment_tables.sql` (closest precedent for child-table migration shape)
- Search keyword: `clickship` and `freightcom` to find all current call sites

---

### Feature 5: Klaviyo predictive properties pull-back
**Priority:** P2 · **Effort:** S (~5h) · **Tokens:** ~1.2M
**Files to touch:** `app/supabase/functions/klaviyo-pull-predictive/index.ts` (new), `app/supabase/migrations/20260609120000_klaviyo_predictive.sql` (new), `app/src/lib/customers.ts`, `app/src/modules/Customers/JourneyTab.tsx`
**Depends on:** **Feature 1** — needs `customers.klaviyo_profile_id` populated. Wait until at least 50% of customers have a profile ID before deploying this (run a quick `SELECT COUNT(*) FROM customers WHERE klaviyo_profile_id IS NOT NULL` before scheduling the cron).

#### Goal
Klaviyo computes predicted CLV, expected next order date, and churn risk for every active profile. Pulling those nightly into makeLILA gives Pedrum a churn-risk filter on the customer list ("show me everyone over 60% churn risk who has spent over $500") that drives proactive outreach. Backlog item adjacent to #11.

#### Work to do
- Schema migration:
  ```sql
  ALTER TABLE customers
    ADD COLUMN predicted_clv_usd numeric(10,2) NULL,
    ADD COLUMN expected_next_order_date date NULL,
    ADD COLUMN churn_risk_pct int NULL CHECK (churn_risk_pct BETWEEN 0 AND 100),
    ADD COLUMN klaviyo_last_synced_at timestamptz NULL;
  ```
- Edge function `klaviyo-pull-predictive/index.ts`: pages through `GET /api/profiles/?filter=greater-than(properties.predicted_clv,0)&fields[profile]=predicted_clv,expected_next_order_date,churn_risk` 100 at a time. For each profile, `UPDATE customers SET predicted_clv_usd=..., expected_next_order_date=..., churn_risk_pct=..., klaviyo_last_synced_at = now() WHERE klaviyo_profile_id = ?`. Profiles without a matching row are skipped (not all Klaviyo profiles map to customers — some are HubSpot-only leads).
- Schedule via pg_cron in a follow-up migration: `SELECT cron.schedule('klaviyo-predictive-nightly', '0 5 * * *', $$ SELECT net.http_post(url := 'https://txeftbbzeflequvrmjjr.supabase.co/functions/v1/klaviyo-pull-predictive', headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.cron_secret'))); $$);` — mirror `20260512130000_service_pg_cron.sql`.
- UI: `JourneyTab.tsx` — add three chips below the lead-attribution chips from Feature 3: "Predicted CLV $X", "Next order ~Mar 2027", "Churn risk 23%". Color the churn-risk chip green/<30, amber/30–60, red/>60.
- Customers list filter: in `modules/Customers/index.tsx` add a "Churn risk > 60%" filter chip. Reuse the existing filter-chip pattern (look at the Stage filters).
- Activity log: `logAction('klaviyo_predictive_synced', 'customer', id, { previous_churn_risk, new_churn_risk })` only when the values actually changed (avoid log spam).
- Tests: unit test the diff-detection (no-change → no log), snapshot the three chips.

#### Validation
- Unit: changed-value triggers log, unchanged does not.
- E2E: run the edge function manually via `supabase functions invoke klaviyo-pull-predictive`, confirm at least one customer row updated.
- Operator UAT: Pedrum filters by "Churn risk > 60%" + total_spend > $500, expects 10–40 names; spot-checks 3 against Klaviyo profile page.
- Acceptance criteria: (1) function completes a full account scan in under 5 minutes for 10k profiles; (2) no race with Feature 1's profile-id creation (use UPDATE only — never INSERT customers from this function); (3) sync doesn't break when Klaviyo hasn't computed a prediction yet for new profiles (fields are simply NULL).

#### Watch-outs
- Klaviyo's predictive props are only computed for profiles with ≥ 1 order — most leads will have NULL. Don't treat NULL as "low risk".
- Pagination cursor is in the `links.next` field — don't loop on the same URL.
- The cron secret needs to be set via `ALTER DATABASE postgres SET app.cron_secret = '...';` once. Document this in the migration's leading comment.

#### Files to load into Claude context at session start
- `app/supabase/migrations/20260512130000_service_pg_cron.sql` (cron pattern)
- `app/supabase/functions/sync-calendly-events/index.ts` (closest existing "pull from vendor" edge function)
- `app/src/modules/Customers/index.tsx` (existing filter chips)
- `app/src/modules/Customers/JourneyTab.tsx`

---

### Feature 6: CAC by channel view
**Priority:** P2 · **Effort:** S (~5h) · **Tokens:** ~1.1M
**Files to touch:** `app/src/lib/marketing.ts` (new), `app/src/modules/Marketing/CampaignsTab.tsx` (will be expanded by Feature 8 — start the file here), `app/src/modules/Marketing/Marketing.module.css` (new), `app/src/App.tsx` (route)
**Depends on:** **Feature 3** (`first_touch_campaign_id`) and **Feature 7** (`facebook_campaign_metrics`). Don't start until both are merged.

#### Goal
Pedrum's Monday review needs one screen showing "what did we spend per channel last week, and what was the contribution margin of each channel's customers?". CAC = (channel spend) / (new customers attributed). Contribution margin = (revenue − COGS − freight − refunds) / revenue per channel. This is the canonical sales-leadership view.

#### Work to do
- Schema: **none new**. Uses `customers.first_touch_campaign_id` + `facebook_campaign_metrics` (Feature 7) + `orders` totals.
- `lib/marketing.ts`: hook `useCacByChannel(dateRange)` returns rows of `{ channel, spend_usd, new_customers, cac_usd, attributed_revenue_usd, contribution_margin_pct }`. The query is a SQL view — create it in a migration `20260612120000_v_cac_by_channel.sql`:
  ```sql
  CREATE VIEW v_cac_by_channel AS
  SELECT
    coalesce(c.first_touch_source, 'unknown') AS channel,
    sum(coalesce(fcm.spend_usd, 0)) AS spend_usd,
    count(distinct c.id) AS new_customers,
    sum(coalesce(o.total, 0)) AS attributed_revenue_usd,
    ...
  FROM customers c
  LEFT JOIN facebook_campaign_metrics fcm ON fcm.campaign_id = c.first_touch_campaign_id
  LEFT JOIN orders o ON o.customer_id = c.id
  GROUP BY 1;
  ```
  (Refine with date filter parameters; the view above is the shape.)
- UI: `CampaignsTab.tsx` skeleton + a CAC table at top. Columns: Channel, Spend, New customers, CAC, Revenue, CM%. Sort by Spend desc. Date range selector defaults to "last 7 days".
- Route: add `<Route path="/marketing" element={<Marketing />} />` in `App.tsx`. Add a GlobalNav link gated to roles `pedrum` + `huayi` + `george` (mirror how Service tab is gated).
- Activity log: no mutations.
- Tests: snapshot CAC table with three fixture rows.

#### Validation
- Unit: snapshot stable, channel name normalization (e.g. `facebook_lead_ad` and `facebook` collapse to "Facebook") works.
- E2E: navigate to `/marketing`, confirm table renders for last-7-day window without errors.
- Operator UAT: Pedrum cross-checks one Facebook campaign's spend against Meta Ads Manager (same date window). Tolerance ±5%.
- Acceptance criteria: (1) total Spend column ties to Meta dashboard within 5%; (2) new_customers ties to a manual `COUNT(*) FROM customers WHERE created_at > ... AND first_touch_source = 'facebook'`; (3) date range default is "last 7 days" and remembers via URL query param.

#### Watch-outs
- Klaviyo "campaigns" don't have a CAC in the traditional sense (they're lifecycle to existing customers). Show their `spend_usd` as the Klaviyo monthly cost amortized per campaign — or simply hide from the CAC view and put them in Feature 8's broader CampaignsTab. Default: hide here.
- The view will be slow once we have 50k+ customers — add a materialized view + refresh on cron if perf bites.
- HubSpot legacy contacts have `first_touch_source = NULL`. They show as "unknown" — fine.

#### Files to load into Claude context at session start
- The migration from Feature 3 + Feature 7 (must be applied first)
- `app/src/lib/orders.ts` (revenue join shape)
- `app/src/modules/Dashboard/` (closest precedent for chart/table layout)

---

### Feature 7: Facebook Marketing API + Lead Ads webhook
**Priority:** P1 · **Effort:** M (~15h) · **Tokens:** ~3.0M
**Files to touch:** `app/supabase/migrations/20260610120000_facebook_campaign_metrics.sql` (new), `app/supabase/functions/facebook-pull-metrics/index.ts` (new), `app/supabase/functions/meta-lead-webhook/index.ts` (new), `app/src/lib/customers.ts` (lead source enum), `app/src/lib/marketing.ts`
**Depends on:** Feature 1 (Klaviyo firehose) for the lead-nurture event fire.

#### Goal
Two independent integrations packaged together because they share the same Meta auth and approval cycle.
**(a)** Daily metrics pull populates a Postgres table that powers CAC + CampaignsTab + contribution-margin reports. Without it we have no way to compare channel performance.
**(b)** Lead Ads webhook captures Facebook Lead Ad submissions in real time, creates a customer row with `lead_source='facebook_lead_ad'` + attribution, and fires a Klaviyo nurture event so the welcome series starts inside 60 seconds. This is the single largest source of net-new top-of-funnel today and we currently lose half of these to slow manual entry.

#### Work to do
- **Meta access prep (start day 1):** Request System User access token via Meta Business Suite → Business Settings → System Users → Generate Token. Scopes: `ads_read`, `leads_retrieval`, `business_management`. **Lead time: 1–2 weeks for Meta approval.** Cannot ship behind this — start the request the moment you pick up Feature 7.
- Schema migration:
  ```sql
  CREATE TABLE facebook_campaign_metrics (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id text NOT NULL,
    campaign_name text NULL,
    ad_account_id text NOT NULL,
    date date NOT NULL,
    spend_usd numeric(10,2) NOT NULL DEFAULT 0,
    impressions int NOT NULL DEFAULT 0,
    clicks int NOT NULL DEFAULT 0,
    conversions int NOT NULL DEFAULT 0,
    pulled_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (campaign_id, date)
  );
  CREATE INDEX idx_fb_metrics_date ON facebook_campaign_metrics(date DESC);
  ```
- Edge function `facebook-pull-metrics/index.ts`: hits `GET /v20.0/act_{ad_account}/insights?fields=campaign_id,campaign_name,spend,impressions,clicks,actions&time_range={...}&level=campaign&date_preset=yesterday`. Upserts on `(campaign_id, date)`. Schedule daily 06:00 UTC via pg_cron.
- Edge function `meta-lead-webhook/index.ts`: receives Meta's `entry[].changes[].value.leadgen_id` payload. Fetches the full lead via `GET /v20.0/{leadgen_id}?fields=field_data,campaign_id,ad_id,form_id,created_time`. Maps `field_data` (email, phone, full_name) into a new `customers` row with `lead_source='facebook_lead_ad'`, `first_touch_source='facebook'`, `first_touch_campaign_id=campaign_id`, `first_touch_at=created_time`. Calls `logAction('customer_lead_captured', 'customer', new.id, {...}, { klaviyoEvent: 'lead_captured_facebook' })`.
- Webhook verification: Meta sends a GET `hub.challenge` first — respond with the challenge token. Verify subsequent POSTs by HMAC-SHA256 of body with `META_APP_SECRET`.
- Add `lead_source` text column to `customers` if not present (`'facebook_lead_ad','hubspot_legacy','klaviyo_signup','shopify_direct','referral','unknown'`).
- Add the webhook URL to Meta App Dashboard → Webhooks → `leadgen` subscription. URL: `https://txeftbbzeflequvrmjjr.supabase.co/functions/v1/meta-lead-webhook`.
- Tests: vitest for the field_data parser; staged webhook (Meta provides a "Test" button) end-to-end through the edge function.

#### Validation
- Unit: parser handles missing email gracefully, normalizes phone to E.164.
- E2E: trigger Meta's test lead from the App Dashboard → new customer appears in `/customers` within 30s with the right `lead_source` and Klaviyo profile.
- Operator UAT: Pedrum submits a real lead ad with a test email, end-to-end: customer in makeLILA → Klaviyo profile → welcome email received.
- Acceptance criteria: (1) metrics pull runs daily and ties to Ads Manager within 5%; (2) lead webhook end-to-end latency under 60s; (3) duplicate lead submissions (same email within 24h) merge into existing customer row instead of creating duplicates; (4) HMAC verification rejects unsigned POSTs.

#### Watch-outs
- **System User access token has a 1–2 week Meta approval lead time** — start the access request immediately when you pick up this feature. Without it nothing ships.
- Tokens are long-lived but can be revoked from Business Settings; rotate annually and document in the VCycene Notion access index.
- `spend` from Meta is in account currency; if our ad account is USD-denominated we're fine, but verify. If it's CAD, store both `spend_cad` and a converted `spend_usd`.
- Meta retries webhook failures aggressively — make the handler idempotent on `leadgen_id` (UNIQUE constraint or upsert).
- Don't log the `META_APP_SECRET` even in dev — the Supabase edge function dashboard surfaces logs to the team.

#### Files to load into Claude context at session start
- `app/supabase/functions/sync-shopify-orders/index.ts` (closest webhook precedent — Shopify HMAC verification pattern)
- `app/supabase/functions/sync-calendly-events/index.ts` (closest daily-pull pattern)
- `app/supabase/functions/_shared/cors.ts`, `_shared/auth.ts`
- The new schema from Feature 3 (`first_touch_*` columns)
- `app/src/lib/customers.ts` for the `Customer` type

---

### Feature 8: CampaignsTab aggregating FB + Klaviyo + HubSpot
**Priority:** P1 · **Effort:** M (~15h) · **Tokens:** ~3.2M
**Files to touch:** `app/src/modules/Marketing/CampaignsTab.tsx` (expand from Feature 6 stub), `app/src/lib/marketing.ts`, `app/supabase/functions/klaviyo-pull-campaign-metrics/index.ts` (new), `app/supabase/migrations/20260613120000_marketing_campaigns.sql` (new)
**Depends on:** Feature 6 (CAC table layout), Feature 7 (`facebook_campaign_metrics`), Feature 1 (Klaviyo profile mapping).

#### Goal
Single screen showing every campaign across every channel with normalized metrics. Pedrum compares "Klaviyo welcome flow last week" vs "Facebook spring launch ad set" vs "HubSpot quarterly email" on the same axes: reach, engagement (opens/clicks), conversions, revenue, ROAS. Today these live in three vendor dashboards and require manual spreadsheet reconciliation every Monday.

#### Work to do
- Schema: new normalized `marketing_campaigns` table aggregating across providers:
  ```sql
  CREATE TABLE marketing_campaigns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL CHECK (provider IN ('facebook','klaviyo','hubspot')),
    provider_campaign_id text NOT NULL,
    name text NOT NULL,
    started_at timestamptz NULL,
    ended_at timestamptz NULL,
    spend_usd numeric(10,2) NOT NULL DEFAULT 0,
    reach int NOT NULL DEFAULT 0,
    clicks int NOT NULL DEFAULT 0,
    conversions int NOT NULL DEFAULT 0,
    attributed_revenue_usd numeric(10,2) NOT NULL DEFAULT 0,
    last_synced_at timestamptz NOT NULL DEFAULT now(),
    raw jsonb NOT NULL,
    UNIQUE (provider, provider_campaign_id)
  );
  ```
- New edge function `klaviyo-pull-campaign-metrics/index.ts`: pulls `GET /api/campaigns/` + `GET /api/campaign-metrics/` for opens, clicks, recipient count. Upserts into `marketing_campaigns` with `provider='klaviyo'`.
- Backfill `marketing_campaigns` rows for Facebook from existing `facebook_campaign_metrics` via a daily rollup (or create a view).
- HubSpot: only if Pedrum confirms sequences are still active. If they are, hit `GET /marketing/v3/emails/statistics` to populate. If not, skip — Feature 10 will decommission.
- `lib/marketing.ts`: add `useCampaigns(filter)` returning a flat list. Computed columns: `ROAS = attributed_revenue_usd / spend_usd`, `CTR = clicks / reach`, `CVR = conversions / clicks`.
- UI: `CampaignsTab.tsx` — sortable table: Provider chip, Name, Date range, Spend, Reach, Clicks (CTR%), Conversions (CVR%), Revenue, ROAS. Provider filter chips (FB / Klaviyo / HubSpot). Time-window selector.
- Attribution resolution: a campaign's `attributed_revenue_usd` is `SUM(orders.total)` where `customers.first_touch_campaign_id = marketing_campaigns.provider_campaign_id` or `customers.email` was a recipient of that Klaviyo campaign within a 30-day click window. The 30-day rule lives in the rollup logic in `lib/marketing.ts`.
- Activity log: no mutations (read-only view).
- Tests: snapshot the table with 5 fixture rows across all 3 providers; unit test ROAS/CTR/CVR computation.

#### Validation
- Unit: ROAS computes correctly including zero-spend (return null, not Infinity).
- E2E: open `/marketing` → CampaignsTab → filter to Facebook only, confirm ≥1 row.
- Operator UAT: Pedrum's Monday review — runs through with full data, signs off on ROAS values vs. his own spreadsheet (±10%).
- Acceptance criteria: (1) every provider's campaigns appear with normalized columns; (2) ROAS column shows "—" not "Infinity" or "NaN" for zero-spend campaigns; (3) sort by ROAS desc puts top performers at top; (4) re-running the pull is idempotent (UNIQUE constraint).

#### Watch-outs
- The 30-day attribution window is a judgment call — document it visibly in the UI ("Attribution: 30d click").
- Klaviyo campaign IDs are different from Klaviyo flow IDs. Pull only campaigns (one-time sends), not flows (lifecycle). Flow performance is a separate feature.
- HubSpot may be decommissioned by the time you ship this. If `lead_source='hubspot_legacy'` count is dropping toward zero, skip the HubSpot ingestion and let Feature 10 handle the cleanup.
- Don't try to dedupe a customer touched by both FB ad and Klaviyo email — multi-touch attribution is out of scope. First-touch wins for `first_touch_campaign_id` (set at customer creation); subsequent campaigns get conversion credit only if they're the last_touch.

#### Files to load into Claude context at session start
- Feature 6 and Feature 7 outputs
- `app/src/modules/Dashboard/` (table + filter patterns)
- `app/src/lib/orders.ts` (for revenue joins)

---

### Feature 9: Facebook CAPI server-side events
**Priority:** P2 · **Effort:** M (~15h) · **Tokens:** ~2.8M
**Files to touch:** `app/supabase/functions/facebook-capi/index.ts` (new), `app/src/lib/activityLog.ts` (extend hook similar to Feature 1), `app/supabase/functions/sync-shopify-orders/index.ts`
**Depends on:** Feature 1 (the `logAction` opts pattern is the model), Feature 7 (Meta auth + app token).

#### Goal
iOS 14.5+ ATT prompts torch ~40% of client-side Pixel events. Mirroring `Purchase`, `Lead`, `AddToCart`, `InitiateCheckout` through Meta's server-side Conversions API with deduplication keys matching the client Pixel recovers measurable ROAS and re-arms lookalike audiences. This is foundational ad infrastructure — without it Pedrum's Feature 8 ROAS is undercounted by 30–50%.

#### Work to do
- Edge function `facebook-capi/index.ts`: accepts `{ event_name, event_id (= activity_log_id), event_time, user_data: { email_sha256, phone_sha256, fbp, fbc, client_ip, client_user_agent }, custom_data: { value, currency, content_ids } }`. POSTs to `https://graph.facebook.com/v20.0/{pixel_id}/events?access_token={token}` with `data: [...]` array.
- Hash email + phone with SHA-256 lowercase-trimmed before sending (Meta requires this; never send plaintext PII).
- Hook into:
  - `Purchase` — fire from `sync-shopify-orders/index.ts` when a new paid order is inserted (server-side, always fires regardless of client Pixel).
  - `Lead` — fire from `meta-lead-webhook/index.ts` after customer creation (also fire `lead_captured_facebook` Klaviyo event from Feature 7).
  - `AddToCart` / `InitiateCheckout` — these need Shopify storefront webhooks. Subscribe to `checkouts/create` and `checkouts/update` in the existing Shopify integration. Cart events without a customer email use the `fbp`/`fbc` cookies passed through.
- Deduplication: client Pixel sends `event_id = order_id`; CAPI sends the same. Meta dedupes on `(event_name, event_id)`.
- `lib/activityLog.ts`: extend Feature 1's opts to support `capiEvent` similarly. Avoid two parallel mechanisms — one shared firehose with two sinks (Klaviyo, CAPI).
- Activity log entries: `logAction('capi_event_sent', ..., { event_name, response_status })` only on failure (don't spam log on success).
- Tests: hashing function unit test (well-known input → known sha256); idempotency test (same event_id sent twice → Meta accepts both, dedupes server-side).

#### Validation
- Unit: SHA-256 of "user@example.com" matches a hardcoded expected hex.
- E2E: place a test Shopify order → Meta Events Manager → Test Events → see Purchase event with matching `event_id`.
- Operator UAT: Pedrum opens Meta Events Manager's "Match Quality" dashboard 48h after deploy, confirms event match quality ≥ 7/10 and dedup rate > 80% on Purchase.
- Acceptance criteria: (1) Purchase fires within 30s of order paid; (2) email/phone always hashed before send; (3) dedup rate vs. client Pixel > 80% (Meta dashboard); (4) Match Quality score ≥ 7/10.

#### Watch-outs
- **PII handling.** Never log unhashed email/phone, never store raw PII in `activity_log.payload`. The hash happens inside the edge function only.
- Meta requires GDPR-aware fields: `data_processing_options: ["LDU"]` for EU users — out of scope for now (we're North America only), but flag in code comment for future.
- `fbp`/`fbc` cookies come from the storefront — capture them in the Shopify checkout webhook and store in `orders.fb_attribution_data jsonb`. New column needed.
- Don't fire CAPI in development — gate behind `Deno.env.get('FB_CAPI_ENABLED') === 'true'`.

#### Files to load into Claude context at session start
- Feature 1's `lib/activityLog.ts` extension
- Feature 7's Meta auth setup
- `app/supabase/functions/sync-shopify-orders/index.ts`

---

### Feature 10: HubSpot CRM decommission window
**Priority:** P2 · **Effort:** M (~15h) · **Tokens:** ~3.0M
**Files to touch:** `app/supabase/functions/hubspot-export-contacts/index.ts` (new, one-time), `app/supabase/functions/sync-hubspot-customers/index.ts` (retire), `app/supabase/migrations/20260620120000_lead_source_backfill.sql` (new), `lila.vip` lead form templates (out of repo), Klaviyo flow setup (out of repo)
**Depends on:** **Feature 1** (Klaviyo Track firehose live + `customer_created` event firing), **Feature 7** (Facebook Lead Ad webhook capturing what was previously HubSpot's role), Pedrum's explicit confirmation that the active HubSpot sequences are reproducible in Klaviyo flows.

#### Goal
Backlog #11. HubSpot costs ~$X/month and now duplicates what Klaviyo + makeLILA do natively. Decommissioning closes a redundant system-of-record (per `docs/system-of-record.md` makeLILA is canonical — HubSpot was always an input). The window for this is when (a) Klaviyo Track is firing reliably, (b) Pedrum confirms his active sequences (typically Q&A nurture, post-demo follow-up, abandoned-cart reach-out) can be rebuilt as Klaviyo flows, and (c) `lila.vip` lead-capture forms are repointed to either makeLILA's public form (`/cancel-order` precedent) or Klaviyo's hosted form.

#### Work to do
- Export step: edge function `hubspot-export-contacts/index.ts` (one-time, runnable from CLI) pages through `GET /crm/v3/objects/contacts/?properties=email,phone,firstname,lastname,hs_analytics_source,hs_analytics_source_data_1,createdate,lifecyclestage&limit=100`. Writes a JSONL backup to Supabase Storage bucket `legacy-hubspot-backup` then UPSERTs into `customers` with `lead_source='hubspot_legacy'`, `first_touch_source=hs_analytics_source`, `first_touch_campaign_id=hs_analytics_source_data_1`, `first_touch_at=createdate`.
- Sequence rebuild: meet with Pedrum, list active sequences, build equivalent flows in Klaviyo triggered by:
  - `customer_created` (welcome / first-touch nurture)
  - `journey_stage_changed → 'quoted'` (post-quote follow-up)
  - `journey_stage_changed → 'cold'` (re-engagement)
- Forms: repoint `lila.vip` lead capture (currently HubSpot embed) to Klaviyo signup form or makeLILA's public `/lead-intake` (build a thin public form mirroring `modules/Forms/CancelOrderForm.tsx` shape).
- Retire `sync-customers-from-hubspot`: deploy a no-op version that returns 200 + `{ status: 'retired' }` instead of deleting the function (so any leftover webhook calls don't 404). Remove the cron schedule. After 30 days, delete the function.
- Migration `20260620120000_lead_source_backfill.sql`: backfill `lead_source` for existing customers based on `first_touch_source`. NULL → 'unknown'.
- Activity log: `logAction('customer_imported_legacy_hubspot', 'customer', id, { hubspot_id })` per row.
- Tests: dry-run export (don't write to customers, just count) on staging.

#### Validation
- Pre-cut acceptance: (1) backup JSONL exists in Storage; (2) every HubSpot contact has either a `customers` row or is documented as "unmappable" (no email AND no phone); (3) Pedrum has confirmed Klaviyo flows replicate every active HubSpot sequence; (4) lila.vip forms are repointed and a test submission lands in `customers`.
- Post-cut acceptance: (1) `sync-customers-from-hubspot` cron is unscheduled; (2) no new customers created from HubSpot in 7 consecutive days; (3) Pedrum runs his Monday review without HubSpot tab open and finds no gap.
- Final acceptance (30 days post-cut): delete the retired edge function, archive `HUBSPOT_*` secrets, cancel HubSpot subscription.

#### Watch-outs
- **Do not delete the legacy edge function on day 1.** Leave the no-op so any orphaned webhook calls succeed quietly. Delete after 30 days.
- HubSpot contacts can have multiple emails; pick the primary, store secondaries in `customers.alternate_emails text[]`.
- `lifecyclestage` from HubSpot loosely maps to makeLILA's 10-stage CJM but not 1:1. Default unknown to "lead" stage and let operators correct manually.
- Some HubSpot custom properties (deal value, deal stage) have no direct makeLILA equivalent — export them in the JSONL backup but don't try to import. They are reference only.
- This is **the hardest feature to roll back.** Once HubSpot is decommissioned, lead-form changes propagate slowly. Do the full Pedrum sign-off in writing in `docs/feature-backlog-alpha-feedback.md` before flipping the form embeds.

#### Files to load into Claude context at session start
- `app/supabase/functions/sync-hubspot-customers/index.ts` (current sync — the thing being retired)
- `app/supabase/functions/sync-hubspot-tickets/index.ts` (ticket sync — out of scope, leave alone)
- `docs/system-of-record.md`
- `app/src/modules/Forms/CancelOrderForm.tsx` (public form template if building `/lead-intake`)

---

## Quick session start — one-page cheat sheet

```bash
# 1. Navigate + sync
cd e:\Claude\makelila\app
git pull --rebase origin main

# 2. Branch
git checkout -b pedrum/feature-<N>-<slug>

# 3. Confirm env
type .env.local | findstr "SUPABASE KLAVIYO META"

# 4. Boot
npm install              # only if package.json changed
npm run dev              # Vite at http://localhost:5173

# 5. Migrations (if your feature has one)
./node_modules/.bin/supabase migration new <description>
# Edit the generated .sql file under app/supabase/migrations/
./node_modules/.bin/supabase db push --linked

# 6. Edge function (if your feature has one)
mkdir -p supabase\functions\<name>
# Author index.ts; deploy:
./node_modules/.bin/supabase functions deploy <name> --project-ref txeftbbzeflequvrmjjr

# 7. Test
npm test                          # vitest unit
npx playwright test               # e2e (only if relevant)

# 8. Ship
git add -p                        # stage selectively
git commit -m "<feature>: <surgical change>"
git push -u origin pedrum/feature-<N>-<slug>
gh pr create --base main --title "..." --body "..."
```

**Env vars you will need across the 10 features:**
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (already in `.env.local`)
- `KLAVIYO_PRIVATE_API_KEY` (Supabase secret, Feature 1 + 5)
- `META_APP_SECRET`, `META_SYSTEM_USER_TOKEN`, `META_AD_ACCOUNT_ID`, `META_PIXEL_ID` (Supabase secrets, Features 7 + 9)
- `HUBSPOT_PRIVATE_APP_TOKEN` (already set, retiring in Feature 10)
- `FB_CAPI_ENABLED` (env flag, Feature 9 — `true` only in prod)
- `app.cron_secret` (Postgres GUC for pg_cron HTTP calls, Feature 5)

**Project refs:**
- Main: `txeftbbzeflequvrmjjr`
- Telemetry (read-only): `arfdopgbvlfmhmcfghhl`

**Feature dependency order (don't skip):**
`1 → 2 → 3 → 4 → 7 → 5 → 6 → 8 → 9 → 10`

**Stop and ask Pedrum + Huayi when:**
- A feature would touch a table outside `customers`, `orders`, `freight_quotes`, `marketing_*`, `facebook_*`, or `activity_log`.
- A migration would drop or rename a column on a populated table.
- Meta's System User token approval slips past 2 weeks (Feature 7 — escalate so the dependency chain doesn't stall Features 8 + 9).
- Pedrum hasn't sign-off the Klaviyo sequence rebuild before Feature 10's HubSpot decommission flips.
