# Follow-Up Detail Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A rich Follow-Up detail panel: check off FU1/FU2/diagnosis follow-ups, add/check off operator action items, keep a timestamped notes log, and apply manual status labels that filter alongside the auto-derived tags.

**Architecture:** Two new tables (`customer_action_items`, `customer_notes`) + a `customers.manual_status_tags text[]` column; a new `lib/followups.ts` data layer; `useFollowUpDirectory` unions manual tags into each row's status set; a new `FollowUpDetailPanel` replaces the thin selected-panel in `FollowUpsTab`.

**Tech Stack:** React 18 + TS, Supabase (RLS `internal_only` using `public.is_internal_user()`), CSS Modules, Vitest. Spec: `docs/superpowers/specs/2026-06-19-followup-detail-panel-design.md`. **Pages deploy runs `npm run lint` (exit 1 on any error) before build — lint MUST be clean.** Work on `main`; each task green. Controller applies migrations to prod + pushes.

---

### Task 1: Migrations + `Customer.manual_status_tags`

**Files:**
- Create: `supabase/migrations/20260619120000_followup_action_items.sql`
- Create: `supabase/migrations/20260619120100_followup_customer_notes.sql`
- Create: `supabase/migrations/20260619120200_customer_manual_status_tags.sql`
- Modify: `app/src/lib/customers.ts`

- [ ] **Step 1: action_items migration**
```sql
create table if not exists public.customer_action_items (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  text        text not null,
  due_date    date,
  done        boolean not null default false,
  done_at     timestamptz,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_action_items_customer on public.customer_action_items (customer_id);
alter table public.customer_action_items enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='customer_action_items' and policyname='internal_only') then
    execute 'create policy internal_only on public.customer_action_items using (public.is_internal_user()) with check (public.is_internal_user())';
  end if;
end $$;
```

- [ ] **Step 2: customer_notes migration**
```sql
create table if not exists public.customer_notes (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  body        text not null,
  author_id   uuid,
  created_at  timestamptz not null default now()
);
create index if not exists idx_customer_notes_customer on public.customer_notes (customer_id, created_at desc);
alter table public.customer_notes enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='customer_notes' and policyname='internal_only') then
    execute 'create policy internal_only on public.customer_notes using (public.is_internal_user()) with check (public.is_internal_user())';
  end if;
end $$;
```

- [ ] **Step 3: manual_status_tags column**
```sql
alter table public.customers add column if not exists manual_status_tags text[] not null default '{}';
comment on column public.customers.manual_status_tags is
  'Operator-applied Follow-Ups status labels, additive to the auto-derived ones.';
```

- [ ] **Step 4:** In `app/src/lib/customers.ts`, add to the `Customer` type after `review_status`:
```ts
  manual_status_tags: string[] | null;
```

- [ ] **Step 5:** `cd app && npx tsc --noEmit` (clean) + `npm run lint` (exit 0). Commit:
```bash
git add supabase/migrations/20260619120000_followup_action_items.sql supabase/migrations/20260619120100_followup_customer_notes.sql supabase/migrations/20260619120200_customer_manual_status_tags.sql app/src/lib/customers.ts
git commit -m "feat(followups): action_items + customer_notes tables + manual_status_tags column"
```

---

### Task 2: `lib/followups.ts` data layer + tests

**Files:**
- Create: `app/src/lib/followups.ts`
- Create: `app/src/lib/followups.test.ts`

- [ ] **Step 1: failing test** `app/src/lib/followups.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { MANUAL_TAGS, mergeManualTags } from './followups';
import type { FollowUpStatusKey } from './followupStatus';

describe('MANUAL_TAGS', () => {
  it('excludes the date-derived keys', () => {
    for (const k of ['overdue','due_today','due_7d','fu_on_hold','diag_followup_due'] as FollowUpStatusKey[]) {
      expect(MANUAL_TAGS.includes(k)).toBe(false);
    }
  });
  it('includes the state-like keys', () => {
    expect(MANUAL_TAGS).toContain('active');
    expect(MANUAL_TAGS).toContain('awaiting_response');
  });
});

describe('mergeManualTags', () => {
  it('unions manual tags into the derived set (ignoring unknown strings)', () => {
    const derived = new Set<FollowUpStatusKey>(['overdue']);
    const out = mergeManualTags(derived, ['active', 'bogus', 'returned']);
    expect([...out].sort()).toEqual(['active','overdue','returned']);
  });
  it('returns the same set instance contents when manual is null/empty', () => {
    const derived = new Set<FollowUpStatusKey>(['active']);
    expect([...mergeManualTags(derived, null)]).toEqual(['active']);
  });
});
```

- [ ] **Step 2:** Run `cd app && npx vitest run src/lib/followups.test.ts` → FAIL (module missing).

- [ ] **Step 3: implement** `app/src/lib/followups.ts`:
```ts
import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { logAction } from './activityLog';
import { STATUS_FILTERS, type FollowUpStatusKey } from './followupStatus';

const DATE_DERIVED: FollowUpStatusKey[] = ['overdue', 'due_today', 'due_7d', 'fu_on_hold', 'diag_followup_due'];
/** Status keys an operator may apply manually (additive to derived ones). */
export const MANUAL_TAGS: FollowUpStatusKey[] = STATUS_FILTERS
  .map(f => f.key)
  .filter(k => !DATE_DERIVED.includes(k));

const VALID_KEYS = new Set(STATUS_FILTERS.map(f => f.key));
/** Union manual tags (validated) into a derived status set. Pure. */
export function mergeManualTags(derived: Set<FollowUpStatusKey>, manual: string[] | null): Set<FollowUpStatusKey> {
  const out = new Set(derived);
  for (const t of manual ?? []) if (VALID_KEYS.has(t as FollowUpStatusKey)) out.add(t as FollowUpStatusKey);
  return out;
}

export type ActionItem = {
  id: string; customer_id: string; text: string; due_date: string | null;
  done: boolean; done_at: string | null; created_by: string | null;
  created_at: string; updated_at: string;
};
export type CustomerNote = { id: string; customer_id: string; body: string; author_id: string | null; created_at: string };

export function useActionItems(customerId: string | null) {
  const [items, setItems] = useState<ActionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!customerId) { setItems([]); setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('customer_action_items')
        .select('*').eq('customer_id', customerId)
        .order('done', { ascending: true }).order('due_date', { ascending: true, nullsFirst: false }).order('created_at');
      if (!cancelled) { setItems((data ?? []) as ActionItem[]); setLoading(false); }
    })().catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [customerId, tick]);
  return { items, loading, refresh: () => setTick(t => t + 1) };
}

export function useCustomerNotes(customerId: string | null) {
  const [notes, setNotes] = useState<CustomerNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!customerId) { setNotes([]); setLoading(false); return; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('customer_notes')
        .select('*').eq('customer_id', customerId).order('created_at', { ascending: false });
      if (!cancelled) { setNotes((data ?? []) as CustomerNote[]); setLoading(false); }
    })().catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [customerId, tick]);
  return { notes, loading, refresh: () => setTick(t => t + 1) };
}

export async function addActionItem(customerId: string, text: string, dueDate: string | null = null): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from('customer_action_items')
    .insert({ customer_id: customerId, text: text.trim(), due_date: dueDate, created_by: user?.id ?? null });
  if (error) throw error;
  await logAction('action_item_added', customerId, text.trim().slice(0, 120), { entityType: 'customer', entityId: customerId });
}

export async function toggleActionItem(id: string, done: boolean): Promise<void> {
  const { error } = await supabase.from('customer_action_items')
    .update({ done, done_at: done ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteActionItem(id: string): Promise<void> {
  const { error } = await supabase.from('customer_action_items').delete().eq('id', id);
  if (error) throw error;
}

export async function addCustomerNote(customerId: string, body: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from('customer_notes')
    .insert({ customer_id: customerId, body: body.trim(), author_id: user?.id ?? null });
  if (error) throw error;
  await logAction('customer_note_added', customerId, body.trim().slice(0, 120), { entityType: 'customer', entityId: customerId });
}

export async function setCustomerManualTags(customerId: string, tags: string[]): Promise<void> {
  const clean = [...new Set(tags.filter(t => VALID_KEYS.has(t as FollowUpStatusKey)))];
  const { error } = await supabase.from('customers').update({ manual_status_tags: clean }).eq('id', customerId);
  if (error) throw error;
  await logAction('customer_tags_set', customerId, clean.join(', ') || '(none)', { entityType: 'customer', entityId: customerId });
}
```

- [ ] **Step 4:** Run the test → PASS. `npx tsc --noEmit` clean, `npm run lint` exit 0.

- [ ] **Step 5: commit**
```bash
git add app/src/lib/followups.ts app/src/lib/followups.test.ts
git commit -m "feat(followups): action-item + notes + manual-tag data layer"
```

---

### Task 3: Union manual tags into the directory

**Files:**
- Modify: `app/src/lib/followupStatus.ts`

- [ ] **Step 1:** In `useFollowUpDirectory`, where each row's `statuses` is built (`const statuses = computeCustomerStatuses(c, ctx, today);`), union the manual tags before counting:
```ts
      const statuses = computeCustomerStatuses(c, ctx, today);
      for (const t of c.manual_status_tags ?? []) {
        if (STATUS_FILTERS.some(f => f.key === t)) statuses.add(t as FollowUpStatusKey);
      }
```
(`STATUS_FILTERS` + `FollowUpStatusKey` are defined in this file.) Counts already iterate `statuses`, so manual tags fold into counts + filtering automatically.

- [ ] **Step 2:** `npx tsc --noEmit`, `npm run lint`, `npx vitest run src/lib/followupStatus.test.ts src/lib/followups.test.ts` — all clean/pass.

- [ ] **Step 3: commit**
```bash
git add app/src/lib/followupStatus.ts
git commit -m "feat(followups): fold manual status tags into the directory status set"
```

---

### Task 4: `FollowUpDetailPanel` UI + wire into `FollowUpsTab`

**Files:**
- Create: `app/src/modules/Service/FollowUpDetailPanel.tsx`
- Modify: `app/src/modules/Service/FollowUpsTab.tsx`
- Modify: `app/src/modules/Service/FollowUps.module.css`

- [ ] **Step 1:** Read the current selected-panel block in `FollowUpsTab.tsx` (the `{selectedCustomer && selected && (...)}` section) and the `handleAction`/`setReviewStatus`/`busy` state — these move into the new panel.

- [ ] **Step 2: create `FollowUpDetailPanel.tsx`.** Props: `{ customer: Customer; diagnosisTicketId: string | null; onClose: () => void; onChanged: () => void }`. Uses `useActionItems(customer.id)`, `useCustomerNotes(customer.id)`, and the mutations. Sections per the spec:
  - Header (name/email/phone/onboard date + `computeFuState` label).
  - **Status**: render `computeCustomerStatuses`-style derived chips read-only (pass the row's derived statuses in, OR recompute is unnecessary — simplest: show the customer's `manual_status_tags` as removable chips + a "+ tag" menu of `MANUAL_TAGS` not yet applied; derived chips can be shown from the directory row if passed). MVP: show manual tags as toggle chips over the full `MANUAL_TAGS` set (applied = filled, click toggles via `setCustomerManualTags`), then `onChanged()`.
  - **Checklist**: FU1/FU2 rows with the existing Called/Messaged/Reviewed buttons (call `recordFollowUp(customer.id, 'fu1'|'fu2', action)` then `onChanged()`); a Diagnosis follow-up row with **Mark done** (`markDiagnosisFollowupDone(diagnosisTicketId)`) when `diagnosisTicketId` is set; the action-items list (checkbox → `toggleActionItem`, delete → `deleteActionItem`) + an Add form (`addActionItem`).
  - **Notes log**: list newest-first (`note.created_at` + body), an Add box (`addCustomerNote`), and the legacy `customer.fu_notes` shown muted at the end if present.
  - Review buttons: Mark review requested/received (`setReviewStatus`).
  - All mutations wrapped in a local `busy` guard; refresh the relevant hook + call `onChanged()` (which the parent uses to `useCustomers().refresh()`).
  Use CSS-module classes (add new ones to `FollowUps.module.css`: `.detailSection`, `.detailTags`, `.detailTag`, `.detailTagOn`, `.checklist`, `.checkRow`, `.notesLog`, `.noteRow`, `.addRow`, etc.). Follow existing panel styling.

- [ ] **Step 3: wire into `FollowUpsTab`.** Replace the inline `selectedPanel` block with:
```tsx
      {selectedCustomer && (
        <FollowUpDetailPanel
          customer={selectedCustomer}
          diagnosisTicketId={
            tickets.find(t => t.category === 'diagnosis_call' && !t.diagnosis_followup_done_at
              && (t.customer_id === selectedCustomer.id
                  || (t.customer_email ?? '').toLowerCase() === (selectedCustomer.email ?? '').toLowerCase()))?.id ?? null
          }
          onClose={() => setSelected(null)}
          onChanged={() => refresh()}
        />
      )}
```
Add `const { customers, refresh } = useCustomers();` if not already destructured with `refresh` (the hook exposes it). Import `FollowUpDetailPanel`. Remove the now-unused `handleAction` if fully moved (or keep if still referenced).

- [ ] **Step 4:** `cd app && npx tsc --noEmit`, `npm run lint`, `npm run build` — all clean.

- [ ] **Step 5: commit**
```bash
git add app/src/modules/Service/FollowUpDetailPanel.tsx app/src/modules/Service/FollowUpsTab.tsx app/src/modules/Service/FollowUps.module.css
git commit -m "feat(followups): rich detail panel — checklist, notes log, manual tags"
```

---

### Task 5: Full verification

- [ ] **Step 1:** `cd app && npm test` (all green), `npm run lint` (exit 0), `npm run build` (success).
- [ ] **Step 2:** Controller: apply the 3 migrations to prod (MCP), then push `main` (SSH). Confirm `manual_status_tags` column + both tables exist.
- [ ] **Step 3:** Smoke after deploy: open a customer in Follow-Ups → add an action item, check it off, add a note, toggle a manual tag → confirm the tag appears as a directory chip/count.

---

## Self-review notes
- **Spec coverage:** §3.1 migrations → Task 1; §3.2 lib → Task 2; §4 directory union → Task 3; §5 panel → Task 4; §7 testing → Tasks 2,3,5. Covered.
- **Type consistency:** `manual_status_tags: string[]|null` on Customer; `MANUAL_TAGS`/`mergeManualTags`/`ActionItem`/`CustomerNote` exported from `followups.ts`; panel props `{customer, diagnosisTicketId, onClose, onChanged}`.
- **No placeholders** (Task 4 UI gives structure + exact mutation calls; implementer matches existing panel CSS). Lint gate every task.
- **RLS:** `internal_only` using `public.is_internal_user()` (matches telemetry tables).
