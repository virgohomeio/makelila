# Follow-Up detail panel — checklist + notes log + manual tags — Design Spec

**Date:** 2026-06-19
**Author:** Huayi Gao (with Claude)
**Status:** Approved (proceed; iterate during build)

---

## 1. Goal

Clicking a customer in the Service → Follow-Ups directory opens a richer
**Follow-Up detail panel** where the operator can: check off follow-ups,
add/check off their own action items, keep a timestamped notes log, and apply
manual status labels that show + filter alongside the auto-derived tags.

## 2. Decisions (locked in)

| Decision | Choice |
|----------|--------|
| Manual tags | **Separate, additive labels** (new `customers.manual_status_tags text[]`); shown + filterable alongside auto-derived tags, which keep updating. |
| Action items | **Unified checklist**: auto FU1/FU2/diagnosis follow-ups (checkable via existing mutations) + operator-added items in a new `customer_action_items` table. |
| FU1/FU2 check-off | **Keep Called / Messaged / Reviewed** (records *how*). |
| Notes | **Timestamped log** (new `customer_notes` table); legacy `fu_notes` shown as a read-only initial entry. |
| Scope | One feature (not phased). |

## 3. Data model

### 3.1 Migrations
- `customer_action_items`:
  `id uuid pk default gen_random_uuid(), customer_id uuid not null references customers(id) on delete cascade, text text not null, due_date date, done boolean not null default false, done_at timestamptz, created_by uuid, created_at timestamptz default now(), updated_at timestamptz default now()`. Index on `(customer_id)`.
- `customer_notes`:
  `id uuid pk default gen_random_uuid(), customer_id uuid not null references customers(id) on delete cascade, body text not null, author_id uuid, created_at timestamptz default now()`. Index on `(customer_id, created_at desc)`.
- `customers.manual_status_tags text[] not null default '{}'`.
- RLS: mirror the existing `customers`/`service_tickets` policies (internal users full access). Match whatever pattern those tables use (check before writing the migration).

### 3.2 `app/src/lib/followups.ts` (new)
Types + hooks + mutations (all mutations call `logAction`):
```ts
export type ActionItem = { id; customer_id; text; due_date: string|null; done: boolean; done_at: string|null; created_by: string|null; created_at; updated_at };
export type CustomerNote = { id; customer_id; body; author_id: string|null; created_at };

export const MANUAL_TAGS: FollowUpStatusKey[] = [
  'in_followup','awaiting_onboarding','awaiting_response','awaiting_diagnosis',
  'queued_replacement','on_hold','awaiting_review','active','returned',
]; // date-derived keys (overdue/due_today/due_7d/fu_on_hold/diag_followup_due) are NOT manual

export function useActionItems(customerId: string|null): { items: ActionItem[]; loading; refresh };
export function useCustomerNotes(customerId: string|null): { notes: CustomerNote[]; loading; refresh };
export async function addActionItem(customerId, text, dueDate?: string|null): Promise<void>;
export async function toggleActionItem(id, done: boolean): Promise<void>; // sets done + done_at
export async function deleteActionItem(id): Promise<void>;
export async function addCustomerNote(customerId, body): Promise<void>;   // stamps author from auth
export async function setCustomerManualTags(customerId, tags: string[]): Promise<void>;
```
`Customer` type (`lib/customers.ts`) gains `manual_status_tags: string[] | null`.

## 4. Directory integration (`lib/followupStatus.ts`)
- `useFollowUpDirectory`: after computing each customer's derived `statuses`,
  union in `c.manual_status_tags` (filtered to valid `FollowUpStatusKey`s):
  `for (const t of c.manual_status_tags ?? []) statuses.add(t as FollowUpStatusKey)`.
  Counts/filter chips then include manual tags automatically (additive). Pure
  `computeCustomerStatuses` is unchanged.

## 5. UI — `FollowUpDetailPanel.tsx` (new), used by `FollowUpsTab`
Replaces the inline `selectedPanel`. Opens for `selected.customerId`. Sections:
- **Header** — name, email, phone, onboard date, current FU state.
- **Status** — derived chips (read-only) + manual chips as toggles: clicking a
  `MANUAL_TAGS` chip adds/removes it via `setCustomerManualTags` (optimistic, then
  `useCustomers().refresh()`).
- **Checklist**:
  - FU1 / FU2 rows: state (done date / due / overdue) + the existing
    **Called / Messaged / Reviewed** buttons (via `recordFollowUp`) to check off.
  - Diagnosis follow-up row (when the customer has an active diagnosis call):
    **Mark done** (via `markDiagnosisFollowupDone` on the diagnosis ticket).
  - Manual action items: checkbox (toggle done) + text + due date; an **Add
    action item** form (text + optional date).
- **Notes log** — newest-first list (author + time) from `useCustomerNotes`; an
  **Add note** box; legacy `fu_notes` shown as a muted initial entry.
- Keep the existing **Mark review requested / received** controls.

`FollowUpsTab` passes the selected customer + its diagnosis ticket(s) to the
panel; on mutations, refresh customers + the relevant hook so the directory and
panel reflect changes.

## 6. Error handling
- Hooks tolerate load failures (empty list, not thrown). Mutations surface
  Supabase errors to the caller (panel shows a small error line; existing `busy`
  pattern).
- Manual-tag union ignores unknown strings.

## 7. Testing
- Vitest (pure/logic): `MANUAL_TAGS` excludes the date-derived keys; the
  directory unions manual tags into the status set (extend the existing
  `useFollowUpDirectory`-shaped test or a small pure helper
  `mergeManualTags(derived, manual)`); action-item toggle sets `done_at`.
- Build/lint/test gates green. Migrations applied to prod by controller.

## 8. Scope / out of scope
- No bulk action-item templates; no per-action-item assignee. Notes are
  append-only (no edit/delete in v1). Manual tags limited to the `MANUAL_TAGS`
  vocabulary (no free-text tags).
