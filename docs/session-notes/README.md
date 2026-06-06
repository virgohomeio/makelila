# Session Notes — makeLILA shipping briefs

This directory holds **per-shipper feature briefs** for the 29 features in PRD v1.2 P1/P2/P3 plan, allocated across the four current shippers.

## How a Claude Code agent should use this directory

When a shipper opens a Claude Code session in this repo, the agent should:

1. Read [CLAUDE.md](../../CLAUDE.md) (already loaded automatically by Claude Code).
2. Identify the operator from `git config user.email` or the user's first message.
3. **Read the corresponding `<shipper>.md` file from this directory** before touching code.
4. For the specific feature being shipped, follow the per-feature brief — it tells you the goal, the work, validation methods, watch-outs, and which files to load into context first.

Each file is self-contained — an agent shouldn't need to read the others.

## Files

| Shipper | File | Features | Hours | Domain |
|---|---|---|---|---|
| **Pedrum Amin** | [pedrum.md](pedrum.md) | 10 | 90h | Sales + Pre-sale (no CS) |
| **Junaid Siddiqui** | [junaid.md](junaid.md) | 7 | 75h | Customer Service + Stock |
| **Reina** | [reina.md](reina.md) | 5 | 65h | Customer Service |
| **Huayi Gao** | [huayi.md](huayi.md) | 8 | 120h | Cross-cutting + restricted Finance + Mobile + 1 CS P3 |

Total: 30 features (1 duplicate Lead-attribution counted on both sides) · ~350h team load · ~5.4 weeks parallel at default capacity.

> **Future shippers** — George and Lezhong will join later. Their files will be added once their initial assignments are scoped. Today the only explicit future-handoff candidate is `build_station_passes promotion` (currently with Junaid → Lezhong).

## Structure inside each file

Every shipper's file follows the same shape:

```
# <Name> — Session Notes for makeLILA Shipping

> Quick links to PRD / proposal / backlog / system-of-record

## Your domain
1-2 paragraphs framing what this person owns + does NOT touch.

## How to start a session
Numbered checklist for the boot sequence.

## Conventions to follow
CSS Modules, lib/*.ts data layer, logAction() everywhere, etc.

## Features (N total, ~Xh)
Per-feature brief template:

### Feature N: <name>
**Priority** · **Effort** (~Xh) · **Tokens** (~XM)
**Files to touch** · **Depends on** · **Blocks**

#### Goal
2-4 sentences on the operator pain + why it matters.

#### Work to do
- Schema migration: exact column/table changes
- lib/ function: function signatures + responsibilities
- UI: component, props, where rendered
- Edge function (if any): path + behavior
- Activity log calls: action_type strings
- Tests: vitest unit + Playwright e2e

#### Validation
- Unit tests
- E2E test path
- Operator UAT (who tests + what they look for)
- Acceptance criteria

#### Watch-outs
- Known pitfalls
- Schema gotchas (RLS, FK ordering, enum CHECK constraints)
- Cross-module dependencies that could break
- Edge cases

#### Files to load into Claude context at session start
- Specific files this work touches
- Related shipped patterns to mirror
- Search keywords

## Quick session start cheat sheet
One-page minimum commands to begin a feature.
```

## How features were allocated

Per the domain rules captured in the [PRD v1.2](../PRD-2026-06-06.md) and the interactive review at [makelila_PRD_review.html](../../makelila_PRD_review.html):

- **Customer Service** work splits across Huayi + Reina + Junaid.
- **Stock module** work goes to Junaid (he uses unit serials daily in the repair flow).
- **Sales + Pre-sale modules** go to Pedrum exclusively — no CS items on his queue.
- **Cross-cutting substrate** (RBAC, activity_log entity refs, Mobile) goes to Huayi because it blocks the other three.
- **Restricted Finance module** goes to Huayi (co-owner with George once George ships code).

## Cross-shipper dependencies

Some features block other features across shippers. Ship-order discipline:

1. **Huayi must ship RBAC + canDo/canView first** — Junaid's Warranty registration, Reina's Returns disposition, and the Finance module skeleton all depend on it.
2. **Huayi must ship activity_log entity refs early** — Junaid's UnitTimeline + Reina's OKR/KPI both wait on it.
3. **Pedrum's Klaviyo Track API firehose** unblocks his own Klaviyo predictive pull-back + HubSpot decommission, and also lets Junaid's telemetry auto-ticket fire `telemetry_status_changed` events to Klaviyo.
4. **Reina's Templates RAG corpus** is substrate for her own AI-drafted reply suggestions; if she defers it, the AI work blocks.

Each per-shipper file calls out these inter-shipper dependencies in the "Depends on" line of each affected feature.

## Updating these notes

These files are working session notes, not contracts. Update them as features ship or scope changes:

- After shipping a feature, replace its section with a one-line "shipped 2026-MM-DD, commit `<sha>`" stub so the agent can see what's complete vs pending.
- When the PRD or the interactive review HTML changes priority/ownership, mirror the change here.
- When George or Lezhong start shipping, create `george.md` / `lezhong.md` and move any handoff candidates over with a note in the original owner's file.

## Sources

- PRD: [docs/PRD-2026-06-06.md](../PRD-2026-06-06.md) v1.2 (2026-06-06)
- Competitive landscape: [docs/competitive-landscape-and-proposal-2026-06-06.md](../competitive-landscape-and-proposal-2026-06-06.md)
- Feature backlog: [docs/feature-backlog-alpha-feedback.md](../feature-backlog-alpha-feedback.md)
- Interactive review: [makelila_PRD_review.html](../../makelila_PRD_review.html) v1.4.1 — open in any browser
- System of record: [docs/system-of-record.md](../system-of-record.md)
