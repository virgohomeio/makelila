# Product Dashboard + AI Issue Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Dashboard" tab (first in the Products module tab bar) that summarizes critical stats across all 7 shippable product lines, plus a DeepSeek-backed multi-turn chat that lets any team member file a new issue onto a product's issue list conversationally.

**Architecture:** Issue data moves from hardcoded arrays in `data.ts` to a new `product_issues` Supabase table (migration seeds the ~49 existing issues verbatim). A `useProductIssues()` realtime hook in `lib/products.ts` reads that table once at the `Products()` root and feeds live issue lists to both the existing per-product Issues tab (via a render-time merge — `OverviewTab`/`IssuesTab` are untouched) and the new Dashboard tab. A new edge function `product-issue-chat` drives the conversational intake: each turn, DeepSeek replies with strict JSON (`{reply, ready_to_file, issue}`); when ready, the function validates and inserts the row itself (service-role), so the realtime subscription picks it up everywhere with no extra plumbing.

**Tech Stack:** React 18 + TypeScript (Vite), Supabase Postgres + Edge Functions (Deno), Supabase JS client v2.45.0 (frontend uses whatever `app/package.json` pins — currently ^2.103.3), DeepSeek Chat Completions API (`deepseek-chat`, OpenAI-compatible).

**Spec:** [docs/superpowers/specs/2026-07-17-product-dashboard-issue-intake-design.md](../specs/2026-07-17-product-dashboard-issue-intake-design.md)

## Global Constraints

- Deno edge function imports: `https://esm.sh/@supabase/supabase-js@2.45.0`
- Auth: use `authenticate()` from `../_shared/auth.ts` and `corsHeaders` from `../_shared/cors.ts` — same as `reclassify-ticket`
- `product-issue-chat` requires a user JWT (reject `caller.kind !== 'user'`, same as `reclassify-ticket`)
- RLS pattern: `exists (select 1 from public.profiles where id = auth.uid() and is_internal = true)` — matches `kms_pages`
- Valid `product_id` set (7 values, R&D excluded): `'pro' | 'mini' | 'mega' | 'makelila' | 'lovely' | 'shop' | 'marketplace'`
- Valid `severity` set: `'critical' | 'high' | 'medium' | 'low'`
- Secret name: `DEEPSEEK_API_KEY` — Supabase secret, never hardcoded
- DeepSeek endpoint: `https://api.deepseek.com/chat/completions`, model `deepseek-chat`, `response_format: {type:'json_object'}`
- Migration filename convention: `20260717NNNNNN_<name>.sql`
- All lib hooks follow `app/src/lib/kms.ts` / `app/src/lib/activityLog.ts`: named export, typed return, `supabase` imported from `./supabase`
- Components never call `supabase` directly (AGENTS.md convention) — always through a `lib/` function
- CLI commands run from `app/`: `./node_modules/.bin/supabase <subcommand>`
- Vitest commands run from `app/`: `npx vitest run <path>`

---

## File Structure

```
supabase/
  migrations/
    20260717120000_product_issues.sql   ← new: table + RLS + enum value + 49-row seed
  functions/
    product-issue-chat/
      index.ts                          ← new: multi-turn DeepSeek chat + file-on-ready
      index.test.ts                     ← new: unit tests for validateIssue()
app/
  src/
    lib/
      products.ts                       ← new: Issue type, DB mapper, useProductIssues(),
                                            computeFleetStats(), sendIssueChatMessage()
      products.test.ts                  ← new
    modules/
      Products/
        data.ts                         ← modified: Issue type now imported from lib/products;
                                            7 products' `issues:[...]` arrays emptied
        Products.module.css             ← modified: + dashboard grid + chat panel styles
        IssueChatPanel.tsx               ← new
        DashboardTab.tsx                 ← new
        index.tsx                       ← modified: Dashboard tab, live issues, live badges
```

---

## Task 1: Migration — product_issues table + seed data

**Files:**
- Create: `supabase/migrations/20260717120000_product_issues.sql`

**Interfaces:**
- Produces: `public.product_issues` table (columns: `id, product_id, title, severity, tag, team, meta, link, mp_blocker, source, created_by, created_by_name, created_at`); `public.activity_entity_type` enum gains `'product_issue'`

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260717120000_product_issues.sql
--
-- Moves product issue tracking from hardcoded arrays in
-- app/src/modules/Products/data.ts to a live table, so the new Products
-- dashboard and the AI issue-intake chat (product-issue-chat edge function)
-- have one source of truth. Only `issues` moves — BOM/team/PRD/journey/PMF
-- stay static in data.ts (spec: docs/superpowers/specs/2026-07-17-product-dashboard-issue-intake-design.md).
--
-- Seed counts below were recounted directly from the current data.ts arrays,
-- not from the (occasionally stale) badgeCount/KPI text elsewhere in that
-- file — e.g. LILA Pro's badge says "24" but the array has 23 entries, and
-- LILA Mega's KPI strip says "1 open issue" but the array is empty. That
-- drift is exactly the bug this migration fixes: after this, counts shown
-- anywhere in the app are computed from real rows, not hand-typed text.

create table public.product_issues (
  id              uuid        primary key default gen_random_uuid(),
  product_id      text        not null check (product_id in
                    ('pro','mini','mega','makelila','lovely','shop','marketplace')),
  title           text        not null,
  severity        text        not null check (severity in ('critical','high','medium','low')),
  tag             text        not null default 'Other',
  team            text,                    -- accountable person/team, freeform
  meta            text        not null,    -- description body
  link            text,                    -- optional URL
  mp_blocker      boolean     not null default false,
  source          text        not null default 'chat' check (source in ('seed','chat')),
  created_by      uuid        references auth.users(id),
  created_by_name text,
  created_at      timestamptz not null default now()
);

alter table public.product_issues enable row level security;

create policy "internal users can read product_issues"
  on public.product_issues for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_internal = true
    )
  );

-- No insert/update policy: all writes go through the product-issue-chat
-- edge function's service-role client (bypasses RLS) or this seed. There is
-- no client-side insert path.

-- Extend the shared activity_log entity-type enum so chat-filed issues get
-- a normal audit row (entity_type='product_issue'). Not used anywhere in
-- this same migration/transaction — only at edge-function runtime, later —
-- so the "can't use a value added by ALTER TYPE in the same transaction"
-- restriction doesn't apply here.
alter type public.activity_entity_type add value 'product_issue';

-- Seed: verbatim copy of every issue currently hardcoded in data.ts.
insert into public.product_issues (product_id, title, severity, tag, team, meta, mp_blocker, source)
values
-- ── LILA Pro (23 rows) ──────────────────────────────────────────────────
('pro', $t$Inner shell material change$t$, 'critical', $t$DVT$t$, $t$Ben Liang$t$, $t$Current material shows heat distribution issues — thermal expansion causes inner shell to press against outer shell. Alt. material samples arriving Jul 8; must validate thermal expansion coefficients before P100X integration.$t$, false, 'seed'),
('pro', $t$Upon Update, Software Doesn't Start$t$, 'critical', $t$Firmware · STM32$t$, $t$Lezhong$t$, $t$After OTA update firmware fails to start — fans blow near 100%. Only occurs when firmware is absent or not running desired version. (RND_SRC_MainCpu_v5 #50)$t$, true, 'seed'),
('pro', $t$Side Latch Failures$t$, 'critical', $t$Hardware · Latch Mechanism$t$, $t$Ben Liang$t$, $t$Glue-on latches break off during shipping or normal use; moisture degrades adhesive bond. 10 field tickets (7 open, 3 resolved). Required: redesign to integrated snap-fit or screw-mounted mechanical clip; test 500 open/close cycles at 80% RH.$t$, true, 'seed'),
('pro', $t$Lid Switch Redesign — Microswitch → Magnetic$t$, 'critical', $t$Hardware · Lid Interlock$t$, $t$Ben Liang$t$, $t$Contact-based microswitches fail from pin depression and calibration error — causes false lid-open errors. Back-lid microswitch continuously depressed during shipping → 3 confirmed damage cases. Redesign to magnetic induction / Hall-effect lid interlock confirmed Jul 6. Workaround: 1 jumper wire per outgoing unit until fix ships.$t$, true, 'seed'),
('pro', $t$Motor Failures — Prioritize BLDC Replacement$t$, 'critical', $t$Hardware · Drive System$t$, $t$Ben Liang$t$, $t$Chamber motors fail to turn or are installed with incorrect shaft orientation; some fail after weeks of use. 3 field tickets (2 open, 1 resolved). Motor batch delivery date needed before PVT planning can begin — Chen to confirm. Replacement path validated: BLDC motor+gearbox combo (300 RMB / 2 sets) tested on large-machine prototype Jun 2026 — keyed shaft eliminates mis-installation. Target: BLDC swap locked before MP gate.$t$, true, 'seed'),
('pro', $t$On Startup Motors Don't Mix$t$, 'high', $t$Firmware · STM32$t$, $t$Lezhong$t$, $t$Motors sometimes fail to mix on startup; reset fixes it. Possibly AC-power related. (RND_SRC_MainCpu_v5 #48)$t$, false, 'seed'),
('pro', $t$Indefinite Blinking Green During OTA$t$, 'high', $t$Firmware · OTA$t$, $t$Lezhong$t$, $t$OTA should take 25–30 min but blinking continues indefinitely. Possible causes: microswitch disengagement, ESP32 bug, or STM32 bug. (RND_SRC_MainCpu_v5 #36)$t$, false, 'seed'),
('pro', $t$OTA Update Restarts When Back-Lid is Open$t$, 'high', $t$Firmware · P50$t$, $t$Lezhong$t$, $t$Opening back lid during OTA causes update to restart from beginning once lid is re-closed. (P50_v1 #7)$t$, false, 'seed'),
('pro', $t$Composting Control Improvement$t$, 'high', $t$Firmware · Core$t$, $t$Lezhong$t$, $t$Audit and correct composting control implementation. Full review of control loop logic required. (RND_SRC_MainCpu_v5 #56)$t$, true, 'seed'),
('pro', $t$Filter Cup / Screen Breakage$t$, 'high', $t$Hardware · Filtration$t$, $t$Ben Liang$t$, $t$Friction-fit filtration screen breaks off compost chamber during handling or shipping. 4 field tickets (2 open, 2 resolved). Required: redesign attachment with snap-ring, threaded collar, or welded joint; ISTA 3A drop resistance test.$t$, false, 'seed'),
('pro', $t$Shipping / Packaging Damage$t$, 'high', $t$Hardware · Packaging$t$, $t$Ben Liang$t$, $t$Packaging designed for palletized container freight — not individual parcel delivery (FedEx/Canpar/Purolator). 7 field tickets. Required: redesign to ISTA 3A parcel shipping standard; foam cradles for latches, filter cups, trays.$t$, true, 'seed'),
('pro', $t$rH Values Very Low from BME Sensor$t$, 'medium', $t$Firmware · Sensors$t$, $t$Lezhong$t$, $t$When real rH > 60%, measured values drop below 10% and must be compensated. (RND_SRC_MainCpu_v5 #57)$t$, false, 'seed'),
('pro', $t$Excessive Relay Ticking at End of OTA Push$t$, 'medium', $t$Firmware · P50$t$, $t$Lezhong$t$, $t$Excessive ticking noise as soon as "Update AI data" finishes. Occurred 4 times during OTA push testing. (P50_v1 #9)$t$, false, 'seed'),
('pro', $t$No Messages Sent in ERROR State$t$, 'medium', $t$Firmware · P50$t$, $t$Lezhong$t$, $t$Machine does not send MQTT messages when in ERROR state. (P50_v1 #3)$t$, false, 'seed'),
('pro', $t$Signed Image for ESP32 Bin File$t$, 'medium', $t$Firmware · Security$t$, $t$Junaid$t$, $t$Required for SOC 2 Compliance readiness. Firmware binary must be signed before production. (P50_v1 #23)$t$, true, 'seed'),
('pro', $t$Integrate SSL Certificate into ESP32 (MQTT/HTTPS)$t$, 'medium', $t$Firmware · Security$t$, $t$Lezhong$t$, $t$MQTT and HTTPS encryption. WiFi credential upload via POST from Lovely App using ESP32 API. (P50_v1 #20)$t$, false, 'seed'),
('pro', $t$Tray Breakage$t$, 'medium', $t$Hardware · Drip Tray$t$, $t$Ben Liang$t$, $t$Drip trays crack during shipping or first use. 4 field tickets. Required: upgrade material to glass-fiber reinforced PP or ABS; add corner reinforcement ribs; foam cradle in packaging.$t$, false, 'seed'),
('pro', $t$Rusted Fasteners$t$, 'medium', $t$Hardware · Fasteners$t$, $t$Ben Liang$t$, $t$Carbon steel screws corrode within weeks in the moisture-rich composting environment. 2 field tickets. Required: replace ALL fasteners with SS304.$t$, false, 'seed'),
('pro', $t$Lid Closure & Alignment$t$, 'medium', $t$Hardware · Lid System$t$, $t$Ben Liang$t$, $t$Back lid won't close without excessive force; front lid opens on its own due to warping. Required: increase lid alignment tolerance; add front lid magnet or positive-latch.$t$, false, 'seed'),
('pro', $t$Electrical / Cord Issues$t$, 'medium', $t$Hardware · Electrical$t$, $t$Ben Liang$t$, $t$Power cord outer casing damage, PTC heater element failures, LED display not functioning. 6 field tickets (all resolved). Required: strain relief testing; electrical safety check in final QC.$t$, false, 'seed'),
('pro', $t$Missing Components at Shipment$t$, 'medium', $t$Hardware · Assembly QC$t$, $t$Ben Liang$t$, $t$Units shipped without required components: gaskets, water trays, filter cups, gear boxes, starter pellet bags. Required: visual packing verification checklist with photo confirmation.$t$, false, 'seed'),
('pro', $t$Moisture Leakage from Base$t$, 'medium', $t$Hardware · Sealing$t$, $t$Ben Liang$t$, $t$Water leaks from unit base onto customer floors. 4 field tickets. Required: improve base seal design; add secondary drip containment; 48-hour water retention test during QA.$t$, false, 'seed'),
('pro', $t$TÜV Certification Documentation Gaps$t$, 'medium', $t$Hardware · Certification$t$, $t$Ben Liang$t$, $t$Ethan at TÜV requires UL standard numbers and compliance certs for all components. Scope: whole-machine TÜV certification. Action: supplement missing docs, submit revised cert forms. Two machines at TÜV Shanghai facility.$t$, false, 'seed'),
-- ── LILA Mini (7 rows) ──────────────────────────────────────────────────
('mini', $t$Motor-Gearbox Shaft Mismatch$t$, 'critical', $t$EVT · DVT Blocker$t$, $t$Chen Zong / Wang Gong$t$, $t$Round motor shaft (Electrical div.) vs. D-shaped gearbox coupling (Mechanical div.) — physical incompatibility. Parts returned for rework. Root cause: two divisions designed interdependent parts in isolation with no interface control document. New BLDC motor+gearbox assembly (300 RMB/2 complete sets, 1:980–1:1007 ratio) being validated. Blocks DVT gate.$t$, false, 'seed'),
('mini', $t$Dev Board Delayed to Canada$t$, 'critical', $t$EVT · PM$t$, $t$Chen Zong / Wang Yang$t$, $t$Dev board (STM32N6 + peripherals) scheduled to ship week of Jun 23 — not shipped until ~Jun 30. 1-week delay caused Lezhong's firmware work in Canada to stall. Dev board received at BL facility Jul 5; components shipped to Meigongyuan Jul 6.$t$, false, 'seed'),
('mini', $t$Gearbox Processing Precision Failures$t$, 'high', $t$EVT · Supply Chain$t$, $t$Wang Gong / Chen Zong$t$, $t$Gearbox parts failed dimensional QC — returned for rework multiple times. 2–3 week cumulative delay. Backup OEM supplier in Shenzhen Guangming (self-produces gearbox+motor, ~100k units/year) proposed. Chen + Kevin to visit.$t$, false, 'seed'),
('mini', $t$STM32 N6 Firmware Bring-up$t$, 'high', $t$EVT · Firmware$t$, $t$Lezhong Lin / Li Gong$t$, $t$New chip (STM32N6, 178-pin BGA) — limited team N6 experience. Dual-track strategy: dev board for SW debug in Canada; custom Mini board for full bring-up in China. Dev board kit shipped to Meigongyuan Jul 6.$t$, false, 'seed'),
('mini', $t$Lid Microswitch Shipping Damage$t$, 'high', $t$EVT · Hardware$t$, $t$Chen Zong$t$, $t$3 confirmed cases — rear lid presses microswitch continuously during shipping, causing breakage on arrival. Permanent fix: replace with magnetic induction switch — confirmed Jul 6 meeting, same change applied to LILA Pro.$t$, false, 'seed'),
('mini', $t$No Formal BOM$t$, 'medium', $t$EVT · Engineering$t$, $t$Chen Zong$t$, $t$Only informal engineer's list exists — no version control, no traceability. Formal BOM with version numbers must be established from EPT stage. Confirmed as corrective action Jun 29 meeting.$t$, false, 'seed'),
('mini', $t$Prototype 3D Print + Color Spec$t$, 'medium', $t$EVT · Prototype$t$, $t$Chen Zong / Wang Yang$t$, $t$3D printing of all mechanical parts and oil spraying target: complete this week (Jul 6). Prototype assembly target: next week (Jul 13). Color spec: black, silver, white, red — exact match to LILA Pro aesthetics. Needed for crowdfunding video production in Canada.$t$, false, 'seed'),
-- ── makeLILA (1 row) ────────────────────────────────────────────────────
('makelila', $t$PMF Live Dashboard — Link Marketing & Sales Activity to Pro PMF Stats$t$, 'high', $t$Product · PMF$t$, $t$Pedrum$t$, $t$All marketing and sales activity tracked in makeLILA should feed live into the LILA Pro PMF metrics — specifically Organic Conversion rate, Organic Share of Sales, Word-of-Mouth / Referral Rate, and CAC. Pedrum to audit which sales and marketing events are currently logged in makeLILA, define the data fields needed for each PMF dimension, and build the dashboard view that auto-updates the Pro PMF pill from live order/lead data.$t$, false, 'seed'),
-- ── Lovely App (10 rows) ────────────────────────────────────────────────
('lovely', $t$SEC-01: Users UPDATE RLS policy allows self-verify & privilege escalation$t$, 'critical', $t$Software · Security$t$, $t$Ryan$t$, $t$UPDATE RLS policy has no WITH CHECK or column restriction. Any authenticated user can set is_verified = true, rewrite serial_number, or self-grant OTA permission from the browser. (beta-lovely #49)$t$, false, 'seed'),
('lovely', $t$SEC-02: Cross-device IDOR via client-writable serial_number$t$, 'critical', $t$Software · Security$t$, $t$Ryan$t$, $t$Serial-scoped routes resolve device from a client-writable field with no ownership check. Attacker can access any customer's data. Serials are predictable (100,000 combinations). (beta-lovely #50)$t$, false, 'seed'),
('lovely', $t$SEC-03: Onboarding PATCH writes unvalidated serialNumber from request body$t$, 'high', $t$Software · Security$t$, $t$Ryan$t$, $t$PATCH /api/onboarding accepts serial_number from request body via service-role client, bypassing RLS entirely. No format validation or ownership check. (beta-lovely #51)$t$, false, 'seed'),
('lovely', $t$SEC-04: AI rate limiter in-memory per-instance, no spend ceiling$t$, 'high', $t$Software · Security$t$, $t$Junaid$t$, $t$Rate limiter resets on restart and is per-instance. No daily spend ceiling — a single authenticated user can drive uncapped Anthropic costs (15 req/min × 24h). (beta-lovely #52)$t$, false, 'seed'),
('lovely', $t$SEC-06: XSS via javascript: hrefs in chat markdown renderer$t$, 'medium', $t$Software · Security$t$, $t$Ryan$t$, $t$Hand-rolled markdown renderer passes any href to <a> with no scheme allowlist. A prompt-injected javascript: link executes script in the app origin on click. (beta-lovely #54)$t$, false, 'seed'),
('lovely', $t$SEC-07: AI endpoint reachable by unverified accounts$t$, 'medium', $t$Software · Security$t$, $t$Ryan$t$, $t$Chat route requires only serial resolution, not is_verified. Middleware doesn't cover /api/*, so unverified users can call the paid AI endpoint directly. (beta-lovely #55)$t$, false, 'seed'),
('lovely', $t$SEC-08: Missing security headers (CSP, HSTS, X-Frame-Options)$t$, 'medium', $t$Software · Security$t$, $t$Ryan$t$, $t$No CSP, HSTS, X-Frame-Options, or nosniff headers. Authenticated dashboard is open to clickjacking; missing CSP amplifies XSS blast radius. (beta-lovely #56)$t$, false, 'seed'),
('lovely', $t$SEC-09: TypeScript build errors ignored in production$t$, 'medium', $t$Software · Quality$t$, $t$Ryan$t$, $t$typescript.ignoreBuildErrors: true means type-unsafe code ships. A regression in auth or serial-resolution logic would still deploy. (beta-lovely #57)$t$, false, 'seed'),
('lovely', $t$Verification should be automatic via UUID$t$, 'low', $t$Software · Feature$t$, $t$Ryan$t$, $t$Users enter a 10-digit unique ID that auto-matches the serial number in the DB, replacing the current manual verification process. (beta-lovely #15)$t$, false, 'seed'),
('lovely', $t$Add partitions to Supabase telemetry tables$t$, 'low', $t$Software · Infrastructure$t$, $t$Junaid$t$, $t$Partition temperature sensors, BME sensors, current, and events tables to manage growth. Events table is highest priority. (beta-lovely #4)$t$, false, 'seed'),
-- ── LILA Shop (6 rows) ──────────────────────────────────────────────────
('shop', $t$CAC $400–600 vs. $50–60 Target — Marketing Spend Unsustainable$t$, 'critical', $t$Marketing · Conversion$t$, $t$George / Pedrum$t$, $t$True customer acquisition cost $400–600 against a 5–6% target of $999 unit price ($50–60). $555K marketing budget allocated for 2026. 36 of 47 early sales were US despite Canada-first positioning. Path: SEO to 70+, content flywheel from 70 published blog posts, shift spend mix to organic channels.$t$, false, 'seed'),
('shop', $t$10% Return Rate — $3–4M Annual Loss Projected$t$, 'critical', $t$Post-Sale · Finance$t$, $t$George / Huayi$t$, $t$10% return rate at $999 ASP, including shipping, restocking, and Sezzle fee non-recoverability, projects to $3–4M annual loss at scale. Higher refund rate among Sezzle financing buyers vs. direct-pay. Contributing factors: expectation mismatch, P100 shipment 70 days late, firmware blockers on delivery.$t$, false, 'seed'),
('shop', $t$50% of Sales via Sezzle — Cash Flow Gap + Higher Churn Risk$t$, 'high', $t$Finance · Cash Flow$t$, $t$George$t$, $t$Sezzle financing accounts for ~50% of orders. 30-day payout delay creates a cash flow gap. Financed buyers show higher return rates vs. direct-pay. Strategy needed: Sezzle qualification criteria review, direct-pay incentive (discount or accessory bundle).$t$, false, 'seed'),
('shop', $t$Site Performance — 430KB Pages, 54 External Scripts, Sync Lottie.js$t$, 'high', $t$Technical · SEO$t$, $t$Pedrum / Huayi$t$, $t$Product page HTML: 430KB. Homepage: 319KB. 47–54 external scripts per page; only ~10 async/deferred. Primary LCP blocker: Lottie.js (251KB) loaded synchronously in <head>. Target: <20 external scripts, all async, Lottie deferred or replaced with CSS animation.$t$, false, 'seed'),
('shop', $t$SEO Health 42/100 — Empty H1, HTTP OG Image, Liquid Errors$t$, 'medium', $t$SEO · Technical$t$, $t$Pedrum / Raquel$t$, $t$SEO health score 42/100 (up from 35 in April 2026; target 70). Empty H1 on homepage, OG image served over HTTP not HTTPS. 3 Liquid template errors, 48 inline gstatic font references. 70 blog posts live — solid content base but not yet converting to rankings.$t$, false, 'seed'),
('shop', $t$Gross Margin 24–27% — BOM ~$600 vs. $340 Target$t$, 'medium', $t$Finance · COGS$t$, $t$George / Huayi$t$, $t$Current gross margin 24–27% at $999 CAD ASP; BOM ~$600. Target margin requires BOM reduction to ~$340, dependent on LILA Mini/Pro motor+gearbox cost breakthrough and MP volume ramp.$t$, false, 'seed'),
-- ── LILA Marketplace (2 rows) ───────────────────────────────────────────
('marketplace', $t$Vendor Shopify Collective onboarding$t$, 'medium', $t$Phase 1$t$, $t$Business Dev$t$, $t$10 priority vendors need Collective invitations sent and accepted before Phase 1 soft launch. Earth Rated, Nellie's Clean, Abeego are top priority.$t$, false, 'seed'),
('marketplace', $t$Certification protocol — legal sign-off pending$t$, 'medium', $t$Legal$t$, $t$Operations$t$, $t$Vendor agreement template and certification protocol V1 need legal review before any vendor contracts are executed.$t$, false, 'seed');
```

> **LILA Mega gets zero rows** — its `issues:[]` array in data.ts is already empty (the KPI strip's "1 open issue" text is stale/inaccurate, same class of drift as Pro's badge). No insert needed for `mega`.

- [ ] **Step 2: Apply the migration**

```bash
cd app
./node_modules/.bin/supabase db push
```

Expected output: `Applying migration 20260717120000_product_issues.sql... ✓`

- [ ] **Step 3: Verify row counts match the source data exactly**

```bash
./node_modules/.bin/supabase db execute --sql \
  "select product_id, count(*) from public.product_issues group by product_id order by product_id;"
```

Expected: `makelila=1, lovely=10, marketplace=2, mini=7, pro=23, shop=6` (7 rows total across 6 product_ids — `mega` has none). Sum = 49.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260717120000_product_issues.sql
git commit -m "feat(products): add product_issues table, seed with existing 49 issues"
```

---

## Task 2: lib/products.ts — types, hook, fleet stats, chat sender

**Files:**
- Create: `app/src/lib/products.ts`
- Create: `app/src/lib/products.test.ts`

**Interfaces:**
- Consumes: `supabase` from `./supabase`, `public.product_issues` table (Task 1), edge function `product-issue-chat` (Task 3)
- Produces:
  - `type Issue = { title: string; sev: 'critical'|'high'|'medium'|'low'; tag: string; team: string; meta: string; mpBlocker?: boolean }`
  - `type DbProductIssue` (raw DB row shape)
  - `toIssue(row: DbProductIssue): Issue`
  - `groupByProduct(rows: DbProductIssue[]): Record<string, Issue[]>`
  - `useProductIssues(): { issuesByProduct: Record<string, Issue[]>; loading: boolean }`
  - `computeFleetStats(issuesByProduct, products: {id:string;stage:string}[]): FleetStats`
  - `sendIssueChatMessage(payload): Promise<ChatResponse>`

- [ ] **Step 1: Write the failing tests**

```typescript
// app/src/lib/products.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  toIssue, groupByProduct, computeFleetStats, useProductIssues, sendIssueChatMessage,
  type DbProductIssue,
} from './products';

const { mockResolve, mockOn, mockSubscribe, mockUnsubscribe, mockChannel, mockInvoke } = vi.hoisted(() => {
  const mockResolve = vi.fn();
  const mockUnsubscribe = vi.fn();
  const mockOn = vi.fn().mockReturnThis();
  const mockSubscribe = vi.fn().mockReturnThis();
  const mockChannel = vi.fn(() => ({ on: mockOn, subscribe: mockSubscribe, unsubscribe: mockUnsubscribe }));
  const mockInvoke = vi.fn();
  return { mockResolve, mockOn, mockSubscribe, mockUnsubscribe, mockChannel, mockInvoke };
});

vi.mock('./supabase', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = {};
  builder.select = () => builder;
  builder.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    mockResolve().then(onFulfilled, onRejected);
  return {
    supabase: {
      from: () => builder,
      channel: mockChannel,
      functions: { invoke: mockInvoke },
    },
  };
});

const ROW_PRO: DbProductIssue = {
  id: 'row-1', product_id: 'pro', title: 'Latch snaps off', severity: 'high',
  tag: 'Hardware · Latch', team: 'Ben Liang', meta: 'Breaks under normal use.',
  link: null, mp_blocker: true, source: 'seed', created_by: null, created_by_name: null,
  created_at: '2026-07-01T00:00:00.000Z',
};
const ROW_SHOP: DbProductIssue = {
  id: 'row-2', product_id: 'shop', title: 'CAC too high', severity: 'critical',
  tag: 'Marketing', team: 'Pedrum', meta: 'CAC is $400+.',
  link: null, mp_blocker: false, source: 'seed', created_by: null, created_by_name: null,
  created_at: '2026-07-01T00:00:00.000Z',
};

describe('toIssue', () => {
  it('maps a DB row to the Issue shape', () => {
    expect(toIssue(ROW_PRO)).toEqual({
      title: 'Latch snaps off', sev: 'high', tag: 'Hardware · Latch',
      team: 'Ben Liang', meta: 'Breaks under normal use.', mpBlocker: true,
    });
  });

  it('defaults a null team to an empty string', () => {
    expect(toIssue({ ...ROW_PRO, team: null }).team).toBe('');
  });
});

describe('groupByProduct', () => {
  it('groups rows by product_id', () => {
    const result = groupByProduct([ROW_PRO, ROW_SHOP, { ...ROW_PRO, id: 'row-3' }]);
    expect(result.pro).toHaveLength(2);
    expect(result.shop).toHaveLength(1);
  });

  it('returns an empty object for no rows', () => {
    expect(groupByProduct([])).toEqual({});
  });
});

describe('computeFleetStats', () => {
  const issuesByProduct = groupByProduct([ROW_PRO, ROW_SHOP]);
  const products = [
    { id: 'pro', stage: 'PP' },
    { id: 'shop', stage: 'GROW' },
    { id: 'mega', stage: 'EP' },
  ];

  it('totals open, critical, and MP-blocker issues across all lines', () => {
    const stats = computeFleetStats(issuesByProduct, products);
    expect(stats.totalOpen).toBe(2);
    expect(stats.totalCritical).toBe(1);
    expect(stats.totalMpBlockers).toBe(1);
    expect(stats.lineCount).toBe(3);
  });

  it('gives each product line its own open/critical count, zero for lines with no issues', () => {
    const stats = computeFleetStats(issuesByProduct, products);
    expect(stats.perLine).toEqual([
      { productId: 'pro', stage: 'PP', openCount: 1, criticalCount: 0 },
      { productId: 'shop', stage: 'GROW', openCount: 1, criticalCount: 1 },
      { productId: 'mega', stage: 'EP', openCount: 0, criticalCount: 0 },
    ]);
  });
});

describe('useProductIssues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOn.mockReturnThis();
    mockSubscribe.mockReturnThis();
  });

  it('loads rows and groups them by product', async () => {
    mockResolve.mockResolvedValueOnce({ data: [ROW_PRO, ROW_SHOP], error: null });
    const { result } = renderHook(() => useProductIssues());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.issuesByProduct.pro).toHaveLength(1);
    expect(result.current.issuesByProduct.shop).toHaveLength(1);
  });

  it('subscribes to realtime INSERTs on product_issues', async () => {
    mockResolve.mockResolvedValueOnce({ data: [], error: null });
    renderHook(() => useProductIssues());
    await waitFor(() => expect(mockChannel).toHaveBeenCalledWith('product_issues:realtime'));
    expect(mockOn).toHaveBeenCalledWith(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'product_issues' },
      expect.any(Function),
    );
  });

  it('appends a realtime INSERT payload into the right product group', async () => {
    mockResolve.mockResolvedValueOnce({ data: [], error: null });
    const { result } = renderHook(() => useProductIssues());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const insertHandler = mockOn.mock.calls[0][2] as (payload: { new: DbProductIssue }) => void;
    act(() => { insertHandler({ new: ROW_PRO }); });

    expect(result.current.issuesByProduct.pro).toHaveLength(1);
  });
});

describe('sendIssueChatMessage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('invokes the product-issue-chat function and returns its data', async () => {
    mockInvoke.mockResolvedValueOnce({ data: { reply: 'Got it.', filed: false }, error: null });
    const result = await sendIssueChatMessage({
      messages: [{ role: 'user', content: 'latches keep breaking' }],
      product_id: 'pro',
      products: [{ id: 'pro', label: 'LILA Pro' }],
      knownTeam: ['Ben Liang'],
    });
    expect(mockInvoke).toHaveBeenCalledWith('product-issue-chat', {
      body: {
        messages: [{ role: 'user', content: 'latches keep breaking' }],
        product_id: 'pro',
        products: [{ id: 'pro', label: 'LILA Pro' }],
        knownTeam: ['Ben Liang'],
      },
    });
    expect(result).toEqual({ reply: 'Got it.', filed: false });
  });

  it('throws when the function call errors', async () => {
    mockInvoke.mockResolvedValueOnce({ data: null, error: new Error('network down') });
    await expect(sendIssueChatMessage({
      messages: [], product_id: null, products: [], knownTeam: [],
    })).rejects.toThrow('network down');
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
cd app
npx vitest run src/lib/products.test.ts
```

Expected: `Error: Cannot find module './products'` (or similar) — `products.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// app/src/lib/products.ts
import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface Issue {
  title: string; sev: IssueSeverity;
  tag: string; team: string; meta: string; mpBlocker?: boolean;
}

export type DbProductIssue = {
  id: string;
  product_id: string;
  title: string;
  severity: IssueSeverity;
  tag: string;
  team: string | null;
  meta: string;
  link: string | null;
  mp_blocker: boolean;
  source: 'seed' | 'chat';
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
};

export function toIssue(row: DbProductIssue): Issue {
  return {
    title: row.title,
    sev: row.severity,
    tag: row.tag,
    team: row.team ?? '',
    meta: row.meta,
    mpBlocker: row.mp_blocker,
  };
}

export function groupByProduct(rows: DbProductIssue[]): Record<string, Issue[]> {
  const out: Record<string, Issue[]> = {};
  for (const row of rows) {
    if (!out[row.product_id]) out[row.product_id] = [];
    out[row.product_id].push(toIssue(row));
  }
  return out;
}

const PRODUCT_ISSUE_COLUMNS =
  'id, product_id, title, severity, tag, team, meta, link, mp_blocker, source, created_by, created_by_name, created_at';

/** Realtime-subscribed list of every product issue, grouped by product_id.
 *  Fetched once at the Products() root and threaded down to the Dashboard
 *  tab and each product's Overview/Issues tabs. */
export function useProductIssues(): { issuesByProduct: Record<string, Issue[]>; loading: boolean } {
  const [rows, setRows] = useState<DbProductIssue[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let channel: RealtimeChannel | null = null;

    (async () => {
      const { data, error } = await supabase
        .from('product_issues')
        .select(PRODUCT_ISSUE_COLUMNS);
      if (cancelled) return;
      if (!error && data) setRows(data as DbProductIssue[]);
      setLoading(false);

      channel = supabase
        .channel('product_issues:realtime')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'product_issues' },
          (payload) => {
            setRows(prev => [...prev, payload.new as DbProductIssue]);
          },
        )
        .subscribe();
    })();

    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { issuesByProduct: groupByProduct(rows), loading };
}

export type FleetLineStat = {
  productId: string;
  stage: string;
  openCount: number;
  criticalCount: number;
};

export type FleetStats = {
  totalOpen: number;
  totalCritical: number;
  totalMpBlockers: number;
  lineCount: number;
  perLine: FleetLineStat[];
};

/** Pure — no React/Supabase dependency, safe to unit test in isolation. */
export function computeFleetStats(
  issuesByProduct: Record<string, Issue[]>,
  products: { id: string; stage: string }[],
): FleetStats {
  const perLine: FleetLineStat[] = products.map(p => {
    const issues = issuesByProduct[p.id] ?? [];
    return {
      productId: p.id,
      stage: p.stage,
      openCount: issues.length,
      criticalCount: issues.filter(i => i.sev === 'critical').length,
    };
  });
  const allIssues = products.flatMap(p => issuesByProduct[p.id] ?? []);
  return {
    totalOpen: allIssues.length,
    totalCritical: allIssues.filter(i => i.sev === 'critical').length,
    totalMpBlockers: allIssues.filter(i => i.mpBlocker === true).length,
    lineCount: products.length,
    perLine,
  };
}

export type ChatTurn = { role: 'user' | 'assistant'; content: string };
export type ChatResponse = {
  reply: string;
  filed: boolean;
  issue?: { id: string; title: string; product_id: string };
};

/** Calls the product-issue-chat edge function. Components never call
 *  `supabase.functions.invoke` directly — this is the one place that does. */
export async function sendIssueChatMessage(payload: {
  messages: ChatTurn[];
  product_id: string | null;
  products: { id: string; label: string }[];
  knownTeam: string[];
}): Promise<ChatResponse> {
  const { data, error } = await supabase.functions.invoke('product-issue-chat', { body: payload });
  if (error) throw error;
  return data as ChatResponse;
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npx vitest run src/lib/products.test.ts
```

Expected: all tests pass (11 tests across 5 describe blocks).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/products.ts app/src/lib/products.test.ts
git commit -m "feat(products): add lib/products.ts — Issue type, useProductIssues hook, computeFleetStats, chat sender"
```

---

## Task 3: Edge function — product-issue-chat

**Files:**
- Create: `supabase/functions/product-issue-chat/index.ts`
- Create: `supabase/functions/product-issue-chat/index.test.ts`

**Interfaces:**
- Consumes: `_shared/auth.ts:authenticate()`, `_shared/cors.ts:corsHeaders`, `DEEPSEEK_API_KEY` env secret, `public.product_issues` (Task 1)
- Produces: `validateIssue(issue: unknown, validProductIds: string[]): FiledIssue | null` (exported for testing); HTTP contract `{ reply, filed, issue? }`

- [ ] **Step 1: Write the failing test**

```typescript
// supabase/functions/product-issue-chat/index.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { validateIssue } from './index.ts';

const VALID_IDS = ['pro', 'mini', 'shop'];

Deno.test('validateIssue: accepts a well-formed issue', () => {
  const result = validateIssue({
    product_id: 'pro',
    title: 'Latch snaps off',
    severity: 'high',
    tag: 'Hardware · Latch',
    team: 'Ben Liang',
    meta: 'Latches break under normal use.',
    link: 'https://example.com/photo.jpg',
    mp_blocker: true,
  }, VALID_IDS);
  assertEquals(result?.product_id, 'pro');
  assertEquals(result?.severity, 'high');
  assertEquals(result?.mp_blocker, true);
});

Deno.test('validateIssue: rejects unknown product_id', () => {
  const result = validateIssue({
    product_id: 'nope', title: 'x', severity: 'high', meta: 'y',
  }, VALID_IDS);
  assertEquals(result, null);
});

Deno.test('validateIssue: rejects invalid severity', () => {
  const result = validateIssue({
    product_id: 'pro', title: 'x', severity: 'urgent', meta: 'y',
  }, VALID_IDS);
  assertEquals(result, null);
});

Deno.test('validateIssue: rejects empty title or meta', () => {
  assertEquals(validateIssue({ product_id: 'pro', title: '', severity: 'high', meta: 'y' }, VALID_IDS), null);
  assertEquals(validateIssue({ product_id: 'pro', title: 'x', severity: 'high', meta: '' }, VALID_IDS), null);
});

Deno.test('validateIssue: defaults tag to Other, team to empty string, mp_blocker to false when missing', () => {
  const result = validateIssue({
    product_id: 'pro', title: 'x', severity: 'low', meta: 'y',
  }, VALID_IDS);
  assertEquals(result?.tag, 'Other');
  assertEquals(result?.team, '');
  assertEquals(result?.mp_blocker, false);
});

Deno.test('validateIssue: rejects null or non-object issue', () => {
  assertEquals(validateIssue(null, VALID_IDS), null);
  assertEquals(validateIssue('not an object', VALID_IDS), null);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
deno test supabase/functions/product-issue-chat/index.test.ts 2>&1 | head -10
```

Expected: `error: Module not found "file:///.../product-issue-chat/index.ts"` — confirms the test file is wired up correctly.

- [ ] **Step 3: Write the edge function**

```typescript
// supabase/functions/product-issue-chat/index.ts
// Multi-turn issue intake chat. Called by IssueChatPanel.tsx.
//
// Each request carries the full conversation; DeepSeek always replies as
// strict JSON {reply, ready_to_file, issue}. When ready_to_file is true and
// the issue payload validates, this function inserts it directly
// (service-role) and logs it to activity_log — no second round-trip to
// confirm the write happened.
//
// Auth: requires the caller's user JWT (cron-secret not accepted).
// POST body: { messages, product_id, products, knownTeam }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const DEEPSEEK_API = 'https://api.deepseek.com/chat/completions';
const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
type Severity = typeof SEVERITIES[number];

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

export type ChatRequest = {
  messages: ChatTurn[];
  product_id: string | null;
  products: { id: string; label: string }[];
  knownTeam: string[];
};

export type FiledIssue = {
  product_id: string;
  title: string;
  severity: Severity;
  tag: string;
  team: string;
  meta: string;
  link: string | null;
  mp_blocker: boolean;
};

type DeepseekTurn = { reply: string; ready_to_file: boolean; issue: unknown };

/** Validates a model-proposed issue against the known product set before
 *  trusting it enough to write to the DB. A malformed or hallucinated
 *  payload returns null — the caller then just continues the conversation
 *  instead of filing garbage. Exported for unit testing. */
export function validateIssue(
  issue: unknown,
  validProductIds: string[],
): FiledIssue | null {
  if (!issue || typeof issue !== 'object') return null;
  const i = issue as Record<string, unknown>;
  if (typeof i.product_id !== 'string' || !validProductIds.includes(i.product_id)) return null;
  if (typeof i.title !== 'string' || !i.title.trim()) return null;
  if (typeof i.meta !== 'string' || !i.meta.trim()) return null;
  if (typeof i.severity !== 'string' || !SEVERITIES.includes(i.severity as Severity)) return null;
  return {
    product_id: i.product_id,
    title: i.title.trim(),
    severity: i.severity as Severity,
    tag: typeof i.tag === 'string' && i.tag.trim() ? i.tag.trim() : 'Other',
    team: typeof i.team === 'string' ? i.team.trim() : '',
    meta: i.meta.trim(),
    link: typeof i.link === 'string' && i.link.trim() ? i.link.trim() : null,
    mp_blocker: i.mp_blocker === true,
  };
}

function buildSystemPrompt(
  products: { id: string; label: string }[],
  knownTeam: string[],
  productHint: string | null,
): string {
  return `You are an issue-intake triage assistant for VCycene/LILA Composter's internal product tracker. A team member is describing a problem in chat; your job is to gather enough information to file it as a ticket on the right product line.

Valid product lines (use the id, not the label):
${products.map(p => `- ${p.id}: ${p.label}`).join('\n')}

Known team members (prefer matching one of these for "accountable person"; if the user names someone else, accept it as-is):
${knownTeam.join(', ')}

${productHint
    ? `The user has pre-selected product "${productHint}" from a dropdown — assume that's the product unless they clearly name a different one in the conversation.`
    : 'No product has been pre-selected — ask which product line if it is not obvious from the description.'}

You need, at minimum, before filing: which product line, a description of the problem (and optionally a link), an accountable person/team, and a severity assessment (critical/high/medium/low — use your judgment based on the description; ask the user only if genuinely ambiguous).

Respond with JSON ONLY, no markdown, matching exactly:
{
  "reply": "<what to say back to the user — a question if more info is needed, or a confirmation once filed>",
  "ready_to_file": <true only once you have product, description, accountable person, and severity>,
  "issue": <null, or once ready_to_file is true: {
    "product_id": "<one of the valid ids above>",
    "title": "<short title, max 80 chars>",
    "severity": "critical" | "high" | "medium" | "low",
    "tag": "<short category tag, e.g. 'Hardware · Latch Mechanism'>",
    "team": "<accountable person/team>",
    "meta": "<full description as given, cleaned up into 1-3 sentences>",
    "link": <string URL if one was given, else null>,
    "mp_blocker": <true only if the user says or implies this blocks mass production, else false>
  }>
}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  try { return await handle(req); }
  catch (err) {
    return json({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500);
  }

  const admin = createClient(supabaseUrl, serviceKey);

  let caller;
  try { caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  if (caller.kind !== 'user') {
    return json({ error: 'This function requires an operator JWT — cron-secret not accepted.' }, 403);
  }

  const body = await req.json().catch(() => ({})) as Partial<ChatRequest>;
  const messages = body.messages ?? [];
  const products = body.products ?? [];
  const knownTeam = body.knownTeam ?? [];
  const productId = body.product_id ?? null;
  if (!messages.length || !products.length) {
    return json({ error: 'messages and products are required' }, 400);
  }

  const apiKey = Deno.env.get('DEEPSEEK_API_KEY');
  if (!apiKey) {
    return json({ reply: "Chat isn't configured yet — ask an admin to set DEEPSEEK_API_KEY.", filed: false }, 200);
  }

  const validProductIds = products.map(p => p.id);
  const systemPrompt = buildSystemPrompt(products, knownTeam, productId);

  let deepseekTurn: DeepseekTurn;
  try {
    const res = await fetch(DEEPSEEK_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.map(m => ({ role: m.role, content: m.content })),
        ],
      }),
    });
    if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content ?? '';
    deepseekTurn = JSON.parse(text) as DeepseekTurn;
  } catch (err) {
    console.warn('DeepSeek call failed', err);
    return json({ reply: "Sorry, I couldn't reach the classifier — try again in a moment.", filed: false }, 200);
  }

  if (!deepseekTurn.ready_to_file) {
    return json({ reply: deepseekTurn.reply, filed: false }, 200);
  }

  const validated = validateIssue(deepseekTurn.issue, validProductIds);
  if (!validated) {
    return json({ reply: deepseekTurn.reply, filed: false }, 200);
  }

  const { data: profile } = await admin
    .from('profiles')
    .select('display_name')
    .eq('id', caller.user_id)
    .maybeSingle();

  const { data: inserted, error: insertErr } = await admin
    .from('product_issues')
    .insert({
      product_id: validated.product_id,
      title: validated.title,
      severity: validated.severity,
      tag: validated.tag,
      team: validated.team,
      meta: validated.meta,
      link: validated.link,
      mp_blocker: validated.mp_blocker,
      source: 'chat',
      created_by: caller.user_id,
      created_by_name: profile?.display_name ?? caller.email,
    })
    .select('id')
    .single();

  if (insertErr || !inserted) {
    return json({ reply: "I had the details but couldn't save the ticket — try again.", filed: false }, 200);
  }

  await admin.from('activity_log').insert({
    user_id: caller.user_id,
    type: 'product_issue_filed',
    entity: validated.title,
    detail: `${validated.product_id} · ${validated.severity}`,
    entity_type: 'product_issue',
    entity_id: inserted.id,
  });

  return json({
    reply: deepseekTurn.reply,
    filed: true,
    issue: { id: inserted.id, title: validated.title, product_id: validated.product_id },
  }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
```

- [ ] **Step 4: Run the unit tests to confirm they pass**

```bash
deno test supabase/functions/product-issue-chat/index.test.ts --allow-net
```

Expected output:
```
running 6 tests from ./supabase/functions/product-issue-chat/index.test.ts
validateIssue: accepts a well-formed issue ... ok
validateIssue: rejects unknown product_id ... ok
validateIssue: rejects invalid severity ... ok
validateIssue: rejects empty title or meta ... ok
validateIssue: defaults tag to Other, team to empty string, mp_blocker to false when missing ... ok
validateIssue: rejects null or non-object issue ... ok
ok | 6 passed | 0 failed
```

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/product-issue-chat/
git commit -m "feat(products): add product-issue-chat edge function"
```

- [ ] **Step 6: Set the DeepSeek API key secret**

```bash
cd app
./node_modules/.bin/supabase secrets set DEEPSEEK_API_KEY=<your-deepseek-key>
```

Expected: `Finished supabase secrets set.`

- [ ] **Step 7: Deploy the function**

```bash
./node_modules/.bin/supabase functions deploy product-issue-chat
```

Expected: `Deployed Function product-issue-chat`

- [ ] **Step 8: Smoke-test with a live curl request**

Get a valid operator JWT from the browser (devtools → Application → Local Storage → `sb-<project-ref>-auth-token`), then:

```bash
curl -X POST https://txeftbbzeflequvrmjjr.supabase.co/functions/v1/product-issue-chat \
  -H "Authorization: Bearer <your-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role":"user","content":"the front latch on my test unit keeps popping open, this is Ben Liang'\''s area"}],
    "product_id": "pro",
    "products": [{"id":"pro","label":"LILA Pro"}],
    "knownTeam": ["Ben Liang","Lezhong","Huayi"]
  }'
```

Expected: a JSON response with a `reply` string. Since the message already has product, description, and accountable person, `filed` should be `true` with an `issue` object — check `product_issues` in the Supabase Table Editor for the new `source='chat'` row.

---

## Task 4: data.ts — import shared Issue type, empty the seeded arrays

**Files:**
- Modify: `app/src/modules/Products/data.ts`

**Interfaces:**
- Consumes: `Issue` type from `../../lib/products` (Task 2)
- Produces: `Product.issues` fields for the 7 migrated products are now empty arrays (live data comes from `useProductIssues()` at render time, Task 7)

- [ ] **Step 1: Replace the local `Issue` interface with an import**

In `app/src/modules/Products/data.ts`, replace:

```typescript
export interface Issue {
  title: string; sev: 'critical' | 'high' | 'medium' | 'low';
  tag: string; team: string; meta: string; mpBlocker?: boolean;
}
```

with:

```typescript
import type { Issue } from '../../lib/products';
export type { Issue };
```

(Keep the `export type { Issue }` re-export — nothing outside this file currently imports `Issue` by name, but re-exporting costs nothing and avoids a future import-path surprise.)

- [ ] **Step 2: Empty the 6 non-empty seeded issue arrays**

Each of these is a straight `issues:[ ... ]` → `issues:[],` replacement — the array contents (all 49 issues) now live in `product_issues` (Task 1), so keeping them here too would double-count everywhere they're read.

a. **LILA Pro** — find the block starting `issues:[` (right after `],` sub:`'Shipped (total)'...` KPI closes) and ending at the `],` right before `notes:[` that contains `'Pilot Status'`. Replace the whole `issues:[ ... 23 entries ... ],` block with:
```typescript
    issues:[],
```

b. **LILA Mini** — find the `issues:[` block (7 entries, starts with `title:'Motor-Gearbox Shaft Mismatch'`) ending right before the `notes:[` that contains `'EVT Status'`. Replace with:
```typescript
    issues:[],
```

c. **LILA Mega** — already `issues:[],`. No change.

d. **makeLILA** — find the `issues:[` block (1 entry, `title:'PMF Live Dashboard...'`) ending right before `notes:[` containing `'What It Is'` (the makeLILA one, not Lovely's). Replace with:
```typescript
    issues:[],
```

e. **Lovely App** — find the `issues:[` block (10 entries, starts with `title:'SEC-01...'`) ending right before `notes:[` containing `'What It Is'` (the Lovely one). Replace with:
```typescript
    issues:[],
```

f. **LILA Shop** — find the `issues:[` block (6 entries, starts with `title:'CAC $400–600...'`) ending right before `notes:[` containing `'Site Status'`. Replace with:
```typescript
    issues:[],
```

g. **LILA Marketplace** — find the `issues:[` block (2 entries, starts with `title:'Vendor Shopify Collective onboarding'`) ending right before `notes:[` containing `'Platform'`. Replace with:
```typescript
    issues:[],
```

> Leave `badgeClass`/`badgeCount` on each product object as-is even though the tab bar stops reading them after Task 7 — removing them would mean reworking the `Product` interface's required fields for a purely cosmetic cleanup unrelated to this feature. They become vestigial, not broken.

- [ ] **Step 3: Typecheck**

```bash
cd app
npx tsc --noEmit
```

Expected: no errors. (If `Issue` fields don't line up, TypeScript will flag it here before you ever open the browser.)

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/Products/data.ts
git commit -m "refactor(products): source Issue type from lib/products, empty seeded issue arrays"
```

---

## Task 5: IssueChatPanel.tsx

**Files:**
- Create: `app/src/modules/Products/IssueChatPanel.tsx`
- Modify: `app/src/modules/Products/Products.module.css`

**Interfaces:**
- Consumes: `sendIssueChatMessage` from `../../lib/products` (Task 2)
- Produces: `IssueChatPanel({ products, knownTeam }: { products: {id:string;label:string}[]; knownTeam: string[] })` — a React component

- [ ] **Step 1: Append chat panel styles to Products.module.css**

Add at the end of `app/src/modules/Products/Products.module.css` (after the existing `.empty` block):

```css

/* ── Issue chat panel ────────────────────────────────────────────────────── */
.chatPanel {
  background: var(--surface-up);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 16px;
  max-width: 640px;
}
.chatProductRow {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.chatProductLabel { font-size: 12px; font-weight: 600; color: var(--ink-3); }
.chatProductSelect {
  padding: 6px 10px;
  font-size: 12px;
  font-family: var(--font-sans);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-up);
  color: var(--ink);
}
.chatThread {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 360px;
  overflow-y: auto;
  padding: 4px 2px;
  margin-bottom: 12px;
}
.chatBubble {
  max-width: 85%;
  padding: 8px 12px;
  border-radius: var(--radius);
  font-size: 13px;
  line-height: 1.5;
}
.chatBubbleUser {
  align-self: flex-end;
  max-width: 85%;
  padding: 8px 12px;
  border-radius: var(--radius);
  font-size: 13px;
  line-height: 1.5;
  background: var(--accent-lt);
  color: var(--ink);
}
.chatBubbleBot {
  align-self: flex-start;
  max-width: 85%;
  padding: 8px 12px;
  border-radius: var(--radius);
  font-size: 13px;
  line-height: 1.5;
  background: var(--surface);
  color: var(--ink-2);
}
.chatBubbleFiled {
  align-self: flex-start;
  max-width: 85%;
  padding: 8px 12px;
  border-radius: var(--radius);
  font-size: 13px;
  line-height: 1.5;
  background: var(--success-bg);
  color: var(--success);
  border: 1px solid var(--success-border);
  font-weight: 600;
}
.chatInputRow {
  display: flex;
  gap: 8px;
}
.chatInput {
  flex: 1;
  padding: 8px 12px;
  font-size: 13px;
  font-family: var(--font-sans);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-up);
  color: var(--ink);
  outline: none;
}
.chatInput:focus { border-color: var(--accent); }
.chatSendBtn {
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  border: none;
  border-radius: var(--radius);
  background: var(--accent);
  color: #fff;
  cursor: pointer;
}
.chatSendBtn:disabled { opacity: 0.5; cursor: not-allowed; }
.chatThinking { font-size: 12px; color: var(--ink-4); font-style: italic; }
```

- [ ] **Step 2: Write the component**

```tsx
// app/src/modules/Products/IssueChatPanel.tsx
import { useState } from 'react';
import { sendIssueChatMessage } from '../../lib/products';
import styles from './Products.module.css';

type ChatTurn = { role: 'user' | 'assistant'; content: string; filed?: boolean };

export function IssueChatPanel({
  products,
  knownTeam,
}: {
  products: { id: string; label: string }[];
  knownTeam: string[];
}) {
  const [productId, setProductId] = useState('');
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    const nextTurns: ChatTurn[] = [...turns, { role: 'user', content: text }];
    setTurns(nextTurns);
    setInput('');
    setSending(true);
    try {
      const response = await sendIssueChatMessage({
        messages: nextTurns.map(t => ({ role: t.role, content: t.content })),
        product_id: productId || null,
        products,
        knownTeam,
      });
      setTurns(prev => [...prev, { role: 'assistant', content: response.reply, filed: response.filed }]);
    } catch {
      setTurns(prev => [...prev, { role: 'assistant', content: "Something went wrong sending that — try again." }]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={styles.chatPanel}>
      <div className={styles.chatProductRow}>
        <span className={styles.chatProductLabel}>Product:</span>
        <select
          className={styles.chatProductSelect}
          value={productId}
          onChange={e => setProductId(e.target.value)}
        >
          <option value="">Unset — let the chat figure it out</option>
          {products.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>

      <div className={styles.chatThread}>
        {turns.length === 0 && (
          <div className={styles.chatBubbleBot}>
            Describe an issue — what's wrong, who should own it, and a link if you have one — and I'll file it.
          </div>
        )}
        {turns.map((t, i) => (
          <div
            key={i}
            className={
              t.role === 'user'
                ? styles.chatBubbleUser
                : t.filed
                  ? styles.chatBubbleFiled
                  : styles.chatBubbleBot
            }
          >
            {t.filed ? `✓ ${t.content}` : t.content}
          </div>
        ))}
        {sending && <div className={styles.chatThinking}>Thinking…</div>}
      </div>

      <div className={styles.chatInputRow}>
        <input
          className={styles.chatInput}
          placeholder="Describe the issue…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !sending) void send(); }}
          disabled={sending}
        />
        <button className={styles.chatSendBtn} onClick={() => void send()} disabled={sending || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
cd app
npx tsc --noEmit
```

Expected: no errors. (Full interactive verification happens in Task 7, once this is wired into the Dashboard tab and there's a page to load in the browser.)

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/Products/IssueChatPanel.tsx app/src/modules/Products/Products.module.css
git commit -m "feat(products): add IssueChatPanel component"
```

---

## Task 6: DashboardTab.tsx

**Files:**
- Create: `app/src/modules/Products/DashboardTab.tsx`
- Modify: `app/src/modules/Products/Products.module.css`

**Interfaces:**
- Consumes: `PRODUCTS` from `./data`, `computeFleetStats` + `Issue` type from `../../lib/products` (Task 2), `IssueChatPanel` (Task 5)
- Produces: `DashboardTab({ issuesByProduct, onSelectProduct }: { issuesByProduct: Record<string, Issue[]>; onSelectProduct: (id: string) => void })`

- [ ] **Step 1: Append dashboard grid styles to Products.module.css**

Add at the end of `app/src/modules/Products/Products.module.css` (after the chat panel styles added in Task 5):

```css

/* ── Dashboard tab ───────────────────────────────────────────────────────── */
.dashLineGrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
  margin-bottom: 8px;
}
.dashLineCard {
  background: var(--surface-up);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 14px 16px;
  text-align: left;
  cursor: pointer;
  font-family: var(--font-sans);
  transition: border-color 0.12s;
}
.dashLineCard:hover { border-color: var(--accent); }
.dashLineName { font-size: 13px; font-weight: 700; color: var(--ink); margin-bottom: 2px; }
.dashLineStage { font-size: 11px; color: var(--ink-3); margin-bottom: 10px; }
.dashLineCounts { display: flex; gap: 8px; flex-wrap: wrap; }
.dashCountOpen, .dashCountZero, .dashCountCrit {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
}
.dashCountOpen { background: var(--surface); color: var(--ink-2); }
.dashCountZero { background: var(--success-bg); color: var(--success); }
.dashCountCrit { background: var(--crit-bg); color: var(--crit); }
```

- [ ] **Step 2: Write the component**

```tsx
// app/src/modules/Products/DashboardTab.tsx
import { PRODUCTS } from './data';
import { computeFleetStats, type Issue } from '../../lib/products';
import { IssueChatPanel } from './IssueChatPanel';
import styles from './Products.module.css';

const DASHBOARD_PRODUCTS = [
  { id: 'pro',         label: 'LILA Pro' },
  { id: 'mini',        label: 'LILA Mini' },
  { id: 'mega',        label: 'LILA Mega' },
  { id: 'makelila',    label: 'makeLILA' },
  { id: 'lovely',      label: 'Lovely App' },
  { id: 'shop',        label: 'LILA Shop' },
  { id: 'marketplace', label: 'LILA Marketplace' },
];

const KNOWN_TEAM = Array.from(new Set(
  DASHBOARD_PRODUCTS.flatMap(p => PRODUCTS[p.id].team.map(m => m.name)),
)).sort();

export function DashboardTab({
  issuesByProduct,
  onSelectProduct,
}: {
  issuesByProduct: Record<string, Issue[]>;
  onSelectProduct: (id: string) => void;
}) {
  const products = DASHBOARD_PRODUCTS.map(p => ({
    id: p.id,
    stage: PRODUCTS[p.id].currentLabel,
  }));
  const stats = computeFleetStats(issuesByProduct, products);

  return (
    <div className={styles.productPage}>
      <div className={styles.sectionHead}>Fleet Summary</div>
      <div className={styles.kpiStrip}>
        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>Open Issues</div>
          <div className={`${styles.kpiVal} ${stats.totalOpen > 0 ? styles.vCrit : ''}`}>{stats.totalOpen}</div>
          <div className={styles.kpiSub}>across {stats.lineCount} product lines</div>
        </div>
        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>Critical</div>
          <div className={`${styles.kpiVal} ${stats.totalCritical > 0 ? styles.vCrit : ''}`}>{stats.totalCritical}</div>
          <div className={styles.kpiSub}>needs immediate attention</div>
        </div>
        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>MP Blockers</div>
          <div className={`${styles.kpiVal} ${stats.totalMpBlockers > 0 ? styles.vMed : ''}`}>{stats.totalMpBlockers}</div>
          <div className={styles.kpiSub}>blocking mass production</div>
        </div>
        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>Product Lines</div>
          <div className={styles.kpiVal}>{stats.lineCount}</div>
          <div className={styles.kpiSub}>tracked in this dashboard</div>
        </div>
      </div>

      <div className={styles.sectionHead} style={{ marginTop: 24 }}>Product Lines</div>
      <div className={styles.dashLineGrid}>
        {stats.perLine.map(line => {
          const label = DASHBOARD_PRODUCTS.find(p => p.id === line.productId)?.label ?? line.productId;
          return (
            <button
              key={line.productId}
              className={styles.dashLineCard}
              onClick={() => onSelectProduct(line.productId)}
            >
              <div className={styles.dashLineName}>{label}</div>
              <div className={styles.dashLineStage}>{line.stage}</div>
              <div className={styles.dashLineCounts}>
                <span className={line.openCount > 0 ? styles.dashCountOpen : styles.dashCountZero}>
                  {line.openCount} open
                </span>
                {line.criticalCount > 0 && (
                  <span className={styles.dashCountCrit}>{line.criticalCount} critical</span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className={styles.sectionHead} style={{ marginTop: 24 }}>File an Issue</div>
      <IssueChatPanel products={DASHBOARD_PRODUCTS} knownTeam={KNOWN_TEAM} />
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
cd app
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/Products/DashboardTab.tsx app/src/modules/Products/Products.module.css
git commit -m "feat(products): add DashboardTab component"
```

---

## Task 7: index.tsx — wire the Dashboard tab, live issues, live badges

**Files:**
- Modify: `app/src/modules/Products/index.tsx`

**Interfaces:**
- Consumes: `useProductIssues`, `type Issue` from `../../lib/products` (Task 2), `DashboardTab` (Task 6)
- Produces: working Dashboard tab as the default landing view; live issue counts everywhere

- [ ] **Step 1: Add imports**

At the top of `app/src/modules/Products/index.tsx`, after the existing `} from './data';` import block, add:

```typescript
import { useProductIssues, type Issue } from '../../lib/products';
import { DashboardTab } from './DashboardTab';
```

- [ ] **Step 2: Add the Dashboard tab as the first entry in PRODUCT_TABS**

Replace:

```typescript
const PRODUCT_TABS = [
  { id:'pro',         label:'LILA Pro' },
```

with:

```typescript
const PRODUCT_TABS = [
  { id:'dashboard',   label:'Dashboard' },
  { id:'pro',         label:'LILA Pro' },
```

(leave every other entry in the array unchanged)

- [ ] **Step 3: Make ProductPage take live issues as a prop instead of reading the static array**

Replace:

```typescript
function ProductPage({ prod, view, onViewChange }: {
  prod: string;
  view: View;
  onViewChange: (v: View) => void;
}) {
  const d = PRODUCTS[prod];
  if (!d) return null;
  const stages = d.customStages ?? STAGES;
```

with:

```typescript
function ProductPage({ prod, view, onViewChange, liveIssues }: {
  prod: string;
  view: View;
  onViewChange: (v: View) => void;
  liveIssues: Issue[];
}) {
  const base = PRODUCTS[prod];
  if (!base) return null;
  const d: Product = { ...base, issues: liveIssues };
  const stages = d.customStages ?? STAGES;
```

(everything below this in `ProductPage` — the KPI strip, view chips, and the `{view === 'Overview' && <OverviewTab .../>}` etc. block — stays exactly as-is; it already just reads `d`, which now carries live issues)

- [ ] **Step 4: Wire the root Products() component**

Replace the entire `export default function Products() { ... }` block with:

```typescript
export default function Products() {
  const [activeProd, setActiveProd] = useState('dashboard');
  const [activeViews, setActiveViews] = useState<Record<string, View>>({
    pro:'Overview', mini:'Overview', mega:'Overview', makelila:'Overview',
    lovely:'Overview', shop:'Overview', marketplace:'Overview',
  });
  const { issuesByProduct } = useProductIssues();

  const setView = (v: View) =>
    setActiveViews(prev => ({ ...prev, [activeProd]: v }));

  return (
    <div className={styles.products}>
      <div className={styles.tabBar}>
        {PRODUCT_TABS.map(tab => {
          const d = PRODUCTS[tab.id];
          const liveIssues = issuesByProduct[tab.id] ?? [];
          const liveCount = liveIssues.length;
          const liveCrit  = liveIssues.some(i => i.sev === 'critical');
          return (
            <button
              key={tab.id}
              className={`${styles.prodTab} ${activeProd === tab.id ? styles.active : ''}`}
              onClick={() => setActiveProd(tab.id)}
            >
              {tab.label}
              {tab.id !== 'dashboard' && tab.id !== 'rd' && d && liveCount > 0 && (
                <span className={`${styles.badge} ${liveCrit ? styles.badgeCrit : styles.badgeAcc}`}>
                  {liveCount}
                </span>
              )}
              {tab.id === 'rd' && (
                <span className={`${styles.badge} ${styles.badgeAcc}`}>
                  {RD_PROJECTS.filter(p => p.status === 'active').length}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {activeProd === 'dashboard' ? (
        <DashboardTab issuesByProduct={issuesByProduct} onSelectProduct={setActiveProd} />
      ) : activeProd === 'rd' ? (
        <RDView />
      ) : (
        <ProductPage
          prod={activeProd}
          view={activeViews[activeProd] ?? 'Overview'}
          onViewChange={setView}
          liveIssues={issuesByProduct[activeProd] ?? []}
        />
      )}
    </div>
  );
}
```

> **Behavior change, expected:** tab badges now show live counts computed from `product_issues` instead of the old hand-typed `badgeCount`/`badgeClass` text. This is intentional — it's the direct fix for the exact drift documented in Task 1 (Pro's badge said 24 when the array had 23; Mega's KPI text said 1 open issue when the array was empty). After this task, what you see in the tab bar always matches what's in the Issues tab.

- [ ] **Step 5: Typecheck**

```bash
cd app
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Build**

```bash
npm run build
```

Expected: build succeeds with no errors.

- [ ] **Step 7: Run the full test suite**

```bash
npx vitest run
```

Expected: all existing tests plus the new `products.test.ts` pass.

- [ ] **Step 8: Manual QA in the browser**

```bash
npm run dev
```

Navigate to the Products module and confirm, in order:

1. **Dashboard is the default tab** on load, showing the Fleet Summary KPI row and a 7-card product line grid.
2. **Fleet totals are correct**: Open Issues = 49, Critical = (sum of critical across all seeded rows), MP Blockers = 7 (all seven are on LILA Pro), Product Lines = 7.
3. **Per-line cards** show the right open/critical counts (Pro=23/5, Mini=7/2, Mega=0/0, makeLILA=1/0, Lovely=10/2, Shop=6/2, Marketplace=2/0) — cross-check against Step 3 of Task 1's verification query.
4. **Click a card** (e.g. LILA Pro) — it switches to that product's existing tab, and the Issues tab shows the same 23 issues as before the migration (VCycene/ODM split still works).
5. **Tab bar badges** now show live counts matching the cards (Pro shows 23, not the old 24; Mega shows no badge since it has zero issues).
6. **File an issue via chat**: on the Dashboard, pick a product from the dropdown (or leave unset), type a description with enough detail to file (e.g. "the drip tray on LILA Pro keeps cracking, Ben Liang should own this, it's a medium severity issue"), send it, and confirm the bot eventually replies with a "✓ filed" confirmation.
7. **Confirm live propagation**: without refreshing, check that the new issue now appears in LILA Pro's Issues tab, the Dashboard's Pro card count went up by one, and the Pro tab badge incremented — all via the realtime subscription, no manual reload.
8. **Confirm the audit trail**: open the Activity Log module and see a `product_issue_filed` entry for the issue just filed.

- [ ] **Step 9: Commit**

```bash
git add app/src/modules/Products/index.tsx
git commit -m "feat(products): wire Dashboard tab, live issue counts, and issue-intake chat into Products module"
```
