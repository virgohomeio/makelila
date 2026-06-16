# Timeline Tracker — Projected vs Actual

> Living document. Update the **Actual hours / Status / Notes** columns on every ship so we can calibrate future estimates against observed reality.
> Source-of-truth projections come from PRD v1.2 + the interactive review at [makelila_PRD_review.html](../../makelila_PRD_review.html) v1.4.1.
> Last updated 2026-06-07.

## How to use this tracker

1. **At session start:** read the row for the feature you're shipping. The "Projected hours" column is what was estimated; the "Notes / risks" column flags anything to watch.
2. **On each commit:** add a line under the Notes column with `commit-sha · what-was-done · time-spent-in-this-session` so the actual hours total stays correct.
3. **On ship (PR merge):** flip Status from `planned` → `in_flight` → `shipped`. Stamp `Shipped on` (YYYY-MM-DD) and the final commit SHA range. Compare actual to projected; if the variance is > 50%, add a one-line "why" so future estimates learn.
4. **At end of week:** run the "Calibration delta" computation at the bottom of this file to see whether the S/M/L hour assumptions are drifting.

Projection key: **S = 5h · M = 15h · L = 45h** (each includes dev + validation).
Actual key: cumulative time spent across all sessions on the feature.
Status: `planned` / `in_flight` / `shipped` / `blocked` / `dropped`.

---

## Huayi — 8 features, projected 120h, actual TBD

| # | Feature | Pri | Size | Projected | Actual | Status | Shipped on | Notes / variance |
|---|---|---|---|---|---|---|---|---|
| 1 | RBAC profiles + canDo/canView helpers | P1 | S | 5h | **~1.5h** | **shipped** | 2026-06-07 (commits `6cf6f1e` → `5d10e5f`) | Migration + lib + refactor + tests + coordination notes done in a single short session. **Variance: −70%** (3.5h under projection). Why: small surface, well-scoped session-notes spec, no surprises. |
| 2 | activity_log entity refs + per-serial timeline | P2 | S | 5h | **~1h** | **shipped** | 2026-06-07 (commits `8d7f630` → `7326f64`) | Single migration (no CONCURRENTLY needed at 312 rows), straightforward lib extension, targeted refactor at 12 call sites. **Variance: −80%**. Why: tiny table, no backfill, opt-in pattern keeps blast radius small. |
| 3 | Bidirectional Linear/GitHub linking | P3 | S | 5h | — | planned | — | Webhook plumbing is the unknown. Both Linear + GitHub need separate auth setup (~1h overhead each). |
| 4 | Mobile V1 (viewport + PWA + AppShell) | P1 | M | 15h | **~2h** | **shipped** | 2026-06-07 (commit `2ebe867`) | Five-file change: viewport-fit=cover + theme-color/apple-mobile-web-app metas, new public/manifest.json (standalone + crimson theme), GlobalNav narrow-aware (700px breakpoint, scroll-snap module strip, 44px touch targets, hover:none color bump), AppShell main padding with env(safe-area-inset-*) + 100dvh, globals.css body safe-area + 44px button floor. **Variance: −87%** (13h under projection). Why: no operator workflow rewiring — pure layout adjustments, no new components, existing CSS Modules architecture absorbed it cleanly. Physical iPhone UAT still TBD; that's the 1-week validation cycle the spec called out. |
| 5 | Finance module skeleton + JournalPanel (QBO) | P1 | M | 15h | — | planned | — | QBO OAuth2 setup is the front-loaded cost (~2h). Multi-currency edge cases are the validation cost (~2h). |
| 6 | ProductionProjectionPanel (Finance) | P2 | M | 15h | — | planned | — | Depends on #5 (Finance module shell). Snapshot table + burn-down chart logic. |
| 7 | SalesProjectionPanel rolling-average | P2 | M | 15h | — | planned | — | Depends on #6 (Finance module shape stabilized). Pipeline-driven variant deferred to P3. |
| 8 | Mobile V2 (per-module card-row tables) | P2 | L | 45h | — | planned | — | Largest item. Could pair on individual modules — Junaid on Service, Reina on PostShipment, Pedrum on OrderReview — but Huayi owns the CSS strategy + breakpoint logic. |

**Huayi running total:** 4.5h actual / 120h projected · **3 of 8 features shipped (38%)** · variance trending −80% (first M item came in at −87%, confirming the under-projection pattern extends past S items).

## Pedrum — 10 features, projected 90h, actual TBD

| # | Feature | Pri | Size | Projected | Actual | Status | Shipped on | Notes / variance |
|---|---|---|---|---|---|---|---|---|
| 1 | Klaviyo Track API event firehose | P1 | S | 5h | — | planned | — | Klaviyo Track API key setup is the front-loaded cost. |
| 2 | PaymentCard UI on OrderReview | P1 | S | 5h | — | planned | — | Pure read-only UI on existing columns — should ship in 1 session. |
| 3 | Lead attribution fields | P1 | S | 5h | — | planned | — | Migration + customer-create hook update. UTM parsing is the unknown. |
| 4 | Freight quote history table | P2 | S | 5h | — | planned | — | New child table + lib/freight.ts wrapper. ClickShip+Freightcom calls already exist; just wrap. |
| 5 | Klaviyo predictive properties pull-back | P2 | S | 5h | — | planned | — | Nightly edge function. Depends on Feature 1 having populated klaviyo_profile_id. |
| 6 | CAC by channel view | P2 | S | 5h | — | planned | — | UI on data from Features 1 + 7. |
| 7 | Facebook Marketing API + Lead Ads webhook | P1 | M | 15h | — | planned | — | Meta Business System User token approval has ~1-2 week lead time outside Claude. |
| 8 | CampaignsTab aggregating FB + Klaviyo + HubSpot | P1 | M | 15h | — | planned | — | Depends on Feature 7. New Marketing module entry. |
| 9 | Facebook CAPI server-side events | P2 | M | 15h | — | planned | — | iOS-14 ATT recovery. Dedup key alignment with client-side Pixel is the watch-out. |
| 10 | HubSpot CRM decommission window | P2 | M | 15h | — | planned | — | Sequence migration is the unknown — depends on Pedrum sign-off after Klaviyo Track is live. |

**Pedrum running total:** 0h actual / 90h projected · 0 of 10 shipped.

## Junaid — 7 features, projected 75h, actual TBD

| # | Feature | Pri | Size | Projected | Actual | Status | Shipped on | Notes / variance |
|---|---|---|---|---|---|---|---|---|
| 1 | Warranty registration entity | P1 | S | 5h | — | planned | — | Depends on Huayi's RBAC (shipped). |
| 2 | units.status quarantine enum value | P1 | S | 5h | — | planned | — | Single enum value add + Fulfillment queue filter update. |
| 3 | UnitTimeline.tsx component | P2 | S | 5h | — | planned | — | Depends on Huayi's activity_log entity refs (shipped) — now a single `useActivityForEntity({ unitSerial })` call. |
| 4 | Device-context header on Service tickets | P1 | M | 15h | — | planned | — | Joins units + telemetry + ticket count + warranty badge. The chip strip is straightforward; the cross-Supabase join is the watch-out. |
| 5 | SLA aging + auto-escalation | P1 | M | 15h | — | planned | — | pg_cron every 15min. SLA policy seed values + notify edge function. |
| 6 | Telemetry-driven ticket auto-create | P1 | M | 15h | — | planned | — | Depends on Feature 4 (device-context header) + Huayi's Klaviyo Track for the event fire. **2-week shadow run before flipping the switch** — backlog #70 documented 75% false-positive on NOT_MIXING. |
| 7 | build_station_passes promotion | P2 | M | 15h | — | planned | — | Future-handoff candidate to Lezhong. Junaid until he's online. |

**Junaid running total:** 0h actual / 75h projected · 0 of 7 shipped.

## Reina — 5 features, projected 65h, actual TBD

| # | Feature | Pri | Size | Projected | Actual | Status | Shipped on | Notes / variance |
|---|---|---|---|---|---|---|---|---|
| 1 | Templates as RAG corpus for AI drafts | P2 | S | 5h | — | planned | — | Substrate for Feature 3. Schema metadata + lib helper. |
| 2 | Returns disposition + grade + quarantine + #79 | P1 | M | 15h | — | planned | — | Depends on Huayi's RBAC (shipped) + Junaid's units.status quarantine (Feature 2). InspectionPanel UI is the bulk of the work. |
| 3 | AI-drafted reply suggestions (Service) | P2 | M | 15h | — | planned | — | Depends on Feature 1. Claude haiku-4-5 reuse pattern from lib/orders.ts. URL hallucination watch-out (backlog #72). |
| 4 | OKR & KPI tracking (ActivityLog) | P2 | M | 15h | — | planned | — | Depends on Huayi's activity_log entity refs (shipped). New okrs table + okr_progress view. Privacy posture — no public individual scoring. |
| 5 | Customer record sidebar widgets (Attio pattern) | P3 | M | 15h | — | planned | — | Right-rail UI on existing data. Configurable widget order is optional polish. |

**Reina running total:** 0h actual / 65h projected · 0 of 5 shipped.

---

## Cross-cutting / coordination items

| Item | Projected | Actual | Notes |
|---|---|---|---|
| Julie / yueli@virgohome.io added to access list | 0.5h | ~0.3h | 2026-06-07 commit `1685477`. Migration + FINANCE_EMAILS swap + OPS_OWNERS + profile display-name fix in one shot. |

---

## Calibration delta — does the S/M/L sizing match reality?

Compute weekly. Two of the eight Huayi P1+P2 substrate features shipped today; both were S items.

| Size | Projected hours | Actual hours so far | n | Variance | Trend |
|---|---|---|---|---|---|
| S | 5h | 1.25h average (2.5h / 2) | 2 | **−75%** | Re-calibrate S → ~3h once n ≥ 5 |
| M | 15h | 2h (single sample — Mobile V1) | 1 | **−87%** | Need n ≥ 3 before re-calibrating; if pattern holds, M → ~3–5h |
| L | 45h | — | 0 | — | — |

**Why S items are running so far under projection:**
- Single engineer + Claude Code substantially compresses what was a "1 PR / week / dev + QA cycle" assumption.
- Well-scoped session-notes briefs eliminate scope ambiguity at start of session.
- Repo conventions (CSS Modules, lib/*.ts data layer, logAction pattern) keep new code small + reviewable.
- Migration + apply directly via MCP tool eliminates Supabase CLI overhead.

**When to re-calibrate hour sizes:** once at least 5 features of a given size have shipped with actual hours recorded. If S is consistently 60-80% under projection, drop S to 3h in the next PRD revision. M + L need their own n=5 baselines before we touch them — they're more likely to have wider variance because of dependency surprises.

## What this enables

- **Future PRD revisions** can use observed cadence rather than industry-standard assumptions.
- **Sprint planning** for the team can be honest about what fits in a week (today: ~Huayi 25h, Junaid 15h, Pedrum 15h, Reina 10h × variance factor).
- **Per-shipper calibration** if it turns out one shipper consistently runs faster or slower than another — adjust their weekly_hours assumption in [makelila_PRD_review.html](../../makelila_PRD_review.html) accordingly.
- **Effort-to-token correlation** — Token Budget §16 in the interactive review estimates tokens per S/M/L; as actuals roll in, recalibrate those too if the relationship shifts.
