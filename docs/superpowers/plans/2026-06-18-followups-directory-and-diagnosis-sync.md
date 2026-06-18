# Follow-Ups Directory Sidebar + Diagnosis-Call GCal Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a filterable customer directory + overdue count beside the Service → Follow-Ups calendar, and pull "LILA Diagnosis Chat" events from Huayi's Google Calendar onto the calendar.

**Architecture:** A pure derivation (`computeCustomerStatuses`) maps each customer to a set of lifecycle status keys from existing data (FU cadence, open tickets, replacement orders, returns/refunds, lifecycle); a hook indexes those sources and feeds a new `FollowUpDirectory` sidebar. One new `customers.review_status` column backs the "awaiting review" status. A new cron-scheduled edge function reads Huayi's Google Calendar via the existing service-account auth and upserts diagnosis calls as `service_tickets`, which the calendar renders.

**Tech Stack:** React 18 + TS, Vite, CSS Modules, Supabase (Postgres + edge functions in Deno), Vitest. Spec: `docs/superpowers/specs/2026-06-18-followups-directory-and-diagnosis-sync-design.md`.

---

### Task 1: Migration + type + mutation for `customers.review_status`

**Files:**
- Create: `supabase/migrations/20260618120000_customer_review_status.sql`
- Modify: `app/src/lib/customers.ts` (Customer type ~line 23; add mutation after `recordFollowUp` ~line 160)

- [ ] **Step 1: Write the migration**

```sql
-- Awaiting-review tracking for the Follow-Ups directory.
-- null = not asked, 'requested' = review ask sent, 'received' = review in hand.
-- Free-text (no check constraint) to match fu1_status/fu2_status convention.
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS review_status text;
COMMENT ON COLUMN public.customers.review_status IS
  'Follow-Ups review state: null=not asked, requested=ask sent, received=review in hand';
```

- [ ] **Step 2: Apply the migration** (via Supabase MCP `apply_migration`, project `txeftbbzeflequvrmjjr`, name `customer_review_status`). Expected: success, no error.

- [ ] **Step 3: Add the field to the `Customer` type**

In `app/src/lib/customers.ts`, in the `Customer = { … }` type, after `fu_notes: string | null;`:

```ts
  review_status: string | null;
```

- [ ] **Step 4: Add the mutation** (after `recordFollowUp`, ~line 160):

```ts
/** Set the review state used by the Follow-Ups directory "awaiting review"
 *  filter. Pass 'requested' when a review ask is sent, 'received' when it's in
 *  hand, or null to clear. */
export async function setReviewStatus(
  customerId: string,
  status: 'requested' | 'received' | null,
): Promise<void> {
  const { error } = await supabase
    .from('customers')
    .update({ review_status: status })
    .eq('id', customerId);
  if (error) throw error;
  await logAction('review_status_set', customerId, status ?? '(cleared)',
    { entityType: 'customer', entityId: customerId });
}
```

- [ ] **Step 5: Typecheck** — `cd app && npx tsc --noEmit`. Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260618120000_customer_review_status.sql app/src/lib/customers.ts
git commit -m "feat(customers): add review_status column + setReviewStatus mutation"
```

---

### Task 2: Pure status derivation — `computeCustomerStatuses`

**Files:**
- Create: `app/src/lib/followupStatus.ts`
- Test: `app/src/lib/followupStatus.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import {
  computeCustomerStatuses, STATUS_FILTERS, type CustomerStatusContext,
} from './followupStatus';
import type { Customer } from './customers';

const base: Customer = {
  id: 'c1', hubspot_id: null, email: 'a@b.com', first_name: null, last_name: null,
  full_name: 'Test User', phone: null, address_line: null, city: null, region: null,
  postal_code: null, country: null, notes: null, onboard_date: null,
  fu1_status: null, fu2_status: null, fu_notes: null, review_status: null,
  last_synced_at: null, serials: null, serials_synced_at: null,
  name_request_sent_at: null, journey_stage_override: null,
  journey_stage_override_at: null, journey_stage_override_by: null,
  first_touch_source: null, first_touch_campaign_id: null, first_touch_at: null,
  last_touch_source: null, last_touch_campaign_id: null, last_touch_at: null,
  telemetry_autoticket_suppress: false, created_at: '', updated_at: '',
};
const emptyCtx: CustomerStatusContext = {
  openTickets: [], queuedReplacement: false, returned: false, awaitingOnboarding: false,
};
const today = new Date('2026-06-18T12:00:00');
const daysAgo = (n: number) => { const d = new Date(today); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const daysAhead = (n: number) => { const d = new Date(today); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

describe('computeCustomerStatuses', () => {
  it('marks FU1 overdue when onboarded >14d ago and fu1 not done', () => {
    const c = { ...base, onboard_date: daysAgo(20) };
    expect(computeCustomerStatuses(c, emptyCtx, today).has('overdue')).toBe(true);
  });

  it('marks due_today when FU1 due exactly today', () => {
    const c = { ...base, onboard_date: daysAgo(14) };
    expect(computeCustomerStatuses(c, emptyCtx, today).has('due_today')).toBe(true);
  });

  it('marks due_7d when next FU falls within the coming week', () => {
    // onboarded 10d ago → FU1 due in 4 days
    const c = { ...base, onboard_date: daysAgo(10) };
    const s = computeCustomerStatuses(c, emptyCtx, today);
    expect(s.has('due_7d')).toBe(true);
    expect(s.has('due_today')).toBe(false);
    expect(s.has('overdue')).toBe(false);
  });

  it('does NOT mark due_7d when next FU is 8 days out', () => {
    const c = { ...base, onboard_date: daysAhead(-6) }; // FU1 due in 8d
    expect(computeCustomerStatuses(c, emptyCtx, today).has('due_7d')).toBe(false);
  });

  it('marks in_followup when onboarded and not complete', () => {
    const c = { ...base, onboard_date: daysAgo(20) };
    expect(computeCustomerStatuses(c, emptyCtx, today).has('in_followup')).toBe(true);
  });

  it('marks active when onboarded, both FUs done, no open issues', () => {
    const c = { ...base, onboard_date: daysAgo(40), fu1_status: 'called', fu2_status: 'called' };
    const s = computeCustomerStatuses(c, emptyCtx, today);
    expect(s.has('active')).toBe(true);
    expect(s.has('in_followup')).toBe(false);
  });

  it('does NOT mark active when a return exists', () => {
    const c = { ...base, onboard_date: daysAgo(40), fu1_status: 'x', fu2_status: 'y' };
    const s = computeCustomerStatuses(c, { ...emptyCtx, returned: true }, today);
    expect(s.has('active')).toBe(false);
    expect(s.has('returned')).toBe(true);
  });

  it('derives ticket-based statuses', () => {
    const t = (status: string, category = 'support') => ({ status, category } as any);
    const ctx = { ...emptyCtx, openTickets: [t('on_hold'), t('waiting_on_customer'), t('queued_for_replacement'), { status: 'call_scheduled', category: 'diagnosis_call' } as any] };
    const s = computeCustomerStatuses({ ...base }, ctx, today);
    expect(s.has('on_hold')).toBe(true);
    expect(s.has('awaiting_response')).toBe(true);
    expect(s.has('queued_replacement')).toBe(true);
    expect(s.has('awaiting_diagnosis')).toBe(true);
  });

  it('marks awaiting_review from review_status', () => {
    const c = { ...base, review_status: 'requested' };
    expect(computeCustomerStatuses(c, emptyCtx, today).has('awaiting_review')).toBe(true);
  });

  it('STATUS_FILTERS covers all 12 keys in display order', () => {
    expect(STATUS_FILTERS.map(f => f.key)).toEqual([
      'overdue', 'due_today', 'due_7d', 'in_followup', 'awaiting_onboarding',
      'awaiting_response', 'awaiting_diagnosis', 'queued_replacement',
      'on_hold', 'awaiting_review', 'active', 'returned',
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd app && npx vitest run src/lib/followupStatus.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `followupStatus.ts`**

```ts
import { computeFuState, FU1_DAYS, FU2_DAYS, type Customer } from './customers';
import type { ServiceTicket } from './service';

export type FollowUpStatusKey =
  | 'overdue' | 'due_today' | 'due_7d'
  | 'in_followup' | 'awaiting_onboarding' | 'awaiting_response'
  | 'awaiting_diagnosis' | 'queued_replacement' | 'on_hold'
  | 'awaiting_review' | 'active' | 'returned';

export const STATUS_FILTERS: { key: FollowUpStatusKey; label: string }[] = [
  { key: 'overdue',             label: 'Overdue' },
  { key: 'due_today',           label: 'Due today' },
  { key: 'due_7d',              label: 'Due in 7 days' },
  { key: 'in_followup',         label: 'In follow-up' },
  { key: 'awaiting_onboarding', label: 'Awaiting onboarding' },
  { key: 'awaiting_response',   label: 'Awaiting response' },
  { key: 'awaiting_diagnosis',  label: 'Awaiting diagnosis' },
  { key: 'queued_replacement',  label: 'Queued for replacement' },
  { key: 'on_hold',             label: 'On hold' },
  { key: 'awaiting_review',     label: 'Awaiting review' },
  { key: 'active',              label: 'Active' },
  { key: 'returned',            label: 'Returned' },
];

export type CustomerStatusContext = {
  /** This customer's non-closed service tickets. */
  openTickets: Pick<ServiceTicket, 'status' | 'category'>[];
  queuedReplacement: boolean;
  returned: boolean;
  awaitingOnboarding: boolean;
};

/** Days until the customer's next still-pending follow-up, or null if none
 *  pending (unscheduled or both complete). Negative = overdue. */
function daysToNextFu(c: Customer, today: Date): number | null {
  if (!c.onboard_date) return null;
  const onboard = new Date(c.onboard_date + 'T00:00:00');
  const mid = new Date(today); mid.setHours(0, 0, 0, 0);
  const due = (days: number) => { const d = new Date(onboard); d.setDate(d.getDate() + days); return d; };
  const dayDiff = (d: Date) => Math.round((d.getTime() - mid.getTime()) / 86_400_000);
  if (!c.fu1_status) return dayDiff(due(FU1_DAYS));
  if (!c.fu2_status) return dayDiff(due(FU2_DAYS));
  return null;
}

/** The set of Follow-Ups directory status keys a customer belongs to. Pure. */
export function computeCustomerStatuses(
  c: Customer, ctx: CustomerStatusContext, today: Date = new Date(),
): Set<FollowUpStatusKey> {
  const s = new Set<FollowUpStatusKey>();
  const fu = computeFuState(c, today);

  if (fu === 'overdue_fu1' || fu === 'overdue_fu2') s.add('overdue');
  if (fu === 'due_fu1' || fu === 'due_fu2') s.add('due_today');
  const dnext = daysToNextFu(c, today);
  if (dnext !== null && dnext > 0 && dnext <= 7) s.add('due_7d');

  if (c.onboard_date && fu !== 'complete' && fu !== 'unscheduled') s.add('in_followup');

  const hasTicket = (pred: (t: { status: string; category: string }) => boolean) =>
    ctx.openTickets.some(t => pred(t as { status: string; category: string }));
  if (hasTicket(t => t.status === 'on_hold')) s.add('on_hold');
  if (hasTicket(t => t.status === 'waiting_on_customer')) s.add('awaiting_response');
  if (hasTicket(t => t.category === 'diagnosis_call')) s.add('awaiting_diagnosis');
  if (ctx.queuedReplacement || hasTicket(t => t.status === 'queued_for_replacement')) s.add('queued_replacement');

  if (ctx.awaitingOnboarding) s.add('awaiting_onboarding');
  if (c.review_status === 'requested') s.add('awaiting_review');
  if (ctx.returned) s.add('returned');

  const hasOpenIssue = ctx.openTickets.length > 0 || ctx.queuedReplacement || ctx.returned;
  if (c.onboard_date && fu === 'complete' && !hasOpenIssue) s.add('active');

  return s;
}
```

- [ ] **Step 4: Run to verify it passes** — `cd app && npx vitest run src/lib/followupStatus.test.ts`. Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/followupStatus.ts app/src/lib/followupStatus.test.ts
git commit -m "feat(followups): pure per-customer status derivation"
```

---

### Task 3: Customer-indexing helper

**Files:**
- Modify: `app/src/lib/followupStatus.ts`
- Modify: `app/src/lib/followupStatus.test.ts`

- [ ] **Step 1: Add the failing test** (append to the test file)

```ts
import { matchKeysFor, type Matchable } from './followupStatus';

describe('matchKeysFor', () => {
  it('emits id, lowercased email, and lowercased name keys', () => {
    const m: Matchable = { customer_id: 'abc', customer_email: 'A@B.com', customer_name: 'Jane Doe' };
    expect(matchKeysFor(m)).toEqual(['id:abc', 'email:a@b.com', 'name:jane doe']);
  });
  it('skips missing fields', () => {
    expect(matchKeysFor({ customer_id: null, customer_email: null, customer_name: 'X' })).toEqual(['name:x']);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd app && npx vitest run src/lib/followupStatus.test.ts`. Expected: FAIL (`matchKeysFor` not exported).

- [ ] **Step 3: Implement** (append to `followupStatus.ts`)

```ts
/** A row (ticket/order/return) that may attribute to a customer. */
export type Matchable = {
  customer_id?: string | null;
  customer_email?: string | null;
  customer_name?: string | null;
};

/** Candidate keys for matching a row to a customer, in precedence order:
 *  customer_id, then lowercased email, then lowercased name. Build a customer
 *  lookup keyed the same way ('id:'+id, 'email:'+email, 'name:'+name) and take
 *  the first key that hits. */
export function matchKeysFor(m: Matchable): string[] {
  const keys: string[] = [];
  if (m.customer_id) keys.push(`id:${m.customer_id}`);
  if (m.customer_email) keys.push(`email:${m.customer_email.toLowerCase().trim()}`);
  if (m.customer_name) keys.push(`name:${m.customer_name.toLowerCase().trim()}`);
  return keys;
}

/** Build a Map from every match-key of a customer to that customer id. */
export function buildCustomerKeyIndex(customers: Customer[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const c of customers) {
    idx.set(`id:${c.id}`, c.id);
    if (c.email) idx.set(`email:${c.email.toLowerCase().trim()}`, c.id);
    if (c.full_name) idx.set(`name:${c.full_name.toLowerCase().trim()}`, c.id);
  }
  return idx;
}

/** Resolve a matchable row to a customer id using key precedence, or null. */
export function resolveCustomerId(m: Matchable, idx: Map<string, string>): string | null {
  for (const k of matchKeysFor(m)) { const id = idx.get(k); if (id) return id; }
  return null;
}
```

- [ ] **Step 4: Run to verify it passes** — `cd app && npx vitest run src/lib/followupStatus.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/followupStatus.ts app/src/lib/followupStatus.test.ts
git commit -m "feat(followups): customer key-index + match resolution helpers"
```

---

### Task 4: `useFollowUpDirectory` hook

**Files:**
- Modify: `app/src/lib/followupStatus.ts` (add the hook + imports)

- [ ] **Step 1: Add returns/refunds loader + the hook.** First read `app/src/lib/customers.ts:325-340` (the `refund_approvals`→`returns` query in `exportPurchasers`) to mirror the join shape. Then add:

```ts
import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase';
import { useCustomers } from './customers';
import { useServiceTickets } from './service';
import { useQueuedReplacements } from './orders';
import type { FuState } from './customers';

export type DirectoryRow = {
  customer: Customer;
  statuses: Set<FollowUpStatusKey>;
  fuState: FuState;
};

export function useFollowUpDirectory(today: Date = new Date()): {
  rows: DirectoryRow[];
  counts: Record<FollowUpStatusKey, number>;
  overdueCount: number;
  loading: boolean;
} {
  const { customers, loading: lc } = useCustomers();
  const { tickets, loading: lt } = useServiceTickets();
  const { replacements, loading: lr } = useQueuedReplacements();
  // Returned/refunded customer keys (best-effort; failure → empty set).
  const [returnedKeys, setReturnedKeys] = useState<Set<string>>(new Set());
  const [awaitingOnboardingIds, setAwaitingOnboardingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ data: refunds }, { data: lifecycle }] = await Promise.all([
        supabase.from('refund_approvals')
          .select('status, returns(customer_email, customer_name)')
          .eq('status', 'refunded'),
        supabase.from('customer_lifecycle')
          .select('customer_id, onboarding_status'),
      ]);
      if (cancelled) return;
      const rk = new Set<string>();
      for (const r of (refunds ?? []) as Array<{ returns: any }>) {
        const rets = Array.isArray(r.returns) ? r.returns : r.returns ? [r.returns] : [];
        for (const ret of rets) {
          if (ret?.customer_email) rk.add(`email:${ret.customer_email.toLowerCase().trim()}`);
          if (ret?.customer_name) rk.add(`name:${ret.customer_name.toLowerCase().trim()}`);
        }
      }
      setReturnedKeys(rk);
      const ao = new Set<string>();
      for (const l of (lifecycle ?? []) as Array<{ customer_id: string | null; onboarding_status: string }>) {
        if (l.customer_id && l.onboarding_status !== 'completed') ao.add(l.customer_id);
      }
      setAwaitingOnboardingIds(ao);
    })().catch(() => { /* best-effort; leave sets empty */ });
    return () => { cancelled = true; };
  }, []);

  return useMemo(() => {
    const idx = buildCustomerKeyIndex(customers);
    // Group open tickets by resolved customer id.
    const ticketsByCustomer = new Map<string, Pick<ServiceTicket, 'status' | 'category'>[]>();
    for (const t of tickets) {
      if (t.status === 'closed') continue;
      const cid = resolveCustomerId(t, idx);
      if (!cid) continue;
      (ticketsByCustomer.get(cid) ?? ticketsByCustomer.set(cid, []).get(cid)!).push(t);
    }
    const queuedIds = new Set<string>();
    for (const o of replacements) {
      const cid = resolveCustomerId(o as unknown as Matchable, idx);
      if (cid) queuedIds.add(cid);
    }
    const returnedIds = new Set<string>();
    for (const c of customers) {
      if (returnedKeys.has(`email:${(c.email ?? '').toLowerCase().trim()}`)
        || returnedKeys.has(`name:${(c.full_name ?? '').toLowerCase().trim()}`)) returnedIds.add(c.id);
    }

    const counts = Object.fromEntries(STATUS_FILTERS.map(f => [f.key, 0])) as Record<FollowUpStatusKey, number>;
    const rows: DirectoryRow[] = customers.map(c => {
      const ctx: CustomerStatusContext = {
        openTickets: ticketsByCustomer.get(c.id) ?? [],
        queuedReplacement: queuedIds.has(c.id),
        returned: returnedIds.has(c.id),
        awaitingOnboarding: awaitingOnboardingIds.has(c.id),
      };
      const statuses = computeCustomerStatuses(c, ctx, today);
      for (const k of statuses) counts[k] += 1;
      return { customer: c, statuses, fuState: computeFuState(c, today) };
    });
    rows.sort((a, b) =>
      Number(b.statuses.has('overdue')) - Number(a.statuses.has('overdue'))
      || a.customer.full_name.localeCompare(b.customer.full_name));

    return { rows, counts, overdueCount: counts.overdue, loading: lc || lt || lr };
  }, [customers, tickets, replacements, returnedKeys, awaitingOnboardingIds, today, lc, lt, lr]);
}
```

Add `computeFuState` to the existing `./customers` import at the top of the file.

- [ ] **Step 2: Typecheck** — `cd app && npx tsc --noEmit`. Fix any type mismatch (e.g. the ticket `Pick` push pattern). Expected: clean.

- [ ] **Step 3: Run existing tests** — `cd app && npx vitest run src/lib/followupStatus.test.ts`. Expected: still PASS.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/followupStatus.ts
git commit -m "feat(followups): useFollowUpDirectory hook aggregating live sources"
```

---

### Task 5: `FollowUpDirectory` sidebar component + styles

**Files:**
- Create: `app/src/modules/Service/FollowUpDirectory.tsx`
- Modify: `app/src/modules/Service/FollowUps.module.css` (append directory classes)

- [ ] **Step 1: Create the component**

```tsx
import { useMemo, useState } from 'react';
import { STATUS_FILTERS, type FollowUpStatusKey, type DirectoryRow } from '../../lib/followupStatus';
import { FU_STATE_META } from '../../lib/customers';
import styles from './FollowUps.module.css';

export function FollowUpDirectory({
  rows, counts, overdueCount, onSelect,
}: {
  rows: DirectoryRow[];
  counts: Record<FollowUpStatusKey, number>;
  overdueCount: number;
  onSelect: (customerId: string) => void;
}) {
  const [active, setActive] = useState<Set<FollowUpStatusKey>>(new Set());
  const toggle = (k: FollowUpStatusKey) =>
    setActive(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const filtered = useMemo(() => {
    if (active.size === 0) return rows;
    return rows.filter(r => [...active].some(k => r.statuses.has(k)));
  }, [rows, active]);

  return (
    <div className={styles.directory}>
      <div className={styles.dirOverdue} data-warn={overdueCount > 0 ? 'true' : 'false'}>
        {overdueCount > 0 ? `⚠ ${overdueCount} follow-up${overdueCount !== 1 ? 's' : ''} overdue` : 'No overdue follow-ups'}
      </div>
      <div className={styles.dirChips}>
        {STATUS_FILTERS.map(f => (
          <button key={f.key}
            className={`${styles.dirChip} ${active.has(f.key) ? styles.dirChipActive : ''}`}
            onClick={() => toggle(f.key)}>
            {f.label} <span className={styles.dirChipCount}>{counts[f.key]}</span>
          </button>
        ))}
      </div>
      <div className={styles.dirList}>
        {filtered.length === 0
          ? <div className={styles.dirEmpty}>No customers match.</div>
          : filtered.map(r => (
            <button key={r.customer.id} className={styles.dirRow} onClick={() => onSelect(r.customer.id)}>
              <div className={styles.dirRowName}>{r.customer.full_name}</div>
              <div className={styles.dirRowMeta}>
                {r.customer.onboard_date && <span>Onboarded {r.customer.onboard_date}</span>}
                {r.customer.email && <span>{r.customer.email}</span>}
              </div>
              <div className={styles.dirTags}>
                {[...r.statuses].map(k => (
                  <span key={k} className={styles.dirTag} data-status={k}>
                    {STATUS_FILTERS.find(f => f.key === k)?.label ?? k}
                  </span>
                ))}
                <span className={styles.dirFuState} style={{ color: FU_STATE_META[r.fuState].color, background: FU_STATE_META[r.fuState].bg }}>
                  {FU_STATE_META[r.fuState].label}
                </span>
              </div>
            </button>
          ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Append CSS** to `FollowUps.module.css`:

```css
.directory { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.dirOverdue { font-weight: 700; padding: 10px 12px; border-radius: 8px; background: #f7fafc; color: #2d3748; }
.dirOverdue[data-warn='true'] { background: #fff5f5; color: #9b2c2c; }
.dirChips { display: flex; flex-wrap: wrap; gap: 6px; }
.dirChip { font-size: 12px; padding: 4px 10px; border: 1px solid #e2e8f0; border-radius: 999px; background: #fff; cursor: pointer; color: #4a5568; }
.dirChipActive { background: #2b6cb0; color: #fff; border-color: #2b6cb0; }
.dirChipCount { opacity: 0.7; margin-left: 4px; }
.dirList { display: flex; flex-direction: column; gap: 8px; max-height: 70vh; overflow-y: auto; }
.dirEmpty { color: #718096; font-size: 13px; padding: 16px; text-align: center; }
.dirRow { text-align: left; background: #fff; border: 1px solid #edf2f7; border-radius: 8px; padding: 10px 12px; cursor: pointer; }
.dirRow:hover { border-color: #cbd5e0; }
.dirRowName { font-weight: 600; color: #2d3748; }
.dirRowMeta { display: flex; gap: 10px; font-size: 11px; color: #718096; margin: 2px 0 6px; flex-wrap: wrap; }
.dirTags { display: flex; flex-wrap: wrap; gap: 4px; }
.dirTag { font-size: 10px; padding: 2px 6px; border-radius: 4px; background: #edf2f7; color: #4a5568; }
.dirFuState { font-size: 10px; padding: 2px 6px; border-radius: 4px; }
```

- [ ] **Step 3: Typecheck** — `cd app && npx tsc --noEmit`. Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/Service/FollowUpDirectory.tsx app/src/modules/Service/FollowUps.module.css
git commit -m "feat(followups): FollowUpDirectory sidebar (overdue count + filter chips + list)"
```

---

### Task 6: Wire the directory into `FollowUpsTab` + review-status actions

**Files:**
- Modify: `app/src/modules/Service/FollowUpsTab.tsx`
- Modify: `app/src/modules/Service/FollowUps.module.css` (layout row)

- [ ] **Step 1: Layout + data.** In `FollowUpsTab`, import the hook + component + `setReviewStatus` + `useIsMobile`:

```tsx
import { useFollowUpDirectory } from '../../lib/followupStatus';
import { FollowUpDirectory } from './FollowUpDirectory';
import { setReviewStatus } from '../../lib/customers';
import { useIsMobile } from '../../lib/useMediaQuery';
```

Add inside the component:

```tsx
  const { rows, counts, overdueCount } = useFollowUpDirectory(today);
  const isMobile = useIsMobile();
```

Wrap the calendar + directory in a two-column container. Replace the top-level `<div className={styles.wrap}>` body so the calendar and a `<FollowUpDirectory>` sit side by side (calendar first):

```tsx
    <div className={styles.wrap}>
      <div className={isMobile ? styles.layoutStack : styles.layoutSplit}>
        <div className={styles.calCol}>
          <FollowUpCalendar /* …existing props unchanged… */ />
        </div>
        <FollowUpDirectory
          rows={rows} counts={counts} overdueCount={overdueCount}
          onSelect={(id) => setSelected({ customerId: id, kind: 'fu1' })}
        />
      </div>
      {/* existing selectedCustomer panel + openTicket panel stay below */}
    </div>
```

- [ ] **Step 2: Add review buttons** to the existing `selectedActions` block in the selected-customer panel:

```tsx
            <button className={styles.actionBtn} disabled={busy}
              onClick={() => void (async () => { setBusy(true); try { await setReviewStatus(selectedCustomer.id, 'requested'); } finally { setBusy(false); } })()}>
              Mark review requested
            </button>
            <button className={styles.actionBtn} disabled={busy}
              onClick={() => void (async () => { setBusy(true); try { await setReviewStatus(selectedCustomer.id, 'received'); } finally { setBusy(false); } })()}>
              Mark review received
            </button>
```

- [ ] **Step 3: Append layout CSS** to `FollowUps.module.css`:

```css
.layoutSplit { display: grid; grid-template-columns: minmax(0, 3fr) minmax(280px, 2fr); gap: 16px; align-items: start; }
.layoutStack { display: flex; flex-direction: column; gap: 16px; }
.calCol { min-width: 0; }
```

- [ ] **Step 4: Typecheck + build** — `cd app && npx tsc --noEmit && npm run build`. Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add app/src/modules/Service/FollowUpsTab.tsx app/src/modules/Service/FollowUps.module.css
git commit -m "feat(followups): split calendar + directory; review-status actions"
```

---

### Task 7: Render diagnosis-call events on the calendar

**Files:**
- Modify: `app/src/modules/Service/FollowUpsTab.tsx`
- Modify: `app/src/modules/Service/FollowUps.module.css`

- [ ] **Step 1: Extend the event union + builder.** In `FollowUpsTab.tsx`, broaden `CallEvent` to carry a kind:

```tsx
type CallEvent = { type: 'call'; callKind: 'onboarding' | 'diagnosis'; label: string; time: string; ticketId: string };
```

In `eventsByDay`, after the onboarding-call loop, add diagnosis calls (tickets with `category==='diagnosis_call'` and a start time; reuse `calendly_event_start`):

```tsx
    for (const t of tickets) {
      if (t.category === 'diagnosis_call' && t.calendly_event_start) {
        add(t.calendly_event_start.slice(0, 10), {
          type: 'call', callKind: 'diagnosis',
          label: t.customer_name ?? t.subject, time: t.calendly_event_start, ticketId: t.id,
        });
      }
    }
```

Update the existing onboarding `add(...)` to include `callKind: 'onboarding'`.

- [ ] **Step 2: Render the new kind.** In the call-event render branch, choose class + icon by `callKind`:

```tsx
                  return (
                    <button key={`c${i}`} onClick={() => onCallClick(ev.ticketId)}
                      className={`${styles.calEvent} ${ev.callKind === 'diagnosis' ? styles.calEventDiagnosis : styles.calEventCall}`}
                      title={`${ev.callKind === 'diagnosis' ? 'Diagnosis call' : 'Onboarding call'} — ${ev.label} · ${new Date(ev.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}>
                      {ev.callKind === 'diagnosis' ? '🩺' : '🚀'} {ev.label}
                    </button>
                  );
```

Add a legend entry next to the existing ones:

```tsx
        <span className={styles.calLegendItem}>
          <span className={`${styles.calDot} ${styles.calDotDiagnosis}`} /> Diagnosis call
        </span>
```

- [ ] **Step 2b: CSS** — append to `FollowUps.module.css`:

```css
.calEventDiagnosis { background: #faf5ff; color: #6b46c1; border-left: 3px solid #805ad5; }
.calDotDiagnosis { background: #805ad5; }
```

- [ ] **Step 3: Typecheck + build** — `cd app && npx tsc --noEmit && npm run build`. Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/Service/FollowUpsTab.tsx app/src/modules/Service/FollowUps.module.css
git commit -m "feat(followups): render diagnosis calls on the calendar"
```

---

### Task 8: Extract shared Google Calendar helpers

**Files:**
- Create: `supabase/functions/_shared/google-calendar.ts`
- Modify: `supabase/functions/sync-calendly-events/index.ts`

- [ ] **Step 1:** Read `supabase/functions/sync-calendly-events/index.ts:332-480` (the `getCalendarAccessToken` + attendee helpers + `ServiceAccountKey` type). Move them verbatim into `_shared/google-calendar.ts` and `export` each. Add a new `listCalendarEvents`:

```ts
// Shared Google Calendar helpers (service-account, domain-wide delegation).
import { create as createJwt, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
// ^ Match the JWT import actually used in sync-calendly-events; copy that import line exactly.

export type ServiceAccountKey = { client_email: string; private_key: string; token_uri: string };
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

// getCalendarAccessToken(saKey, delegatedSubject): copy verbatim from sync-calendly-events.

/** List events from a calendar (delegated) in [timeMin,timeMax], expanded. */
export async function listCalendarEvents(
  accessToken: string, calendarId: string, timeMin: string, timeMax: string,
): Promise<Array<{ id: string; summary?: string; start?: { dateTime?: string; date?: string }; attendees?: Array<{ email?: string; displayName?: string; organizer?: boolean; self?: boolean }> }>> {
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '250');
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`calendar list ${res.status}: ${await res.text()}`);
  return (await res.json()).items ?? [];
}
```

- [ ] **Step 2:** In `sync-calendly-events/index.ts`, delete the moved definitions and `import { getCalendarAccessToken, /* … */ } from '../_shared/google-calendar.ts';`. Keep all behaviour identical.

- [ ] **Step 3: Verify no behavioural drift** — `deno check supabase/functions/sync-calendly-events/index.ts` (if Deno available) OR carefully diff that only import lines + removed defs changed. Expected: type-checks / no logic change.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/google-calendar.ts supabase/functions/sync-calendly-events/index.ts
git commit -m "refactor(functions): extract shared Google Calendar helpers"
```

---

### Task 9: `sync-google-calendar-diagnosis` edge function

**Files:**
- Create: `supabase/functions/sync-google-calendar-diagnosis/index.ts`
- Create: `supabase/functions/sync-google-calendar-diagnosis/dedupe.test.ts`
- Modify: `supabase/config.toml` (register function)

- [ ] **Step 1: Write the pure dedupe helper + its test first.** Create `dedupe.test.ts`:

```ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { matchesDiagnosisTitle, isDuplicateOf } from './index.ts';

Deno.test('matchesDiagnosisTitle is case-insensitive substring', () => {
  assertEquals(matchesDiagnosisTitle('LILA Diagnosis Chat with Jane', 'LILA Diagnosis Chat'), true);
  assertEquals(matchesDiagnosisTitle('lila diagnosis chat', 'LILA Diagnosis Chat'), true);
  assertEquals(matchesDiagnosisTitle('Onboarding call', 'LILA Diagnosis Chat'), false);
});

Deno.test('isDuplicateOf matches same email within ±15 min', () => {
  const existing = [{ customer_email: 'a@b.com', calendly_event_start: '2026-06-20T15:00:00Z' }];
  assertEquals(isDuplicateOf({ email: 'A@B.com', startIso: '2026-06-20T15:10:00Z' }, existing), true);
  assertEquals(isDuplicateOf({ email: 'a@b.com', startIso: '2026-06-20T15:30:00Z' }, existing), false);
  assertEquals(isDuplicateOf({ email: 'x@y.com', startIso: '2026-06-20T15:05:00Z' }, existing), false);
});
```

- [ ] **Step 2: Implement the function** (model the auth/cron-guard on `sync-calendly-events`):

```ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getCalendarAccessToken, listCalendarEvents } from '../_shared/google-calendar.ts';

const TITLE_MATCH = Deno.env.get('DIAGNOSIS_EVENT_NAME_MATCH') ?? 'LILA Diagnosis Chat';
const CAL_MAILBOX = Deno.env.get('DIAGNOSIS_CALENDAR_MAILBOX') ?? 'huayi@virgohome.io';

export function matchesDiagnosisTitle(summary: string | undefined, needle = TITLE_MATCH): boolean {
  return !!summary && summary.toLowerCase().includes(needle.toLowerCase());
}

export function isDuplicateOf(
  cand: { email: string | null; startIso: string },
  existing: Array<{ customer_email: string | null; calendly_event_start: string | null }>,
): boolean {
  const t = new Date(cand.startIso).getTime();
  const email = (cand.email ?? '').toLowerCase().trim();
  if (!email) return false;
  return existing.some(e =>
    (e.customer_email ?? '').toLowerCase().trim() === email &&
    e.calendly_event_start != null &&
    Math.abs(new Date(e.calendly_event_start).getTime() - t) <= 15 * 60_000);
}

async function handle(req: Request): Promise<Response> {
  if (req.headers.get('X-Cron-Secret') !== Deno.env.get('CRON_SECRET')) {
    return new Response(JSON.stringify({ error: 'cron-only' }), { status: 401 });
  }
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const saKey = JSON.parse(atob(Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY')!));
  const token = await getCalendarAccessToken(saKey, CAL_MAILBOX);

  const now = Date.now();
  const timeMin = new Date(now - 7 * 86_400_000).toISOString();
  const timeMax = new Date(now + 60 * 86_400_000).toISOString();
  const events = await listCalendarEvents(token, 'primary', timeMin, timeMax);

  // Existing diagnosis tickets in-window for dedupe (incl. Calendly-sourced).
  const { data: existing } = await sb.from('service_tickets')
    .select('customer_email, calendly_event_start, google_calendar_event_id')
    .eq('category', 'diagnosis_call')
    .gte('calendly_event_start', timeMin);
  const existingRows = existing ?? [];

  let scanned = 0, matched = 0, upserted = 0, skipped = 0;
  for (const ev of events) {
    scanned++;
    if (!matchesDiagnosisTitle(ev.summary)) continue;
    const startIso = ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00Z` : null);
    if (!ev.id || !startIso) { skipped++; continue; }
    matched++;
    const attendee = (ev.attendees ?? []).find(a => !a.organizer && !a.self);
    const email = attendee?.email ?? null;
    const name = attendee?.displayName ?? attendee?.email ?? null;
    // Skip if a Calendly-sourced diagnosis ticket already covers this call.
    if (!existingRows.some(r => r.google_calendar_event_id === ev.id)
        && isDuplicateOf({ email, startIso }, existingRows)) { skipped++; continue; }
    const { error } = await sb.from('service_tickets').upsert({
      category: 'diagnosis_call', source: 'google_calendar', status: 'call_scheduled',
      google_calendar_event_id: ev.id, calendly_event_start: startIso,
      subject: ev.summary ?? 'LILA Diagnosis Chat',
      customer_email: email, customer_name: name,
    }, { onConflict: 'google_calendar_event_id' });
    if (error) { skipped++; continue; }
    upserted++;
  }
  return new Response(JSON.stringify({ scanned, matched, upserted, skipped }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(handle);
```

> Note for the implementer: confirm `service_tickets` has a UNIQUE constraint on `google_calendar_event_id` (migration `20260604370000_service_tickets_diagnosis_call.sql` created an index — verify it's UNIQUE; if only a plain index, add a partial unique index in a small migration `…_diagnosis_gcal_unique.sql`: `CREATE UNIQUE INDEX IF NOT EXISTS service_tickets_gcal_event_uniq ON service_tickets (google_calendar_event_id) WHERE google_calendar_event_id IS NOT NULL;`). `ticket_number` may be required — check the table; if it has no default, generate one in the upsert payload following how `sync-calendly-events` sets it.

- [ ] **Step 3: Run the dedupe test** — `cd supabase/functions/sync-google-calendar-diagnosis && deno test dedupe.test.ts`. Expected: PASS. (If Deno isn't installed, note it and rely on the same pure logic mirrored in a Vitest test under `app/src/lib/` instead.)

- [ ] **Step 4: Register in `supabase/config.toml`** (mirror the `sync-calendly-events` block):

```toml
[functions.sync-google-calendar-diagnosis]
verify_jwt = false
```

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/sync-google-calendar-diagnosis/ supabase/config.toml
git commit -m "feat(functions): sync-google-calendar-diagnosis (LILA Diagnosis Chat → tickets)"
```

---

### Task 10: Schedule the sync (pg_cron)

**Files:**
- Create: `supabase/migrations/20260618130000_cron_diagnosis_sync.sql`

- [ ] **Step 1:** Read `supabase/migrations/20260611200100_cron_sales_projection_snapshot.sql` and copy its exact `cron.schedule` + `net.http_post` shape (it pulls `supabase_url` + the cron secret from `vault.decrypted_secrets`). Write:

```sql
-- Run the diagnosis-call Google Calendar sync every 30 minutes.
SELECT cron.schedule(
  'sync-google-calendar-diagnosis',
  '*/30 * * * *',
  $$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/sync-google-calendar-diagnosis',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Cron-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
      ),
      body := '{}'::jsonb
    );
  $$
);
```

> Match the exact secret names used by the sales-projection cron (`supabase_url`, `cron_secret`) — adjust if that migration uses different names.

- [ ] **Step 2: Apply** via Supabase MCP `apply_migration` (name `cron_diagnosis_sync`). Expected: success. (If `cron`/`net` extensions or secrets differ, follow the existing cron migration exactly.)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260618130000_cron_diagnosis_sync.sql
git commit -m "feat(cron): schedule diagnosis-call calendar sync every 30m"
```

---

### Task 11: Full verification

- [ ] **Step 1: Tests** — `cd app && npm test`. Expected: all green (incl. `followupStatus.test.ts`).
- [ ] **Step 2: Build** — `cd app && npm run build`. Expected: success.
- [ ] **Step 3: Deploy the function** via Supabase MCP `deploy_edge_function` (`sync-google-calendar-diagnosis`) and the refactored `sync-calendly-events`. Confirm `DIAGNOSIS_CALENDAR_MAILBOX` / `GOOGLE_SERVICE_ACCOUNT_KEY` secrets exist (the SA must have delegation over Huayi's calendar).
- [ ] **Step 4: Manual smoke** — invoke `sync-google-calendar-diagnosis` once (POST with `X-Cron-Secret`); confirm the `{scanned,matched,upserted,skipped}` summary, then open Service → Follow-Ups and confirm a known "LILA Diagnosis Chat" event shows as a 🩺 diagnosis event and the directory chips/overdue count populate. **This live Google step can't be verified from the dev environment — flag results to the user.**
- [ ] **Step 5: Final commit / open PR** as directed.

---

## Notes / risks
- The live Google fetch and cron can only be verified after deploy with real secrets; everything else (derivation, directory, calendar render) is testable locally.
- If `service_tickets.ticket_number` is NOT NULL without a default, the upsert in Task 9 must generate one — check the table before deploying.
- Diagnosis calls already arrive via Calendly; the ±15-min dedupe prevents double-listing, but watch the first live run's `skipped` count to confirm dedupe behaves.
