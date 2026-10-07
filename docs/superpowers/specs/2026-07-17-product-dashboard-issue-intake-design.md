# Product Module Dashboard + AI Issue Intake

**Date:** 2026-07-17
**Status:** Approved design, pending implementation plan

## Context

The Products module (`app/src/modules/Products/`) shows 7 shippable product
lines (LILA Pro, Mini, Mega, makeLILA, Lovely App, LILA Shop, LILA
Marketplace) plus a Technical R&D tab. Every product's data — stage,
KPIs, issues, timeline, volumes, BOM, team, PRD, journey, PMF — is a static
hardcoded object in `data.ts`. There is no database backing and no way to
add a new issue except editing the source file and redeploying.

Two requests:

1. A dashboard, positioned as the first tab (before LILA Pro), summarizing
   critical stats across all 7 product lines.
2. An AI-assisted issue-intake chat on that dashboard: a team member
   describes an issue in conversation (product line, description/link,
   accountable person), and a DeepSeek-backed classifier files it onto the
   right product's issue list once it has enough information.

Building (2) on top of still-static issue data would mean two disconnected
sources of truth (data.ts text vs. chat-filed rows) with no way for the
dashboard to count both consistently. So this spec also migrates issue
data (only — not BOM/team/PRD/journey/PMF, which stay static) to Supabase.

## Goals

- New "Dashboard" tab, first in the tab bar, active by default on load.
- Fleet-wide KPI row (total open issues, total critical, total MP
  blockers, product-line count) computed live.
- Per-product-line card grid (7 cards: stage + open/critical issue count),
  click-through to that product's existing tab.
- Multi-turn chat panel on the dashboard: team member describes an issue,
  DeepSeek asks for whatever's missing (product, description, accountable
  person), then files it once it has enough to do so.
- Filed issues appear immediately (realtime) in the dashboard, tab badge
  counts, and that product's existing Issues tab — no manual refresh.
- All existing static issue data (~50 issues across 7 lines) preserved
  exactly, now served from a DB table instead of `data.ts`.

## Non-Goals

- Migrating anything other than `issues` to Supabase (BOM, team, PRD,
  journey, PMF, timeline, volumes, KPI strip text all stay static, hand-
  maintained in `data.ts` as today).
- Issue editing/closing/status workflow in the UI. This spec only adds
  issues; resolving or reclassifying existing ones is a follow-up.
- Technical R&D tab — different data shape (research projects, not
  issue-tracked units), explicitly excluded from the dashboard and from
  the `product_issues` table's product set.
- Persisting chat conversation history. Each browser session's chat state
  is ephemeral (lost on refresh) — only the *filed issue* is durable.
- Native LLM tool/function-calling. The classifier uses the same
  plain-JSON-response pattern as the existing Claude ticket classifier
  (`supabase/functions/_shared/classifier-llm.ts`), for consistency.

## Design

### 1. Migration (ops DB)

One migration file containing:

**a. `product_issues` table**

```sql
create table public.product_issues (
  id              uuid primary key default gen_random_uuid(),
  product_id      text not null check (product_id in
                    ('pro','mini','mega','makelila','lovely','shop','marketplace')),
  title           text not null,
  severity        text not null check (severity in ('critical','high','medium','low')),
  tag             text not null default 'Other',
  team            text,                    -- accountable person/team, freeform
  meta            text not null,           -- description body
  link            text,                    -- optional URL, nullable
  mp_blocker      boolean not null default false,
  source          text not null default 'chat' check (source in ('seed','chat')),
  created_by      uuid references auth.users(id),
  created_by_name text,
  created_at      timestamptz not null default now()
);
```

RLS: `rls_internal_only` pattern (same as sibling internal tables, e.g.
`customer_serial_overrides`) — authenticated VCycene org users can
select/insert; no anon/public access. The edge function's service-role
client bypasses RLS for its own inserts.

**b. Extend `activity_entity_type` enum**

```sql
alter type public.activity_entity_type add value 'product_issue';
```

So chat-filed issues get a normal `activity_log` row like every other
mutation (`entity_type='product_issue'`, `entity_id=<issue id>`).

**c. Seed data**

INSERT statements for all ~50 existing issues, copied verbatim from
`data.ts` (`title`→title, `sev`→severity, `tag`→tag, `team`→team,
`meta`→meta, `mpBlocker`→mp_blocker), `source='seed'`, `created_by=null`.
Expected per-product counts (must match after seeding): Pro=24, Mini=7,
Mega=0, makeLILA=1, Lovely=10, Shop=6, Marketplace=2.

**d. `data.ts` cleanup**

For the 7 migrated products, `issues: [...]` becomes `issues: []`. No
other fields touched — this is the only change to `data.ts`.

### 2. `lib/products.ts` (new)

- `DbIssue` type: DB row shape, plus a mapper to the existing `Issue`
  interface (`{title, sev, tag, team, meta, mpBlocker}`) so downstream
  components need no changes.
- `useProductIssues()`: realtime hook (same shape as `useActivityLog` /
  `useOrders` — initial fetch + `postgres_changes` INSERT subscription on
  `product_issues`) returning `{ issuesByProduct: Record<string, Issue[]>, loading }`.
- `computeFleetStats(issuesByProduct, products)`: pure function → `{
  totalOpen, totalCritical, totalMpBlockers, lineCount, perLine: {
  productId, stage, openCount, criticalCount }[] }`. No React/Supabase
  dependency — unit-testable in isolation.

### 3. Edge function `product-issue-chat` (new)

Request: `{ messages: {role:'user'|'assistant', content:string}[],
product_id: string | null, products: {id,label}[], knownTeam: string[] }`.
`products` and `knownTeam` are supplied by the client (derived from
`PRODUCT_TABS` and the union of every product's `team[].name` in
`data.ts`) — not duplicated server-side.

Flow (mirrors `reclassify-ticket`'s auth/CORS/admin-client scaffolding):

1. `authenticate(req, admin)` — requires an operator JWT, same as
   `reclassify-ticket`.
2. Read `DEEPSEEK_API_KEY` from Supabase secrets. If missing, return `{
   reply: "Chat isn't configured yet — ask an admin to set
   DEEPSEEK_API_KEY.", filed: false }` at **200** (graceful — same
   missing-key-degrades-gracefully pattern as `classifier-llm.ts`).
3. Build a system prompt: valid product ids/labels, known team roster
   (prefer a roster match, free text accepted if no match), the current
   `product_id` hint if set ("user has pre-selected X; only ask if they
   name a different product"), and a strict JSON response contract:
   ```
   { "reply": string,
     "ready_to_file": boolean,
     "issue": { "product_id", "title", "severity", "tag", "team",
                "meta", "link", "mp_blocker" } | null }
   ```
4. POST to `https://api.deepseek.com/chat/completions`
   (`model: "deepseek-chat"`, `response_format: {type:"json_object"}`,
   full conversation + system prompt).
5. Parse the JSON. If `ready_to_file` is true, validate `issue`
   (`product_id` in the known set, `severity` in the enum, `title`/`meta`
   non-empty) before trusting it — a malformed or hallucinated payload
   just continues the conversation (`filed:false`) instead of writing
   garbage.
6. On a valid ready-to-file: insert into `product_issues`
   (`source='chat'`, `created_by`=caller's user id, `created_by_name`
   resolved from `profiles`) and into `activity_log`
   (`type:'product_issue_filed'`, `entity_type:'product_issue'`,
   `entity_id:<new id>`, `detail: "<product_id> · <severity>"`), in the
   same request — no second model round-trip needed to confirm.
7. Respond `{ reply, filed, issue?: {id, title, product_id} }`.

DeepSeek network/parse failures return `{ reply: "Sorry, I couldn't reach
the classifier — try again in a moment.", filed: false }` at 200, never a
hard error surfaced to the chat UI.

### 4. `Products/DashboardTab.tsx` (new)

- Fleet KPI row from `computeFleetStats()`.
- 7-card grid (Pro/Mini/Mega/makeLILA/Lovely/Shop/Marketplace): stage +
  open/critical counts; click calls a `onSelectProduct(id)` prop to jump
  to that tab (same tab-switch mechanism the root component already
  uses).
- Renders `<IssueChatPanel />` below the grid.

### 5. `Products/IssueChatPanel.tsx` (new)

- Product dropdown (default "unset"; chat text can override — the
  dropdown just seeds `product_id` sent to the edge function).
- Chat thread: local React state array of turns, rendered as bubbles.
  User sends → appended to state → `supabase.functions.invoke('product-issue-chat', {...})`
  → assistant reply appended. On `filed:true`, the bubble gets a "Filed ✓"
  affordance; no manual refresh needed since `useProductIssues()`'s
  realtime subscription picks up the INSERT and every consumer
  (dashboard, tab badges, that product's Issues tab) updates on its own.
- Loading indicator while awaiting the edge function response.

### 6. `Products/index.tsx` changes

- `PRODUCT_TABS` gets a new leading entry `{ id:'dashboard', label:'Dashboard' }`.
- `activeProd` initial state changes from `'pro'` to `'dashboard'`.
- Root `Products()` calls `useProductIssues()` once; passes
  `issuesByProduct` to `DashboardTab` and to `ProductPage`.
- `ProductPage` builds its `d` as `{ ...PRODUCTS[prod], issues:
  issuesByProduct[prod] ?? [] }` before rendering — `OverviewTab` and
  `IssuesTab` are **unchanged**, since they already just read `d.issues`.
- Tab-bar badge rendering: replace the static `d?.badgeCount` read with
  a live count derived from `issuesByProduct[tab.id]` (color still driven
  by whether any critical issue exists) — this is the direct correctness
  fix that falls out of making issues live, so it's in scope.
- Render branch: `activeProd === 'dashboard' ? <DashboardTab .../> :
  activeProd === 'rd' ? <RDView/> : <ProductPage .../>`.

## Testing

- `lib/products.test.ts`: `computeFleetStats()` against fixture data
  (known input → known aggregates) and the DB-row→`Issue` mapper. Pure
  functions, no network, no Supabase — follows existing `.test.ts`
  convention.
- Manual QA after migration: per-product seed counts match the static
  baseline (Pro=24, Mini=7, Mega=0, makeLILA=1, Lovely=10, Shop=6,
  Marketplace=2); Overview/Issues tabs render identically pre- and
  post-migration; end-to-end chat filing test with a real
  `DEEPSEEK_API_KEY`, confirming the new issue appears in the Issues tab
  and dashboard without a page refresh.
