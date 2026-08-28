# Stock Batch Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Add batch" section to the Stock page's LILA Units tab, visible and usable only to people on a new `stock_managers` allowlist plus leadership (finance/admin).

**Architecture:** A per-person allowlist table (`stock_managers`) plus a `can_manage_batches()` SECURITY DEFINER helper, mirroring Hiring's `posting_interviewers` / `can_view_posting()` precedent exactly. The `batches` table gets the INSERT policy it never had — that policy is the security boundary. The client mirrors the decision in a pure `canManageBatches()` for UI gating only. No role enum changes; Junaid stays `operator`.

**Tech Stack:** React 18 + TypeScript, Vite, CSS Modules, Supabase (Postgres + RLS), Vitest.

**Spec:** [docs/superpowers/specs/2026-08-28-stock-batch-admin-design.md](../specs/2026-08-28-stock-batch-admin-design.md)

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260828120000_stock_managers_and_batch_insert.sql` | Create: allowlist table, `can_manage_batches()`, RLS on both tables, Junaid seed |
| `app/src/lib/permissions.ts` | Modify: add `canManageBatches(role, isStockManager)` — pure decision |
| `app/src/lib/permissions.test.ts` | Modify: matrix test for the new function |
| `app/src/lib/stock.ts` | Modify: add `BatchInput`, `createBatch()`, `isStockManager()`, `useIsStockManager()` |
| `app/src/lib/stock.test.ts` | Create: unit tests for `createBatch` + `isStockManager` |
| `app/src/modules/Stock/NewBatchModal.tsx` | Create: the form modal |
| `app/src/modules/Stock/UnitsTab.tsx` | Modify: gated button above `BatchCards` |
| `app/src/modules/Stock/Stock.module.css` | Modify: one toolbar class + one error class |

`NewBatchModal.tsx` is its own file rather than living inside `UnitsTab.tsx` because `UnitsTab` is already the module's filter/state hub; the modal has thirteen fields and its own local form state, and mixing them makes both harder to read.

## Preconditions

**Run every command from the repo root unless a step says otherwise.**

Vitest needs Supabase env vars or ~48 files fail to load at import time. There is no `.env.local` in `app/`, so pass them inline exactly as CI does ([deploy.yml:37-40](../../../.github/workflows/deploy.yml)). Any non-empty values work — no test hits the network:

```bash
export VITE_SUPABASE_URL=https://stub.supabase.co
export VITE_SUPABASE_ANON_KEY=stub-anon-key
```

Do this once per shell; every test command below assumes it.

---

### Task 1: Migration — allowlist table, helper, policies

**Files:**
- Create: `supabase/migrations/20260828120000_stock_managers_and_batch_insert.sql`

The timestamp must sort after `20260827090000_customer_profitability_v12_legacy_freight.sql`, the current latest.

- [ ] **Step 1: Write the migration**

```sql
-- Stock batch administration.
--
-- `batches` has carried SELECT + UPDATE policies since 20260604200000 and no
-- INSERT policy at all, so no browser client could ever create a batch —
-- every batch to date arrived as a hand-written migration. This adds the
-- missing INSERT policy, gated on a new per-person allowlist.
--
-- Deliberately NOT a new role. user_role stays ('operator','manager',
-- 'finance','admin'). Junaid — who runs Stock — is an `operator`, and
-- `operator` is the default every new sign-in receives, so gating on it
-- would gate on everyone. Moving him to a new role would silently revoke
-- submit_to_manager / move_refund_flow / edit_warranty_registration, which
-- all list 'operator' in ACTION_ROLES (app/src/lib/permissions.ts).
--
-- Shape mirrors Hiring's posting_interviewers + can_view_posting()
-- (20260724140000_hiring_schema.sql:57-93).

create table if not exists public.stock_managers (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  added_by   uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.stock_managers enable row level security;

-- is_finance() already resolves to finance-or-admin, so leadership is always
-- included without being listed.
create or replace function public.can_manage_batches()
returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_finance() or exists (
    select 1 from public.stock_managers where profile_id = auth.uid()
  );
$$;

grant execute on function public.can_manage_batches() to authenticated;

-- SELECT is deliberately narrow: a user can resolve their OWN membership
-- without enumerating the list. Gating SELECT on can_manage_batches() would
-- be circular — a non-member could not read the table to learn they are not
-- a member.
drop policy if exists "stock_managers_select" on public.stock_managers;
create policy "stock_managers_select" on public.stock_managers
  for select to authenticated
  using (profile_id = auth.uid() or public.is_finance());

drop policy if exists "stock_managers_insert" on public.stock_managers;
create policy "stock_managers_insert" on public.stock_managers
  for insert to authenticated
  with check (public.is_finance());

drop policy if exists "stock_managers_delete" on public.stock_managers;
create policy "stock_managers_delete" on public.stock_managers
  for delete to authenticated
  using (public.is_finance());

-- Seed Junaid. Guarded: if the profile does not exist yet (he has not signed
-- in on this environment), this inserts nothing rather than failing.
insert into public.stock_managers (profile_id)
select p.id
  from public.profiles p
  join auth.users u on u.id = p.id
 where lower(u.email) = 'junaid@virgohome.io'
on conflict (profile_id) do nothing;

-- The actual security boundary for the new UI.
drop policy if exists "batches_insert" on public.batches;
create policy "batches_insert" on public.batches
  for insert to authenticated
  with check (public.can_manage_batches());
```

- [ ] **Step 2: Verify it parses**

There is no local Postgres in this repo and the makeLILA Supabase project is not reachable from the coding session, so this is a syntax read-through, not an execution. Confirm by eye:
- every statement ends in `;`
- the `$$` function body opens and closes
- `is_finance()` exists — it does, `20260607020000_profiles_role_enum_and_canDo_canView.sql:105-110`

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260828120000_stock_managers_and_batch_insert.sql
git commit -m "feat(stock): stock_managers allowlist + batches INSERT policy"
```

---

### Task 2: `canManageBatches` in permissions.ts

**Files:**
- Modify: `app/src/lib/permissions.ts`
- Test: `app/src/lib/permissions.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `app/src/lib/permissions.test.ts`. Also add `canManageBatches` to the existing import on line 2.

```typescript
describe('canManageBatches', () => {
  const roles: Array<Role | null> = ['operator', 'manager', 'finance', 'admin', null];

  it.each(roles)('role %s + allowlisted = true', (role) => {
    expect(canManageBatches(role, true)).toBe(true);
  });

  it.each(roles)('role %s + not allowlisted = leadership only', (role) => {
    const expected = role === 'finance' || role === 'admin';
    expect(canManageBatches(role, false)).toBe(expected);
  });

  // Mirrors canAccessHiringModule: a true allowlist flag can only come from an
  // RLS-gated read filtered on the caller's own id, so it stands on its own
  // while AuthProvider's separate profile fetch is still in flight.
  it('admits an allowlisted user whose role has not loaded yet', () => {
    expect(canManageBatches(null, true)).toBe(true);
  });

  it('denies an unloaded role with no allowlist row', () => {
    expect(canManageBatches(null, false)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run src/lib/permissions.test.ts`
Expected: FAIL — `"canManageBatches" is not exported by "src/lib/permissions.ts"`

- [ ] **Step 3: Write the implementation**

Append to `app/src/lib/permissions.ts`:

```typescript
/** Batch administration on the Stock page. Leadership always qualifies;
 *  anyone else needs a `stock_managers` row (see the can_manage_batches()
 *  RLS helper, which this mirrors). Deliberately NOT role-based: Junaid runs
 *  Stock as an `operator`, and `operator` is the default role every new
 *  sign-in receives — gating on it would gate on everyone.
 *
 *  Null-role handling follows canAccessHiringModule(), not canViewPosting():
 *  isStockManager can only be true after an RLS-gated read filtered on the
 *  caller's own id has already succeeded, so it proves an identified user on
 *  its own. A null role at that moment means AuthProvider's profile fetch
 *  has not resolved yet — treating it as a denial would flash-hide the
 *  section from a legitimate stock manager. */
export function canManageBatches(
  role: Role | null | undefined,
  isStockManager: boolean,
): boolean {
  return isLeadership(role) || isStockManager;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run src/lib/permissions.test.ts`
Expected: PASS — all `canDo` / `canView` / `canViewPosting` / `canAccessHiringModule` / `canManageBatches` suites green.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/permissions.ts app/src/lib/permissions.test.ts
git commit -m "feat(stock): canManageBatches permission helper"
```

---

### Task 3: `createBatch` + `isStockManager` in stock.ts

**Files:**
- Modify: `app/src/lib/stock.ts`
- Test: `app/src/lib/stock.test.ts` (create)

`getCurrentUserId()` already exists in `hiring.ts`, but importing Hiring into Stock for a three-line auth read is a bad dependency. Call `supabase.auth.getUser()` directly instead.

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/stock.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBatch, isStockManager } from './stock';

const { mockInsert, mockLimit, mockGetUser, mockLogAction } = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockLimit: vi.fn(),
  mockGetUser: vi.fn(),
  mockLogAction: vi.fn(),
}));

vi.mock('./supabase', () => ({
  supabase: {
    auth: { getUser: mockGetUser },
    from: (table: string) => ({
      insert: (row: unknown) => mockInsert(table, row),
      select: () => ({ eq: () => ({ limit: mockLimit }) }),
    }),
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
  },
}));

vi.mock('./activityLog', () => ({
  logAction: mockLogAction,
  useActivityForEntity: () => ({ events: [], loading: false }),
}));

vi.mock('./supabaseTelemetry', () => ({
  supabaseTelemetry: null,
  isTelemetryConfigured: () => false,
}));

const validInput = { id: 'P200', unit_count: 200, manufacturer: 'Dongguan LC Technology' };

beforeEach(() => {
  vi.clearAllMocks();
  mockInsert.mockResolvedValue({ error: null });
  mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
});

describe('createBatch', () => {
  it('inserts the batch and writes an activity-log entry', async () => {
    await createBatch(validInput);
    expect(mockInsert).toHaveBeenCalledWith('batches', expect.objectContaining({
      id: 'P200', unit_count: 200, manufacturer: 'Dongguan LC Technology',
    }));
    expect(mockLogAction).toHaveBeenCalledWith(
      'batch_created', 'P200', expect.stringContaining('200 units'),
    );
  });

  it('trims the id and nulls blank optional fields', async () => {
    await createBatch({ ...validInput, id: '  P200  ', version: '   ', notes: '' });
    expect(mockInsert).toHaveBeenCalledWith('batches', expect.objectContaining({
      id: 'P200', version: null, notes: null,
    }));
  });

  it('rejects a blank id before touching the database', async () => {
    await expect(createBatch({ ...validInput, id: '   ' })).rejects.toThrow('Batch ID is required');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects a non-positive unit count', async () => {
    await expect(createBatch({ ...validInput, unit_count: 0 }))
      .rejects.toThrow('Unit count must be a positive whole number');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('turns a PK violation into a readable duplicate message', async () => {
    mockInsert.mockResolvedValue({ error: { code: '23505', message: 'duplicate key value' } });
    await expect(createBatch(validInput)).rejects.toThrow('Batch "P200" already exists');
  });

  it('does not log when the insert fails', async () => {
    mockInsert.mockResolvedValue({ error: { code: '42501', message: 'permission denied' } });
    await expect(createBatch(validInput)).rejects.toThrow('permission denied');
    expect(mockLogAction).not.toHaveBeenCalled();
  });
});

describe('isStockManager', () => {
  it('is true when the allowlist returns a row', async () => {
    mockLimit.mockResolvedValue({ data: [{ profile_id: 'u1' }], error: null });
    expect(await isStockManager()).toBe(true);
  });

  it('is false when the allowlist is empty', async () => {
    mockLimit.mockResolvedValue({ data: [], error: null });
    expect(await isStockManager()).toBe(false);
  });

  it('is false — not thrown — when the query errors', async () => {
    mockLimit.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect(await isStockManager()).toBe(false);
  });

  it('is false when signed out, without querying', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect(await isStockManager()).toBe(false);
    expect(mockLimit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run src/lib/stock.test.ts`
Expected: FAIL — `"createBatch" is not exported by "src/lib/stock.ts"`

- [ ] **Step 3: Write the implementation**

Append to `app/src/lib/stock.ts`:

```typescript
// ---------- batch administration ----------

export type BatchInput = {
  id: string;
  unit_count: number;
  manufacturer: string;
  version?: string | null;
  manufacturer_short?: string | null;
  incoterm?: string | null;
  unit_cost_usd?: number | null;
  total_cost_usd?: number | null;
  invoice_no?: string | null;
  invoice_date?: string | null;
  expected_arrival_date?: string | null;
  arrived_at?: string | null;
  destination?: string | null;
  notes?: string | null;
};

const blankToNull = (v: string | null | undefined): string | null => v?.trim() || null;

/** Create a batch row. Gated server-side by the batches_insert RLS policy
 *  (can_manage_batches()); the UI gate is cosmetic. */
export async function createBatch(input: BatchInput): Promise<void> {
  const id = input.id.trim();
  const manufacturer = input.manufacturer.trim();
  if (!id) throw new Error('Batch ID is required');
  if (!manufacturer) throw new Error('Manufacturer is required');
  if (!Number.isInteger(input.unit_count) || input.unit_count < 1) {
    throw new Error('Unit count must be a positive whole number');
  }

  const { error } = await supabase.from('batches').insert({
    id,
    unit_count: input.unit_count,
    manufacturer,
    version: blankToNull(input.version),
    manufacturer_short: blankToNull(input.manufacturer_short),
    incoterm: blankToNull(input.incoterm),
    unit_cost_usd: input.unit_cost_usd ?? null,
    total_cost_usd: input.total_cost_usd ?? null,
    invoice_no: blankToNull(input.invoice_no),
    invoice_date: blankToNull(input.invoice_date),
    expected_arrival_date: blankToNull(input.expected_arrival_date),
    arrived_at: blankToNull(input.arrived_at),
    destination: blankToNull(input.destination),
    notes: blankToNull(input.notes),
  });

  if (error) {
    // 23505 = unique_violation on the text PK.
    throw new Error(error.code === '23505' ? `Batch "${id}" already exists` : error.message);
  }

  await logAction('batch_created', id, `${input.unit_count} units · ${manufacturer}`);
}

/** True if the signed-in user has a stock_managers row. The SELECT policy
 *  only exposes the caller's own row, so this is self-scoped by construction.
 *  Returns false rather than throwing — a failed read must not blank the tab. */
export async function isStockManager(): Promise<boolean> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) return false;
  const { data, error } = await supabase
    .from('stock_managers')
    .select('profile_id')
    .eq('profile_id', userId)
    .limit(1);
  if (error) return false;
  return (data?.length ?? 0) > 0;
}

/** Hook wrapper for isStockManager() — fetches once on mount. Pair with
 *  canManageBatches(role, isManager) from lib/permissions.ts. */
export function useIsStockManager(): { isManager: boolean; loading: boolean } {
  const [isManager, setIsManager] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await isStockManager();
      if (!cancelled) { setIsManager(result); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);
  return { isManager, loading };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run src/lib/stock.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/stock.ts app/src/lib/stock.test.ts
git commit -m "feat(stock): createBatch + stock-manager allowlist read"
```

---

### Task 4: `NewBatchModal.tsx`

**Files:**
- Create: `app/src/modules/Stock/NewBatchModal.tsx`

Structure copies `PartsTab.tsx:307-418` — same `modalBackdrop / modalCard / modalHead / modalBody / modalGrid / modalRow / modalInput / modalFoot / modalPrimary / modalSecondary` classes, all already in `Stock.module.css`. Do **not** copy `NewPOModal.tsx`; it uses inline styles, which this module does not.

- [ ] **Step 1: Write the component**

```tsx
import { useState } from 'react';
import { createBatch } from '../../lib/stock';
import styles from './Stock.module.css';

type Props = { onClose: () => void };

export function NewBatchModal({ onClose }: Props) {
  const [f, setF] = useState({
    id: '', version: '', manufacturer: '', manufacturer_short: '', incoterm: '',
    unit_count: '', unit_cost_usd: '', total_cost_usd: '',
    invoice_no: '', invoice_date: '', expected_arrival_date: '', arrived_at: '',
    destination: '', notes: '',
  });
  // Once the operator edits the total by hand we stop recomputing it. P50N is
  // why this field is not derived: 314.00 × 40 = 12,560, but the stored total
  // is 13,300 because that invoice also covered 40 replacement top lids.
  const [totalTouched, setTotalTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set(key: keyof typeof f, value: string) {
    setF(prev => {
      const next = { ...prev, [key]: value };
      if (!totalTouched && (key === 'unit_cost_usd' || key === 'unit_count')) {
        const cost = parseFloat(next.unit_cost_usd);
        const count = parseInt(next.unit_count, 10);
        next.total_cost_usd =
          Number.isFinite(cost) && Number.isInteger(count) ? (cost * count).toFixed(2) : '';
      }
      return next;
    });
  }

  const num = (v: string): number | null => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };

  async function submit() {
    setBusy(true); setError(null);
    try {
      await createBatch({
        id: f.id,
        unit_count: parseInt(f.unit_count, 10),
        manufacturer: f.manufacturer,
        version: f.version,
        manufacturer_short: f.manufacturer_short,
        incoterm: f.incoterm,
        unit_cost_usd: num(f.unit_cost_usd),
        total_cost_usd: num(f.total_cost_usd),
        invoice_no: f.invoice_no,
        invoice_date: f.invoice_date,
        expected_arrival_date: f.expected_arrival_date,
        arrived_at: f.arrived_at,
        destination: f.destination,
        notes: f.notes,
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const text = (key: keyof typeof f, label: string, placeholder?: string, type = 'text') => (
    <div className={styles.modalRow}>
      <label>{label}</label>
      <input
        type={type} value={f[key]} placeholder={placeholder}
        onChange={e => set(key, e.target.value)}
        className={styles.modalInput}
      />
    </div>
  );

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <strong>New batch</strong>
          <button onClick={onClose} className={styles.modalClose}>✕</button>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.modalGrid}>
            <div className={styles.modalRow}>
              <label>Batch ID *</label>
              <input
                type="text" value={f.id} placeholder="P200"
                onChange={e => set('id', e.target.value)}
                className={styles.modalInput}
                autoFocus
              />
            </div>
            {text('version', 'Version', 'v3.8')}
            <div className={styles.modalRow}>
              <label>Manufacturer *</label>
              <input
                type="text" value={f.manufacturer} placeholder="Dongguan LC Technology"
                onChange={e => set('manufacturer', e.target.value)}
                className={styles.modalInput}
              />
            </div>
            {text('manufacturer_short', 'Short name', 'LC')}
            {text('incoterm', 'Incoterm', 'CNF Toronto')}
            <div className={styles.modalRow}>
              <label>Unit count *</label>
              <input
                type="number" min={1} value={f.unit_count} placeholder="200"
                onChange={e => set('unit_count', e.target.value)}
                className={styles.modalInput}
              />
            </div>
            {text('unit_cost_usd', 'Unit cost (USD)', '298.00', 'number')}
            <div className={styles.modalRow}>
              <label>Total cost (USD)</label>
              <input
                type="number" step="0.01" value={f.total_cost_usd}
                onChange={e => { setTotalTouched(true); set('total_cost_usd', e.target.value); }}
                className={styles.modalInput}
              />
            </div>
            {text('invoice_no', 'Invoice #', 'CP20260701-Rev1')}
            {text('invoice_date', 'Invoice date', undefined, 'date')}
            {text('expected_arrival_date', 'Expected arrival', undefined, 'date')}
            {text('arrived_at', 'Arrived on', undefined, 'date')}
          </div>
          {text('destination', 'Destination', 'MicroArt, Markham')}
          <div className={styles.modalRow}>
            <label>Notes</label>
            <textarea
              value={f.notes} onChange={e => set('notes', e.target.value)}
              placeholder="Container #, customs broker, parts changes vs the last batch…"
              className={styles.modalTextarea}
              rows={2}
            />
          </div>
          <div className={styles.modalHint}>
            Leave <strong>Arrived on</strong> empty for a batch still in production —
            the card will read “In production”. Unit count is invoice metadata: the
            card shows <strong>Total 0</strong> until serials are claimed in Build.
          </div>
          {error && <div className={styles.modalError}>{error}</div>}
        </div>
        <div className={styles.modalFoot}>
          <button onClick={onClose} className={styles.modalSecondary} disabled={busy}>Cancel</button>
          <button
            onClick={() => void submit()}
            className={styles.modalPrimary}
            disabled={busy || !f.id.trim() || !f.manufacturer.trim() || !f.unit_count}
          >
            {busy ? 'Creating…' : 'Create batch'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd app && npx tsc -b --noEmit`
Expected: no errors. If `modalHint` / `modalError` are flagged, they are added in Task 5 — run this again after that task.

- [ ] **Step 3: Commit**

```bash
git add app/src/modules/Stock/NewBatchModal.tsx
git commit -m "feat(stock): new-batch modal form"
```

---

### Task 5: Wire the gated button into UnitsTab

**Files:**
- Modify: `app/src/modules/Stock/UnitsTab.tsx`
- Modify: `app/src/modules/Stock/Stock.module.css`

- [ ] **Step 1: Add the CSS**

Append to `app/src/modules/Stock/Stock.module.css`. Stock.module.css is not yet in the `check-css-tokens.mjs` MIGRATED ratchet, but use tokens anyway so it stays clean when its turn comes:

```css
.batchAdminBar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
.modalHint {
  font-size: 10px;
  line-height: 1.5;
  color: var(--color-ink-subtle);
  background: var(--color-surface);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
}
.modalError {
  font-size: 11px;
  color: var(--color-error);
}
```

- [ ] **Step 2: Wire up UnitsTab**

Three edits to `app/src/modules/Stock/UnitsTab.tsx`.

Imports — add `useIsStockManager` to the existing `../../lib/stock` import, then add three lines:

```tsx
import { useAuth } from '../../lib/auth';
import { canManageBatches } from '../../lib/permissions';
import { NewBatchModal } from './NewBatchModal';
```

Inside the component, alongside the other `useState` calls (after `const [suspectFilter, setSuspectFilter] = useState(false);`):

```tsx
  const { role } = useAuth();
  const { isManager } = useIsStockManager();
  const [showNewBatch, setShowNewBatch] = useState(false);
  const canAddBatch = canManageBatches(role, isManager);
```

In the returned JSX, immediately after `<div className={styles.stockLayout}>` and **before** `<BatchCards`:

```tsx
      {canAddBatch && (
        <div className={styles.batchAdminBar}>
          <button className={styles.btnPrimary} onClick={() => setShowNewBatch(true)}>
            + Add batch
          </button>
        </div>
      )}
      {showNewBatch && <NewBatchModal onClose={() => setShowNewBatch(false)} />}
```

`useBatches()` already subscribes to the `batches:realtime` channel ([stock.ts:147-166](../../../app/src/lib/stock.ts)), so the new card appears without a reload once the insert lands.

- [ ] **Step 3: Verify the full suite and the build**

```bash
cd app && npx vitest run
```
Expected: PASS, with no new failures versus the pre-change baseline.

```bash
cd app && npm run build
```
Expected: succeeds. This also runs `check-css-tokens.mjs` and `tsc -b`.

If the build is being checked for CI parity, note that CI runs Node 20 while local dev is Node 24 — use `npx node@20` if a version-sensitive failure appears.

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/Stock/UnitsTab.tsx app/src/modules/Stock/Stock.module.css
git commit -m "feat(stock): gated add-batch section on the LILA Units tab"
```

---

### Task 6: Manual verification

**Files:** none — this is a runtime check.

- [ ] **Step 1: Apply the migration**

The makeLILA Supabase project is not reachable from the coding session (it lives in a different Supabase org than the one connected to MCP). Push it the normal way, via `.github/workflows/supabase.yml`, or run `supabase db push` against the project with credentials on hand.

- [ ] **Step 2: Confirm the gate both ways**

```sql
-- as a leadership account: expect true
select public.can_manage_batches();

-- confirm Junaid actually landed on the list
select p.display_name from public.stock_managers s
  join public.profiles p on p.id = s.profile_id;
```

If that second query returns no rows, Junaid has not signed in on this environment, so the guarded seed inserted nothing. Add him once his profile exists.

- [ ] **Step 3: Confirm the UI**

Sign in as a non-leadership, non-allowlisted account: the **+ Add batch** button must be absent from Stock → LILA Units. Sign in as leadership or as Junaid: the button appears, and creating a batch adds a card reading "In production" with **Total 0**.

- [ ] **Step 4: Confirm the boundary, not just the button**

The real test is that RLS refuses a non-manager even when the UI is bypassed. In the browser console as a non-allowlisted internal user:

```js
await supabase.from('batches').insert({ id: 'RLSTEST', manufacturer: 'x', unit_count: 1 })
```
Expected: an error with code `42501` (insufficient privilege) and no row created.

---

## Notes for the implementer

- **The client gate is cosmetic.** `canManageBatches()` hides an affordance; `batches_insert` is what enforces the rule. Never treat the first as the security control.
- **`unit_count` is invoice metadata, not a row count.** The card's "Total" comes from real `units` rows via `sliceTotals()` ([BatchCards.tsx:18-28](../../../app/src/modules/Stock/BatchCards.tsx)). A new batch reads Total 0 until serials are claimed. This is correct, and the modal hint exists to pre-empt the "my batch is empty" question.
- **P200 and LILA-Mini already appear in the Build PO dropdown** ([NewPOModal.tsx:66-67](../../../app/src/modules/Build/NewPOModal.tsx)) with no `batches` row. `factory_orders.batch` has no FK so the PO saves, but the first `assignSerial()` into them fails on `units.batch → batches(id)`. Once this ships, creating those two batch rows is the fix.
- **Roles are untouched by design.** If a future task wants a real `stock` role, `submit_to_manager`, `move_refund_flow`, and `edit_warranty_registration` in `ACTION_ROLES` all need auditing first — and Postgres enum values cannot be dropped once added.
