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
