# Reina — Session Notes for makeLILA Shipping

> Reference for Reina's Claude Code sessions. Owner: Customer Service — PostShipment Returns disposition/grading + Templates RAG substrate + Service AI-drafted replies + ActivityLog OKR/KPI tracking + Customers sidebar widgets.
> Read this at session start. Each feature below is a complete shipping brief.
> Last updated 2026-06-07.

## Recent substrate landings (Huayi)

- **2026-06-07 — RBAC substrate landed** (commits `6cf6f1e` → `5d10e5f`, migration `20260607020000_profiles_role_enum_and_canDo_canView.sql`). `profiles.role` enum is live; `canDo(role, action)` and `canView(role, module)` available from [lib/permissions.ts](../../app/src/lib/permissions.ts); `useAuth()` now exposes `role`. **For your Returns disposition writes:** gate via `canDo(role, 'dispose_unit')` (allowed for manager + finance + admin). RLS helpers `is_manager()` and `is_finance()` are available for any new table policies — when you add the disposition columns to `returns`, you can write the UPDATE policy with `with check (public.is_manager())` to backstop the UI gate. Finance role seed is George + Huayi + Julie (yueli@virgohome.io).

## Quick links

- PRD: `docs/PRD-2026-06-06.md`
- Competitive proposal: `docs/competitive-landscape-and-proposal-2026-06-06.md`
- Feature backlog: `docs/feature-backlog-alpha-feedback.md`
- System of record: `docs/system-of-record.md`

## Your domain

Reina runs Onboarding + CX. Per PRD §3, her daily flow is: (1) new-customer queue pulled from `Customers/JourneyTab` showing the 10-stage CJM and any `journey_stage_override`, (2) Day 1 / 3 / 7 / 14 / 21 / 30 onboarding signals surfaced in `Service/OnboardingTab` driven off `customers.first_brew_at`, `customers.last_telemetry_at`, and the Quo/Gmail thread classifier, (3) inbox triage on threads tagged `onboarding`, `cx`, or `review_request`, (4) the `awaiting_review → routine_use` transition that gates Klaviyo review-request flows, and (5) an EOD OKR/KPI check-in. Her core modules today are `Service/OnboardingTab.tsx`, `Customers/JourneyTab.tsx`, and `Templates/index.tsx`.

The new work below expands her authority into PostShipment Returns (the inspection / grade / disposition workflow that closes backlog #2 and the new #79 quarantine ask) and adds shared ownership of the Service module's AI-draft layer alongside Junaid — Reina owns the RAG draft pipeline; Junaid owns device-context, SLA, and telemetry-driven auto-tickets. She also owns the OKR/KPI surface on top of `activity_log` (depends on Huayi's entity-refs migration) and the right-rail widgets on Customer records (Attio pattern).

## How to start a session

1. `cd e:\Claude\makelila\app` — every command in this file assumes this CWD.
2. `git fetch && git pull --rebase origin main` — rebase, don't merge; we keep `main` linear.
3. Read `e:\Claude\CLAUDE.md` (root guardrails) and `e:\Claude\makelila\CLAUDE.md` (project rules) before opening any feature brief.
4. Read this file's relevant feature section end-to-end. Don't skip "Watch-outs" — that's where the schema and RLS gotchas live.
5. Open the files in the "Files to load into Claude context at session start" list for the feature you're working on. Load them with the Read tool; don't re-derive from grep.
6. Run `npm run dev` in one terminal and `npx vitest --watch` in another. Keep both visible.
7. Ship small commits. One migration per commit, one UI slice per commit, one test file per commit. Commit messages: `feat(post-shipment): add returns.grade enum` style.
8. Before opening a PR, run `npm run build && npm test && npx playwright test --grep <your-feature>` locally. CI is slow; don't burn 12 minutes finding out a unit test fails.

## Conventions to follow

- **CSS Modules only** — no Tailwind, no inline styles except one-off layout overrides (`style={{ marginTop: 8 }}` is fine; styled buttons are not). Co-locate `.module.css` next to the component.
- **Data layer through `lib/*.ts`** — components never `import { supabase } from './supabase'`. If you need a new query, add a hook (`useReturnsInspection`) or a function (`saveReturnInspection`) in the relevant `lib/` file. There is no exception to this rule. It exists so the eventual REST→edge-function migration touches one file per domain.
- **Supabase realtime by default** — every list view subscribes to its source table via `supabase.channel(...).on('postgres_changes', ...)`. Pattern is already used in `lib/postShipment.ts` `useReturns` and `lib/service.ts` `useTickets` — copy it.
- **`logAction()` everywhere** — every mutation logs an `activity_log` row. The OKR/KPI feature you're building (Feature 4) literally aggregates over this table, so if you forget a `logAction` call your own dashboards will under-report. The pattern is `await logAction({ type: 'return_inspected', detail: {...}, ref_table: 'returns', ref_id: returnId })`.
- **Photo/video attachment auto-note pattern** — already shipped in `Service/AttachmentStrip.tsx` and `Service/TicketNotes.tsx`. When you add inspection photos to returns (Feature 2), reuse `AttachmentStrip` and the `attachments` storage bucket; don't reinvent.
- **Template variables** — use the existing `{{customer_first_name}}` / `{{unit_serial}}` Mustache-style placeholders. The variable resolver lives in `lib/templates.ts` `renderTemplate()`. Feature 1 extends it; Feature 3 consumes it.
- **Migration naming:** `YYYYMMDDHHMMSS_description.sql`. Use the same timestamp prefix as the rest of the file batch when shipping a multi-migration feature.
- **Anthropic SDK** is already in the repo (`@anthropic-ai/sdk`) — currently used by `lib/orders.ts` for address verification with `claude-haiku-4-5`. Reuse the same client and model for AI drafts (Feature 3); don't introduce a second SDK instance.

## Features (5 total, ~65h)

Ordered by dependency. Feature 1 unblocks Feature 3. Feature 4 depends on Huayi's `activity_log` entity-refs migration shipping first. Feature 5 depends on Pedrum's Klaviyo predictive pull.

---

### Feature 1: Templates as RAG corpus for AI drafts

**Priority:** P2 · **Effort:** S (~5h) · **Tokens:** ~0.4M
**Files to touch:**
- `supabase/migrations/<ts>_templates_rag_metadata.sql` (new migration)
- `app/src/lib/templates.ts` (extend types + add `getTemplatesForContext`)
- `app/src/lib/templates.test.ts` (new — Vitest)
- `app/src/modules/Templates/index.tsx` (UI fields for new metadata)
- `app/src/modules/Templates/index.module.css` (form layout for new fields)

**Depends on:** Nothing. This is the foundation for Feature 3 and should ship first.

#### Goal

The Templates module is already where George, Julie, Reina, and Junaid curate the canned messages they send hundreds of times a week. Today those rows are flat strings keyed by status. We're turning that same table into a dual-purpose RAG corpus: still human-editable, still used by the existing `Send template` button, but now also queryable by an `AI-suggested reply` selector that Feature 3 builds on top. The Inkeep/Plain pattern: the knowledge base doubles as both human help center and AI retrieval surface, so operators improve both at once when they edit a template.

Why it matters: Feature 3 is the highest-leverage CX win of the quarter, but it must not free-write replies (backlog #72 — a hallucinated Trustpilot URL went out to a customer). The only way to keep the AI bounded to known-safe content is to make it select from a curated corpus and fill variables. Feature 1 builds that corpus structure.

#### Work to do

**Migration.** Add to `templates`:
- `template_kind` enum (`status_keyed`, `canned`, `ai_corpus`) NOT NULL DEFAULT `'canned'`. `status_keyed` = the existing fulfillment-status auto-sends; `canned` = operator-triggered manual sends; `ai_corpus` = explicitly maintained for RAG even if rarely sent by humans.
- `tags` text[] NOT NULL DEFAULT '{}' — free-form labels like `{'return','shipping_damage','refund'}`.
- `variables_schema` jsonb NOT NULL DEFAULT '{}' — JSON-schema-lite shape describing required variables. Example: `{"customer_first_name":{"type":"string","required":true},"return_label_url":{"type":"string","required":true}}`. Feature 3 uses this to know what to autofill.
- `context_hint` text — operator-written note: "Use when customer asks for refund status more than 5 days after return arrived."
- `ai_eligible` boolean NOT NULL DEFAULT true. Set false for legal templates, refund-amount-correction templates, and anything that requires Finance approval before sending. This is the kill switch.
- Index: `CREATE INDEX templates_tags_gin ON templates USING gin(tags);` for fast tag-based retrieval in Feature 3.

**lib/templates.ts.** Extend the `TemplateRow` interface with the new columns. Add:

```ts
export interface TemplateContext {
  topic: string;          // e.g. 'return_status', 'shipping_damage'
  customer_segment?: 'prospect' | 'onboarding' | 'routine_use' | 'churned';
  channel: 'email' | 'sms';
  required_variables?: string[]; // variables the caller can supply
}

export async function getTemplatesForContext(
  ctx: TemplateContext
): Promise<Array<{ template: TemplateRow; score: number; reason: string }>>
```

Scoring v1 is deterministic, not embeddings: +3 per matching tag, +2 if `channel` matches, +2 if `customer_segment` appears in `context_hint`, -10 if `ai_eligible=false`, -5 per missing required variable. Return top 5 ranked. Embeddings are a v2 problem; ship the deterministic version first because it's debuggable and won't surprise Reina with weird picks.

**UI.** In `Templates/index.tsx` add to the edit drawer: a `template_kind` select, a tag chip input (reuse the chip input from `OrderReview/detail/AddressCard.tsx`), a variables-schema JSON editor (a plain `<textarea>` validating JSON onBlur is fine for v1 — no need for a schema-builder UI), a `context_hint` textarea, and a prominent `ai_eligible` toggle with a tooltip explaining "Off = never used by AI drafts, even if matched." Show a small `AI` badge on cards where `ai_eligible=true`.

**Activity log.** Log `template_metadata_updated` with `detail: { fields_changed: [...] }` on save. This is how Reina later audits "who turned off ai_eligible on the refund template."

#### Validation

- Vitest: `getTemplatesForContext` ranking is deterministic — write 6 fixture templates and assert order for 3 contexts.
- Vitest: `ai_eligible=false` templates never appear in results, even with perfect tag match.
- Manual: edit a template in the UI, save, reload, confirm tags + JSON round-trip cleanly.
- Acceptance: Reina can mark the existing "Refund issued — Sezzle" template as `ai_eligible=false` in under 60 seconds, and confirm via Activity Log that the change was recorded.

#### Watch-outs

- `variables_schema` is jsonb, not a typed column. Don't trust it on read — validate against an actual schema in `renderTemplate()` and surface missing-variable errors clearly. Feature 3 depends on this contract.
- Don't migrate existing templates' `template_kind` to `ai_corpus` automatically. Default everything to `canned`. Reina opts them in explicitly. This prevents Feature 3 from suddenly suggesting a template no one has reviewed for AI use.
- RLS: keep the existing `templates` policy. Don't introduce per-row RLS just because some templates are AI-related.
- The `tags` GIN index is small; don't over-engineer with trigram. We have <500 templates.

#### Files to load into Claude context at session start

- `app/src/lib/templates.ts` (entire file — small)
- `app/src/modules/Templates/index.tsx`
- `app/src/lib/postShipment.ts` (for the `refund_method` + `finance_review` enum pattern already shipped — mirror it for `template_kind`)
- `supabase/migrations/` — list the last 3 migrations to copy the naming + RLS-grant boilerplate.
- Search keywords: `template_kind`, `ai_eligible`, `renderTemplate`, `chip input`.

---

### Feature 2: Returns disposition + grade + quarantine + #79 — closes biggest active operator pain

**Priority:** P1 · **Effort:** M (~15h) · **Tokens:** ~1.2M
**Files to touch:**
- `supabase/migrations/<ts>_returns_inspection_workflow.sql`
- `app/src/lib/postShipment.ts` (extend types + add inspection mutations)
- `app/src/lib/postShipment.test.ts` (extend)
- `app/src/modules/PostShipment/ReturnsTab.tsx` (add Inspection column + button)
- `app/src/modules/PostShipment/InspectionPanel.tsx` (NEW)
- `app/src/modules/PostShipment/InspectionPanel.module.css` (NEW)
- `app/src/modules/PostShipment/DashboardTab.tsx` (add Pareto + Grade tiles)
- `app/src/modules/PostShipment/RefundsTab.tsx` (gate refund approval on inspection complete)
- `tests/e2e/returns-inspection.spec.ts` (NEW — Playwright)

**Depends on:** Junaid's `units.status='quarantine'` enum value migration must merge first. Don't start the inspection migration until you can grep his PR and confirm `quarantine` is in the `units.status` check constraint or enum.

#### Goal

Returns today land in the queue with a reason, a refund request, and nothing else. Operators have no structured way to record what came back, what condition it's in, who's responsible, or where the unit should go next. The result: refunds approved before inspection (business-rule violation per CLAUDE.md backlog #2), no team-attribution data to drive root-cause fixes, and physical units sitting on the receiving dock with no system state.

This feature closes backlog #2 (Returns & Refunds overhaul) and the newly-filed #79 (quarantine flag for returned units) in one workflow. Inspired by ReturnLogic's grade/disposition pairing and their responsible-team Pareto. After this ships, the refund approval gate (already shipped in `RefundsTab` + `lib/postShipment.ts` `finance_review` FSM) literally will not unlock until inspection is complete.

#### Work to do

**Migration.** Add to `returns`:
- `grade` enum (`A_resale`, `B_refurbish`, `C_secondary`, `D_scrap`) NULL — operator-set during inspection.
- `disposition` enum (`restock`, `refurbish`, `RTV`, `scrap`, `parts_harvest`) NULL.
- `responsible_team` enum (`manufacturing`, `shipping`, `software`, `cx`, `financing`, `na`) NULL.
- `inspection_findings` text NULL.
- `inspection_photos` jsonb NOT NULL DEFAULT '[]' — array of `{ path, bucket, uploaded_at, uploaded_by }`, matching the `Service/AttachmentStrip` storage shape.
- `recoverable_value_usd` numeric(10,2) NULL.
- `received_at` timestamptz NULL.
- `inspected_at` timestamptz NULL.
- `inspected_by` uuid NULL REFERENCES profiles(id).

Also add a partial index for the dashboard: `CREATE INDEX returns_inspected_idx ON returns (inspected_at) WHERE inspected_at IS NOT NULL;`.

**lib/postShipment.ts.** Extend `ReturnRow` with the new columns. Add:

```ts
export async function saveReturnInspection(input: {
  return_id: string;
  scanned_serial: string;       // must match returns.serial_expected or warn
  grade: ReturnGrade;
  disposition: ReturnDisposition;
  responsible_team: ResponsibleTeam;
  inspection_findings?: string;
  inspection_photos?: AttachmentRef[];
  recoverable_value_usd?: number;
}): Promise<ReturnRow>
```

Inside it:
1. Verify serial. If mismatch, return `{ error: 'serial_mismatch', expected, scanned }` — don't block, but surface clearly in UI.
2. Set `inspected_at = now()`, `inspected_by = auth.uid()`.
3. If `disposition IN ('refurbish','RTV','scrap','parts_harvest')`, update `units.status = 'quarantine'` for the matching serial. This is the #79 piece.
4. `logAction({ type: 'return_inspected', detail: { grade, disposition, responsible_team, serial_match }, ref_table: 'returns', ref_id: return_id })`.

Add a static auto-suggest map:
```ts
export const REASON_TO_TEAM: Record<ReturnReason, ResponsibleTeam> = {
  product_defect: 'manufacturing',
  software_issue: 'software',
  shipping_damage: 'shipping',
  customer_service_issue: 'cx',
  financing_issue: 'financing',
  other: 'na',
};
```
The UI pre-selects from this map but the operator can override. Track overrides via `logAction` so we can later audit whether the map is wrong.

**Gate the refund approval.** In `RefundsTab.tsx` (and in `lib/postShipment.ts` `approveRefund`), check `returns.inspected_at IS NOT NULL` before allowing the existing manager-approval button to fire. Show a "Awaiting inspection" chip on the refund row when blocked. This enforces backlog #2's business rule "no refund before unit received."

**InspectionPanel.tsx.** New panel that slides over `ReturnsTab` when an operator clicks `Inspect`. Layout: top — serial scan input (autofocus, supports keyboard wedge scanner) with expected serial shown; middle — grade radio (A/B/C/D with one-line descriptions), disposition select, responsible-team select (pre-filled from REASON_TO_TEAM with an "auto-suggested" annotation), recoverable-value number input; bottom — findings textarea and `AttachmentStrip` for photos. Sticky `Save inspection` button at bottom that calls `saveReturnInspection` and closes the panel on success.

**Dashboard tiles.** Add to `PostShipment/DashboardTab.tsx`:
- **Reason × Responsible Team Pareto** — stacked bar chart by reason, segmented by team. Reuse `lib/charts.ts` helpers. Pull from `returns` filtered to last 90 days. Hover shows count + recoverable-value sum.
- **Grade Distribution** — donut of A/B/C/D counts last 90 days, with average `recoverable_value_usd` per grade in the tooltip.

#### Validation

- Vitest: `saveReturnInspection` flips `units.status` to `quarantine` for refurbish/RTV/scrap/parts_harvest, but NOT for `restock`.
- Vitest: serial mismatch returns the right error shape and does NOT write `inspected_at`.
- Vitest: `approveRefund` throws when `inspected_at IS NULL`.
- Playwright: full happy path — incoming return → operator opens InspectionPanel → scans serial → fills form → saves → row updates → refund approval button unlocks → manager approves.
- Playwright: serial-mismatch warning surfaces but allows operator override with a confirm dialog.
- Acceptance: Reina + Julie can process 5 sample returns through the new flow in <10 minutes total, and the Pareto tile shows the team breakdown matching what they entered.

#### Watch-outs

- **Junaid's quarantine value MUST exist** before this migration runs. If you ship first you'll either crash on the units.status update or have to ship a placeholder enum value. Coordinate in standup; don't guess.
- The existing `returns` table already has a `reason` column from the backlog #2 first-pass work. Reuse it; don't add `return_reason`. Read `lib/postShipment.ts` first.
- Photos go to the `attachments` storage bucket under `returns/<return_id>/...` — same scheme as Service tickets. Don't create a new bucket.
- RLS: returns are already restricted to staff via the `staff_only` policy. The new columns inherit that. Don't add per-column policies.
- The Pareto tile can get visually noisy with 6 teams × 6 reasons. Cap at top 8 reason bars; bucket the rest as `other`.
- Don't let the operator save inspection without `grade` AND `disposition` AND `responsible_team` — these are the three fields the dashboards depend on. UI should disable the save button until all three are present.
- The `recoverable_value_usd` field is optional and operator-estimated for v1. Don't over-engineer a depreciation calculation; finance will provide a real number later.

#### Files to load into Claude context at session start

- `app/src/lib/postShipment.ts` (entire file — this is the data layer you're extending)
- `app/src/modules/PostShipment/ReturnsTab.tsx`
- `app/src/modules/PostShipment/RefundsTab.tsx`
- `app/src/modules/PostShipment/DashboardTab.tsx`
- `app/src/modules/Service/AttachmentStrip.tsx` (reuse for photos)
- `app/src/lib/charts.ts`
- `app/src/lib/stock.ts` (for the `units` table + `units.status` enum)
- Search keywords: `finance_review`, `approveRefund`, `MANAGER_EMAILS`, `FINANCE_EMAILS`, `quarantine`.

---

### Feature 3: AI-drafted reply suggestions (Service)

**Priority:** P2 · **Effort:** M (~15h) · **Tokens:** ~1.4M
**Files to touch:**
- `app/src/lib/service.ts` (extend `Ticket` type, add `useAiDraft` hook + `logAiDraftDecision`)
- `app/src/lib/aiDraft.ts` (NEW — wrapper around Anthropic SDK + Feature 1's retrieval)
- `app/src/lib/aiDraft.test.ts` (NEW)
- `app/src/modules/Service/TicketDetailPanel.tsx` (Suggested Reply panel)
- `app/src/modules/Service/SuggestedReplyPanel.tsx` (NEW component)
- `app/src/modules/Service/SuggestedReplyPanel.module.css` (NEW)
- `supabase/migrations/<ts>_tickets_ai_draft_tracking.sql` — adds `ai_draft_state` enum to `ticket_messages`

**Depends on:** Feature 1 must be merged. The corpus structure (`ai_eligible`, `tags`, `variables_schema`, `context_hint`) is non-negotiable input.

#### Goal

Reina and Junaid handle ~40 inbound ticket messages a day between them. ~70% are answerable from a known template once you know the customer, the unit, and the topic. The remaining 30% need a human anyway. This feature collapses the 70% path from "scroll Templates, find one, copy variables in" to "click Accept on the top suggestion." Following Intercom Fin's pattern but downscoped to template selection + variable fill — explicitly NOT free-text generation.

Why downscoped: backlog #72 documents a free-write hallucination that put a wrong Trustpilot URL in a customer email. The class of bug is real. The fix is structural: never let the model emit prose that isn't in a reviewed template. The model's job is (a) summarize the ticket, (b) pick the right template from Feature 1's corpus, (c) fill variables from ticket context. That's it.

#### Work to do

**Migration.** Add to `ticket_messages`:
- `ai_summary` text NULL — the 3-line summary.
- `ai_draft_state` enum (`none`, `suggested`, `accepted`, `modified`, `rejected`) NOT NULL DEFAULT `'none'`.
- `ai_draft_template_id` uuid NULL REFERENCES templates(id).
- `ai_draft_confidence` numeric(3,2) NULL.

**lib/aiDraft.ts.** Wraps the existing Anthropic client used by `lib/orders.ts` address-verify. Two functions:

```ts
export async function summarizeTicket(ticket_id: string): Promise<{
  what_customer_wants: string;
  what_been_tried: string;
  what_blocking: string;
}>

export async function suggestReply(ticket_id: string): Promise<{
  template_id: string;
  filled_variables: Record<string, string>;
  confidence: number;            // 0..1
  rationale: string;             // short, for tooltip
  alternates: Array<{ template_id: string; confidence: number }>;
}>
```

`summarizeTicket`: pulls the last N messages from `ticket_messages`, classification from `tickets.topic`, customer + unit context from `customers` + `units`, then prompts `claude-haiku-4-5` with a strict JSON-output instruction. Cache the result on `ticket_messages.ai_summary` so reopening the ticket doesn't reburn tokens.

`suggestReply`: call `getTemplatesForContext` from Feature 1 with `{ topic: ticket.topic, customer_segment: derived_from_customer, channel: ticket.preferred_channel }`. Take the top 3. For each, call Claude with prompt: "Given this ticket and this template's variables_schema, return the variable values from ticket context. Return null for any variable you cannot confidently fill from context — never invent." Score = template-match-score × variable-completeness. Return top one + 2 alternates.

**Prompt hardening (read this twice):**
- Pass `ai_eligible=true` templates only. Feature 1's retrieval already filters but defense-in-depth.
- Instruct the model to return `null` for unknown variables. The UI shows null-filled variables as "needs operator input" and blocks Accept until filled.
- Never include any free-text instruction that lets the model write prose. The output schema is strictly `{ template_id, variables: { ... } }`.
- OWASP LLM Top 10: don't pass raw customer message text into a system-prompt slot; always wrap as `<user_message>...</user_message>` and instruct the model to treat it as data, not instructions.

**SuggestedReplyPanel.tsx.** Renders inside `TicketDetailPanel` above the reply textarea. Shows: 3-line summary, suggested template name + confidence chip (green ≥0.7, yellow 0.4–0.7, red <0.4), filled-variable preview, `Accept` / `Modify` / `Reject` / `Show alternates` buttons. Accept → fills the reply textarea with the rendered template, marks `ai_draft_state='accepted'`, logs `ai_draft_used`. Modify → fills textarea, marks `ai_draft_state='modified'` after the operator edits and sends, logs `ai_draft_modified`. Reject → hides panel, logs `ai_draft_rejected` with optional reason.

**Activity log.** Three new action types: `ai_draft_used`, `ai_draft_modified`, `ai_draft_rejected`. All carry `detail: { template_id, confidence, topic }`. These power the OKR feature (Feature 4) — e.g. "% of Reina's replies that started from an AI draft."

#### Validation

- Vitest: `summarizeTicket` returns the JSON shape even when Claude returns extra whitespace. Use a structured-output test fixture.
- Vitest: `suggestReply` filters out `ai_eligible=false` templates even if they would have ranked first.
- Vitest: any variable returned as null leaves the textarea slot empty AND disables Accept.
- Manual: Reina runs 5 real inbound tickets through the suggester; she records which she accepted unchanged, which she modified, which she rejected. Target: ≥3 accepted unchanged on a representative sample.
- Acceptance: Activity Log shows the three new action types and you can filter by them.

#### Watch-outs

- **The hallucinated-URL bug class.** If you ever find yourself prompting the model to "write a response" instead of "select a template and fill variables," stop. Re-read this section. The whole architecture exists to make that bug structurally impossible.
- Token budget: cap summary at ~150 tokens output and the suggest-reply at ~300. Don't blow Anthropic spend on long-tail edge cases.
- Cache `ai_summary` on the message row. Don't recompute on every panel render — the realtime subscription will re-fire on any ticket update.
- The `ai_draft_confidence` value is a UI signal, not a hard threshold. Don't auto-send. Reina must click Accept.
- RLS on `ticket_messages` already restricts to staff. The new columns inherit. Don't add new policies.
- Share the Anthropic client instance with `lib/orders.ts` to keep one keepalive pool.
- Coordinate with Junaid: his Service-side device-context + telemetry-auto-ticket work also reads from `tickets` and writes to `ticket_messages`. Don't both add the same migration timestamp. Slack him before you create the migration file.

#### Files to load into Claude context at session start

- `app/src/lib/service.ts` (entire file)
- `app/src/lib/templates.ts` (Feature 1 must be in)
- `app/src/lib/orders.ts` (read the existing Anthropic client pattern at the top of the file)
- `app/src/modules/Service/TicketDetailPanel.tsx`
- `app/src/modules/Service/SupportTab.tsx`
- `app/src/lib/activityLog.ts` (for `logAction` + the action_type union)
- Search keywords: `claude-haiku-4-5`, `Anthropic`, `renderTemplate`, `ticket_messages`, `topic`.

---

### Feature 4: OKR & KPI tracking (ActivityLog)

**Priority:** P2 · **Effort:** M (~15h) · **Tokens:** ~1.2M
**Files to touch:**
- `supabase/migrations/<ts>_okrs_table_and_view.sql`
- `app/src/lib/okrs.ts` (NEW — types, hooks, mutations)
- `app/src/lib/okrs.test.ts` (NEW)
- `app/src/modules/ActivityLog/OKRsTab.tsx` (NEW)
- `app/src/modules/ActivityLog/OKRsTab.module.css` (NEW)
- `app/src/modules/ActivityLog/index.tsx` (wire up the new tab)
- `app/src/modules/ActivityLog/Feed.tsx` (add drilldown deep-link target)

**Depends on:** Huayi's `activity_log` entity-refs migration (`ref_table`, `ref_id` columns properly indexed across all `logAction` callsites) must merge first. If you ship before him, your aggregates will be incomplete because old rows lack the entity refs and your `source_action_types` joins won't trace back to entities cleanly.

#### Goal

Today the team has no shared view of OKR progress. Quarterly check-ins happen in Notion and are 2 weeks stale by the time anyone looks. Meanwhile `activity_log` already records every meaningful action — returns inspected, refunds approved, tickets resolved, AI drafts accepted, builds completed. We can derive most KPIs from it for free.

This feature adds an `okrs` table that maps OKR definitions to `activity_log` aggregations, plus a UI that shows pace, projection, and on-track status live. The non-derivable OKRs (NPS, churn rate, revenue) still get a `manual_current_value` field that George or a manager updates weekly. The explicit anti-goal: this is NOT a surveillance tool. Individual KPI visibility is locked down (see Watch-outs).

#### Work to do

**Migration.** New `okrs` table:
- `id` uuid PK default `gen_random_uuid()`.
- `scope` enum (`company`, `team`, `individual`) NOT NULL.
- `team` text NULL — required when scope=team (`cx`, `manufacturing`, `fulfillment`, `shipping`).
- `owner_id` uuid NULL REFERENCES profiles(id) — required when scope=individual; NULL otherwise.
- `name` text NOT NULL.
- `description` text NULL.
- `target_value` numeric NOT NULL.
- `target_unit` text NOT NULL — `'units'`, `'tickets'`, `'CAD'`, `'percent'`, etc.
- `period_start` date NOT NULL.
- `period_end` date NOT NULL.
- `source_action_types` text[] NOT NULL DEFAULT '{}' — `activity_log.type` values to aggregate.
- `aggregation` enum (`count`, `sum_detail_numeric`, `distinct_ref_id`) NOT NULL.
- `aggregation_key` text NULL — for `sum_detail_numeric`, the JSON key inside `activity_log.detail` (e.g. `'recoverable_value_usd'`).
- `manual_current_value` numeric NULL — used when `source_action_types` is empty.
- `created_by` uuid NOT NULL REFERENCES profiles(id).
- `created_at` timestamptz NOT NULL DEFAULT now().

View `okr_progress` (SQL view, not materialized — we have <100 OKRs):

```sql
SELECT
  o.*,
  COALESCE(
    o.manual_current_value,
    CASE o.aggregation
      WHEN 'count' THEN (SELECT count(*) FROM activity_log a
        WHERE a.type = ANY(o.source_action_types)
          AND a.created_at >= o.period_start AND a.created_at < o.period_end + 1
          AND (o.scope <> 'individual' OR a.user_id = o.owner_id))
      WHEN 'sum_detail_numeric' THEN (SELECT COALESCE(SUM((a.detail->>o.aggregation_key)::numeric), 0) FROM activity_log a
        WHERE a.type = ANY(o.source_action_types)
          AND a.created_at >= o.period_start AND a.created_at < o.period_end + 1
          AND (o.scope <> 'individual' OR a.user_id = o.owner_id))
      WHEN 'distinct_ref_id' THEN (SELECT count(DISTINCT a.ref_id) FROM activity_log a
        WHERE a.type = ANY(o.source_action_types)
          AND a.created_at >= o.period_start AND a.created_at < o.period_end + 1
          AND (o.scope <> 'individual' OR a.user_id = o.owner_id))
    END
  ) AS current_value,
  -- pct_complete, pace projection, on_track all derived in SQL
  ...
FROM okrs o;
```

Pace projection: linear extrapolation. `projected_eoq = current_value * (period_length / days_elapsed)`. `on_track = projected_eoq >= target_value`. Edge case: when `days_elapsed = 0` (OKR created today), set `pace = NULL` and show "Too early" in UI.

**RLS.** Tight policies on `okrs`:
- `SELECT`: anyone can see `scope='company'`; team members + managers see `scope='team' AND team = profiles.team`; only self + manager + `huayi@virgohome.io` + `george@virgohome.io` see `scope='individual' AND owner_id = self OR manager-of(owner_id)`.
- `INSERT/UPDATE`: managers (`profiles.role='manager'`) and Huayi/George only.
- `DELETE`: Huayi/George only.

**lib/okrs.ts.** Hooks: `useCompanyOkrs()`, `useMyOkrs()`, `useTeamOkrs(team)`, `useOkrDrilldown(okr_id)`. Mutations: `createOkr`, `updateOkr`, `setManualValue`. Each mutation calls `logAction({ type: 'okr_updated', ... })`.

**OKRsTab.tsx.** Two-pane layout. Top: filter pills (`Company`, `My team`, `Mine`) + period selector. Body: grid of OKR cards. Each card shows: name, current/target with progress bar, pct_complete, pace chip (green = ahead, yellow = on-track, red = behind, gray = too-early), tiny EOQ projection. Click → drilldown drawer showing the underlying `activity_log` rows that summed to current_value, with deep-links into the originating module.

**Feed.tsx.** Add deep-link receiver — `?okr=<id>` query param filters the feed to that OKR's source action types and date range.

#### Validation

- Vitest: `okr_progress` view returns correct `current_value` for `count`, `sum_detail_numeric`, and `distinct_ref_id` aggregations with fixture activity_log rows.
- Vitest: RLS denies non-manager non-owner access to `scope='individual'` OKRs. Use Supabase's local auth-as-user test pattern.
- Vitest: pace projection handles `days_elapsed=0` without divide-by-zero.
- Playwright: Reina creates an OKR ("Resolve 200 onboarding tickets this quarter"), it shows current count, she clicks drilldown, she lands on a filtered Feed.
- Acceptance: George views Company OKRs and sees pace projection for the current quarter without seeing individual-scope rows in the same view.

#### Watch-outs

- **The OKR-as-surveillance failure mode.** If managers can see every individual's KPI but not vice-versa, this becomes a perf-management hammer and operators will route around it. Mitigations: (a) RLS as specified; (b) the "My OKRs" filter is the default landing tab, not "All"; (c) explicitly no leaderboard view in v1; (d) document the privacy model in the Templates module so it's discoverable.
- The `source_action_types` field is a text[] — typos won't error at write time, they'll silently aggregate to zero. Add a CHECK that every value matches an existing `activity_log.type` value, OR validate in `lib/okrs.ts` `createOkr` against the union type. Prefer the lib check; it gives a usable error.
- The SQL view is recomputed on every query. Fine for v1 with <100 OKRs and <1M activity_log rows. If aggregate queries exceed 200ms, switch to a materialized view refreshed every 5 minutes. Don't pre-optimize.
- Don't aggregate over `activity_log` rows older than the OKR's `period_start` — the view does this, but if you write any ad-hoc query, replicate the filter.
- `manual_current_value` overrides derived value when present. This is intentional for NPS-type OKRs. Document it in the UI tooltip.
- Coordinate with Huayi on the entity-refs migration shape. If he names the columns `ref_table` and `ref_id`, use those exact names in `okr_progress`.

#### Files to load into Claude context at session start

- `app/src/lib/activityLog.ts` (entire file — understand the existing action-type union + `logAction` signature)
- `app/src/modules/ActivityLog/index.tsx`
- `app/src/modules/ActivityLog/Feed.tsx`
- `app/src/modules/ActivityLog/KpiPanel.tsx` (existing KPI tile pattern — copy the style)
- `supabase/migrations/` last 3 files (RLS + grant boilerplate)
- Search keywords: `logAction`, `action_type`, `TILE_DEFS`, `profiles.role`.

---

### Feature 5: Customer record sidebar widgets (Attio pattern)

**Priority:** P3 · **Effort:** M (~15h) · **Tokens:** ~1.2M
**Files to touch:**
- `app/src/modules/Customers/CustomerSidebar.tsx` (NEW — the rail container)
- `app/src/modules/Customers/CustomerSidebar.module.css` (NEW)
- `app/src/modules/Customers/widgets/OpenTicketsWidget.tsx` (NEW)
- `app/src/modules/Customers/widgets/InFlightReturnsWidget.tsx` (NEW)
- `app/src/modules/Customers/widgets/RecentOrdersWidget.tsx` (NEW)
- `app/src/modules/Customers/widgets/LinkedMachinesWidget.tsx` (NEW)
- `app/src/modules/Customers/widgets/ChurnRiskWidget.tsx` (NEW)
- `app/src/modules/Customers/widgets/widgets.module.css` (NEW — shared widget styling)
- `app/src/modules/Customers/index.tsx` (mount sidebar in detail view)
- `app/src/lib/customers.ts` (add `useCustomerSidebarData(customer_id)` aggregating hook)
- `supabase/migrations/<ts>_customer_sidebar_prefs.sql` (small — per-user widget order)

**Depends on:** Pedrum's Klaviyo predictive-pull edge function must be writing `customers.churn_risk_score` (0..1) and `customers.churn_risk_band` ('low'|'medium'|'high'). Without it the ChurnRisk widget shows "No data" and the value is degraded but the rest of the feature works. Don't block on Pedrum — ship the other four widgets first behind a feature flag if needed.

#### Goal

The Customers detail view today is a single tall scroll. Reina spends 60% of her time in this view during onboarding follow-ups, and the data she needs (open tickets, in-flight returns, last orders, linked machines, churn risk) lives in 5 different tabs. Attio's record-page pattern grafted on: a configurable right-rail of widgets that summarize cross-domain state in glanceable cards.

Explicitly NOT a full record-page rewrite. The existing `JourneyTab`, `ProfitabilityTab`, and `OverdueFollowupPanel` stay. The sidebar is additive.

#### Work to do

**Migration.** Tiny — one table:
```sql
create table customer_sidebar_prefs (
  user_id uuid primary key references profiles(id),
  widget_order text[] not null default array['open_tickets','in_flight_returns','recent_orders','linked_machines','churn_risk'],
  hidden_widgets text[] not null default '{}',
  updated_at timestamptz not null default now()
);
```
RLS: `auth.uid() = user_id` for all ops.

**lib/customers.ts.** Add aggregating hook:
```ts
export function useCustomerSidebarData(customer_id: string): {
  loading: boolean;
  openTickets: TicketSummary[];
  inFlightReturns: ReturnSummary[];
  recentOrders: OrderSummary[];
  linkedMachines: UnitSummary[];
  churnRisk: { score: number; band: 'low'|'medium'|'high' } | null;
}
```
Fires 5 parallel queries via `Promise.all`. Each query is short — 3 most recent open tickets, in-flight returns where `inspected_at IS NULL OR refund_state IN ('pending','approved')`, last 3 orders, all units linked via `units.customer_id`, and the two churn columns. Add a single realtime subscription on `customers.id = customer_id` to refetch on any change — don't subscribe to 5 tables, that's overkill for a sidebar.

**Widgets.** Each widget is a single component, <100 lines, reading from `useCustomerSidebarData`. Shared style: 280px wide, ~140px tall card, header row with title + small action chevron, body with 2–4 lines of summary, hover state reveals "Open in module" link that navigates to the relevant module's detail view (`/post-shipment/returns/<id>`, `/service/tickets/<id>`, etc.).

- **OpenTicketsWidget** — count + 3 most recent topic + age chips. Click → Service module filtered to customer.
- **InFlightReturnsWidget** — count + status badges (received? inspected? refunded?). Click → PostShipment filtered to customer.
- **RecentOrdersWidget** — last 3 with order#, date, total. Click → OrderReview detail.
- **LinkedMachinesWidget** — count of units + serial chips (top 3) + any in `quarantine` flagged red.
- **ChurnRiskWidget** — Pedrum's score with band-colored ring + last-engagement timestamp.

**CustomerSidebar.tsx.** Container that reads `customer_sidebar_prefs` for the current user, orders widgets accordingly, and shows a `⋮` menu per widget to hide it (writes to `hidden_widgets`). v1 reorder via drag-and-drop is nice-to-have; if you're short on time, ship with a simple "Move up / Move down" menu and skip DnD.

**Integration.** In `Customers/index.tsx`, the detail view layout becomes `grid-template-columns: 1fr 320px`. The existing tab content occupies the main column; `CustomerSidebar` mounts in the right column. On mobile (`<768px`), the sidebar stacks below the tabs.

#### Validation

- Vitest: `useCustomerSidebarData` returns the right shape with mocked Supabase responses. Test the empty-state path (no orders, no tickets) explicitly.
- Vitest: widget hide/show writes correct array to `customer_sidebar_prefs`.
- Playwright: open a customer with rich data, confirm 5 widgets render, hide one, refresh, confirm persistence.
- Acceptance: Reina opens 3 customer records during onboarding follow-ups and reports that she spent zero time clicking into other tabs to answer "what's their last order / open ticket / churn risk."

#### Watch-outs

- **Don't subscribe to 5 tables.** Realtime subscriptions cost both client memory and Supabase quota. One subscription on the customer row, refetch aggregate on change. If a ticket updates and the customer row doesn't, the sidebar will be stale until refresh — that's acceptable for v1.
- The ChurnRisk widget without Pedrum's data should render a clean "No data yet" empty state, not an error.
- Sidebar at 320px on smaller laptop screens (1366×768) takes ~25% of horizontal space. Test on that resolution before merging — it's what George uses.
- Don't refactor the existing `JourneyTab` or `ProfitabilityTab` while you're in the area. The brief is additive.
- Don't query `units` and `orders` separately if you can use a single join. Check `lib/customers.ts` for an existing `customerOverview` query first.
- Activity log: only log `sidebar_pref_changed` once per save — don't log per-widget per-reorder.

#### Files to load into Claude context at session start

- `app/src/lib/customers.ts` (entire file)
- `app/src/modules/Customers/index.tsx`
- `app/src/modules/Customers/JourneyTab.tsx` (for the customer detail layout shape)
- `app/src/modules/Customers/OverdueFollowupPanel.tsx` (for an existing widget-like card)
- `app/src/lib/postShipment.ts` (for `ReturnRow` shape)
- `app/src/lib/service.ts` (for `Ticket` shape)
- `app/src/lib/stock.ts` (for `units.status='quarantine'`)
- Search keywords: `customer_id`, `journey_stage_override`, `churn_risk`, `useCustomers`.

---

## Quick session start cheat sheet

```
# every session
cd e:\Claude\makelila\app
git fetch && git pull --rebase origin main
npm install   # only if package.json changed
npm run dev   # terminal A
npx vitest --watch   # terminal B

# decide which feature
#   working solo, no dependencies blocked? → Feature 1 (Templates RAG)
#   Feature 1 merged, Junaid's quarantine value merged? → Feature 2 (Returns inspection)
#   Feature 1 merged? → Feature 3 (AI drafts)
#   Huayi's entity-refs migration merged? → Feature 4 (OKRs)
#   Pedrum's churn-risk pull writing customers.churn_risk_score? → Feature 5 (Customer sidebar)

# before opening a PR
npm run build
npm test
npx playwright test --grep <your-feature>
git push -u origin reina/<feature-slug>

# commit hygiene
# - one migration per commit
# - one UI slice per commit
# - one test file per commit
# - message: feat(<module>): <short>   |  fix(<module>): <short>   |  chore(<module>): <short>

# what to log via logAction()
# Feature 1: template_metadata_updated
# Feature 2: return_inspected, return_inspection_serial_mismatch, return_team_attribution_overridden
# Feature 3: ai_draft_used, ai_draft_modified, ai_draft_rejected
# Feature 4: okr_created, okr_updated, okr_manual_value_set
# Feature 5: sidebar_pref_changed

# privacy + safety boundaries you don't cross
# - never bypass ai_eligible=false (Feature 1, 3)
# - never let AI emit free prose (Feature 3)
# - never expose individual OKRs to non-owner non-manager (Feature 4)
# - never refund before inspection (Feature 2)

# coordinate before you migrate
# - Junaid: units.status='quarantine' (Feature 2 prerequisite)
# - Huayi: activity_log entity refs (Feature 4 prerequisite)
# - Pedrum: customers.churn_risk_score (Feature 5 prerequisite)
```

Total estimated effort: ~65h across 5 features. Ship Feature 1 first (5h, unblocks Feature 3). Ship Feature 2 as soon as Junaid's quarantine value lands — it closes the biggest active operator pain. Features 3, 4, 5 can interleave after that based on dependency state.
