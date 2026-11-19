# Claim a Serial Range Under a Batch + PO — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a whole block of serials (e.g. LL01-…691 to LL01-…780) as units in one action from Build's claim dialog, under one batch and linked to one purchase order.

**Architecture:** A new nullable `units.po_id` links units to `factory_orders`. Pure helpers in `lib/build.ts` parse serial input and plan a range (create / link PO / skip with reason); `claimSerialRange` re-reads the range, inserts all new units in one insert-only statement, fills the PO on existing unlinked same-batch units in one update, and logs. A new `ClaimSerialsModal` replaces the inline single-serial modal in `Build/index.tsx`, with a PO picker that locks the batch, a range mode with a live preview, and a result view. The PO card's "made" count becomes PO-aware through a pure helper.

**Tech Stack:** React 18 + TypeScript, Supabase JS (untyped client), CSS Modules, Vitest + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-10-13-claim-serial-range-design.md`

## Global Constraints

- Branch: `feat/claim-serial-range` (already created from local `main`, spec committed).
- All commands run from `app/` unless stated. Vitest and the build need the env vars inline:

  ```bash
  VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npx vitest run <file>
  ```

- `shipmentEmailTemplate.test.ts` fails 2 tests on this Windows checkout only (CRLF). Ignore those two; anything else red is real.
- Existing units are never moved to another batch or overwritten. The only change to an existing unit is filling `po_id` where it is null and the batch matches.
- Components never import `supabase`; data access stays in `app/src/lib/`.
- Commit after each task. Write the message to a file and use `git commit -F` (heredocs inside `$(...)` break in this Git Bash). Every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Do not push and do not apply the migration to the shared database.

## File Map

| File | Change |
|---|---|
| `supabase/migrations/20261013120000_units_po_id.sql` | **Create.** `units.po_id` FK + partial index. |
| `app/src/lib/stock.ts` | `Unit.po_id`. |
| `app/src/modules/Stock/__tests__/UnitTable.test.tsx` | Fixture gains `po_id: null`. |
| `app/src/lib/build.ts` | `formatSerial`, `parseSerialInput`, `planSerialRange`, `RANGE_SKIP_LABEL`, `unitsMadeForPO`, `claimSerialRange`, `assignSerial` po_id. |
| `app/src/lib/build.claimRange.test.ts` | **Create.** All lib tests for the above. |
| `app/src/modules/Build/PipelineBoard.tsx` | PO card count via `unitsMadeForPO`. |
| `app/src/modules/Build/ClaimSerialsModal.tsx` | **Create.** The dialog. |
| `app/src/modules/Build/Build.module.css` | Modal + claim classes. |
| `app/src/modules/Build/__tests__/ClaimSerialsModal.test.tsx` | **Create.** Dialog tests. |
| `app/src/modules/Build/index.tsx` | Use the new modal; button "+ Claim serials". |
| `app/src/modules/Build/__tests__/batchSource.test.tsx` | New label, Batch by label, One-serial mode. |

---

### Task 1: `units.po_id` column + type

**Files:**
- Create: `supabase/migrations/20261013120000_units_po_id.sql`
- Modify: `app/src/lib/stock.ts` (`Unit` type, after `batch: string;`)
- Modify: `app/src/modules/Stock/__tests__/UnitTable.test.tsx` (the `unit()` fixture)

- [ ] **Step 1: Write the migration**

```sql
-- Purchase order a unit was claimed under (Build › "+ Claim serials").
-- Nullable: units claimed before POs were linked, or claimed with "No PO",
-- carry none. ON DELETE SET NULL so removing a PO never removes units.
alter table public.units
  add column if not exists po_id uuid
    references public.factory_orders(id) on delete set null;

create index if not exists idx_units_po_id
  on public.units (po_id)
  where po_id is not null;
```

- [ ] **Step 2: Add the field to `Unit`**

In `app/src/lib/stock.ts`, inside `export type Unit = {`, directly after `  batch: string;` add:

```ts
  // Purchase order this unit was claimed under (factory_orders.id). Null for
  // units claimed before POs were linked, or claimed with "No PO".
  po_id: string | null;
```

- [ ] **Step 3: Keep the full-`Unit` test fixture compiling**

In `app/src/modules/Stock/__tests__/UnitTable.test.tsx`, change the fixture line
`  is_team_test: false, backfilled_at: null, backfill_source: null, mac_address: null,`
to
`  is_team_test: false, backfilled_at: null, backfill_source: null, mac_address: null, po_id: null,`

- [ ] **Step 4: Type-check**

```bash
npx tsc -b
```

Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
printf '%s\n' "feat(build): units.po_id links a unit to the PO it was claimed under" "" "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" > "$TEMP/msg.txt"
git add ../supabase/migrations/20261013120000_units_po_id.sql src/lib/stock.ts src/modules/Stock/__tests__/UnitTable.test.tsx
git commit -q -F "$TEMP/msg.txt" && git log --oneline -1
```

---

### Task 2: Serial helpers, range planner, PO count helper

**Files:**
- Modify: `app/src/lib/build.ts` (imports; new section after `assignSerial`)
- Create: `app/src/lib/build.claimRange.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/build.claimRange.test.ts`:

```ts
// Claiming a serial range under a batch + PO (Build › "+ Claim serials").
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Op = { op: string; args: unknown[] };

const { fromMock, calls, results, logActionMock } = vi.hoisted(() => {
  const calls: { op: string; args: unknown[] }[][] = [];
  const results: { data?: unknown; error: unknown }[] = [];
  const logActionMock = vi.fn((..._args: unknown[]) => Promise.resolve());
  // Each supabase.from() call takes the next queued result and records every
  // chained method, so a test can assert the exact filters a write used.
  const fromMock = vi.fn((table: string) => {
    const rec: { op: string; args: unknown[] }[] = [{ op: 'from', args: [table] }];
    calls.push(rec);
    const result = results.shift() ?? { data: [], error: null };
    const chain: object = new Proxy({}, {
      get(_t, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'then') {
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(result).then(res, rej);
        }
        return (...args: unknown[]) => { rec.push({ op: prop, args }); return chain; };
      },
    });
    return chain;
  });
  return { fromMock, calls, results, logActionMock };
});

vi.mock('./supabase', () => ({ supabase: { from: fromMock } }));
vi.mock('./activityLog', () => ({ logAction: logActionMock }));

import {
  formatSerial, parseSerialInput, planSerialRange, unitsMadeForPO, MAX_CLAIM_RANGE,
} from './build';

const S = (n: number) => `LL01-${String(n).padStart(11, '0')}`;
const args = (call: Op[], op: string) => call.find(c => c.op === op)?.args;
void args;

beforeEach(() => {
  calls.length = 0;
  results.length = 0;
  fromMock.mockClear();
  logActionMock.mockClear();
});

describe('formatSerial / parseSerialInput', () => {
  it('formats a number as a full serial', () => {
    expect(formatSerial(691)).toBe('LL01-00000000691');
  });

  it('accepts a bare number, a padded number, or a full serial in any case', () => {
    for (const raw of ['691', '00000000691', 'LL01-00000000691', 'll01-00000000691', '  691  ']) {
      expect(parseSerialInput(raw)).toBe(691);
    }
  });

  it('rejects anything that is not a serial', () => {
    for (const raw of ['', '   ', 'abc', 'LL02-00000000691', '123456789012', '0', '69 1', '-5']) {
      expect(parseSerialInput(raw)).toBeNull();
    }
  });
});

describe('planSerialRange', () => {
  const existing = [
    { serial: S(691), batch: 'P300', po_id: null },
    { serial: S(692), batch: 'P100', po_id: null },
    { serial: S(693), batch: 'P300', po_id: 'po1' },
    { serial: S(694), batch: 'P300', po_id: 'po2' },
  ];

  it('sorts every serial into create, link or skip', () => {
    const p = planSerialRange({ from: 691, to: 696, batch: 'P300', poId: 'po1', existing });
    expect(p.serials).toEqual([S(691), S(692), S(693), S(694), S(695), S(696)]);
    expect(p.create).toEqual([S(695), S(696)]);
    expect(p.linkPo).toEqual([S(691)]);
    expect(p.skipped).toEqual([
      { serial: S(692), reason: 'other_batch', detail: 'P100' },
      { serial: S(693), reason: 'same_po' },
      { serial: S(694), reason: 'other_po' },
    ]);
  });

  it('skips a same-batch unit with no PO when no PO was chosen', () => {
    const p = planSerialRange({ from: 691, to: 691, batch: 'P300', poId: null, existing });
    expect(p.linkPo).toEqual([]);
    expect(p.skipped).toEqual([{ serial: S(691), reason: 'exists' }]);
  });

  it('rejects a reversed range', () => {
    expect(() => planSerialRange({ from: 780, to: 691, batch: 'P300', poId: null, existing: [] }))
      .toThrow('The first serial must not come after the last');
  });

  it(`allows ${MAX_CLAIM_RANGE} serials and rejects one more`, () => {
    expect(planSerialRange({ from: 1, to: MAX_CLAIM_RANGE, batch: 'P300', poId: null, existing: [] }).create)
      .toHaveLength(MAX_CLAIM_RANGE);
    expect(() => planSerialRange({ from: 1, to: MAX_CLAIM_RANGE + 1, batch: 'P300', poId: null, existing: [] }))
      .toThrow(`A range can hold at most ${MAX_CLAIM_RANGE} serials`);
  });
});

describe('unitsMadeForPO', () => {
  it('counts units on this PO plus unlinked units in its batch', () => {
    const units = [
      { batch: 'P300', po_id: 'po1' },
      { batch: 'P300', po_id: null },
      { batch: 'P300', po_id: 'po2' },
      { batch: 'P100', po_id: null },
      { batch: 'P100', po_id: 'po1' },
    ];
    expect(unitsMadeForPO({ id: 'po1', batch: 'P300' }, units)).toBe(3);
  });

  it('matches the old batch count while nothing is linked', () => {
    const units = [{ batch: 'P300', po_id: null }, { batch: 'P300', po_id: null }, { batch: 'P100', po_id: null }];
    expect(unitsMadeForPO({ id: 'po1', batch: 'P300' }, units)).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npx vitest run src/lib/build.claimRange.test.ts
```

Expected: FAIL with `TypeError: formatSerial is not a function` (and the same for the other helpers).

- [ ] **Step 3: Implement**

In `app/src/lib/build.ts`, after `import { logAction } from './activityLog';` add:

```ts
import type { Unit } from './stock';
```

Directly after the closing `}` of `assignSerial`, add:

```ts
// ============================================================ Serial ranges

export const SERIAL_PREFIX = 'LL01-';
/** Guard against a typo like 691 → 7800 creating thousands of units. */
export const MAX_CLAIM_RANGE = 500;

/** "LL01-" + the number zero-padded to 11 digits — the only serial shape units use. */
export function formatSerial(n: number): string {
  return SERIAL_PREFIX + String(n).padStart(11, '0');
}

/** The serial number an operator typed, as a positive integer. Accepts "691",
 *  "00000000691" or the full "LL01-00000000691" in any case. Null for anything
 *  else, so a typo never turns into a unit. */
export function parseSerialInput(raw: string): number | null {
  const m = raw.trim().toUpperCase().match(/^(?:LL01-)?(\d{1,11})$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

function assertClaimRange(from: number, to: number): void {
  if (from > to) throw new Error('The first serial must not come after the last');
  if (to - from + 1 > MAX_CLAIM_RANGE) {
    throw new Error(`A range can hold at most ${MAX_CLAIM_RANGE} serials`);
  }
}

export type RangeSkipReason = 'other_batch' | 'same_po' | 'other_po' | 'exists';

export const RANGE_SKIP_LABEL: Record<RangeSkipReason, string> = {
  other_batch: 'already in batch',
  same_po: 'already on this PO',
  other_po: 'already on another PO',
  exists: 'already exists',
};

export type RangePlan = {
  serials: string[];
  create: string[];
  linkPo: string[];
  skipped: { serial: string; reason: RangeSkipReason; detail?: string }[];
};

/** What claiming `from`..`to` into `batch` (and optionally a PO) would do,
 *  given the units that already exist. Existing units are never moved: the
 *  only change ever planned for one is filling a missing PO when its batch
 *  matches. Pure — the dialog previews with it, claimSerialRange commits with it. */
export function planSerialRange(args: {
  from: number;
  to: number;
  batch: string;
  poId: string | null;
  existing: Pick<Unit, 'serial' | 'batch' | 'po_id'>[];
}): RangePlan {
  const { from, to, batch, poId } = args;
  assertClaimRange(from, to);
  const bySerial = new Map(args.existing.map(u => [u.serial, u]));
  const plan: RangePlan = { serials: [], create: [], linkPo: [], skipped: [] };
  for (let n = from; n <= to; n++) {
    const serial = formatSerial(n);
    plan.serials.push(serial);
    const u = bySerial.get(serial);
    if (!u) plan.create.push(serial);
    else if (u.batch !== batch) plan.skipped.push({ serial, reason: 'other_batch', detail: u.batch });
    else if (u.po_id == null) {
      if (poId) plan.linkPo.push(serial);
      else plan.skipped.push({ serial, reason: 'exists' });
    } else if (u.po_id === poId) plan.skipped.push({ serial, reason: 'same_po' });
    else plan.skipped.push({ serial, reason: 'other_po' });
  }
  return plan;
}

/** Units "made" for a PO card: units linked to this PO, plus units with no PO
 *  in the PO's batch. While nothing is linked this is exactly the old
 *  same-batch count; it becomes exact as units carry their PO. */
export function unitsMadeForPO(
  order: Pick<FactoryOrder, 'id' | 'batch'>,
  units: Pick<Unit, 'batch' | 'po_id'>[],
): number {
  return units.filter(u => u.po_id === order.id || (u.po_id == null && u.batch === order.batch)).length;
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npx vitest run src/lib/build.claimRange.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
printf '%s\n' "feat(build): serial parsing, range planner and PO-aware made count" "" "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" > "$TEMP/msg.txt"
git add src/lib/build.ts src/lib/build.claimRange.test.ts
git commit -q -F "$TEMP/msg.txt" && git log --oneline -1
```

---

### Task 3: `claimSerialRange` + `assignSerial` writes the PO

**Files:**
- Modify: `app/src/lib/build.ts` (`assignSerial`; new function after `unitsMadeForPO`)
- Modify: `app/src/lib/build.claimRange.test.ts`

- [ ] **Step 1: Write the failing tests**

In `app/src/lib/build.claimRange.test.ts`:

(a) change the import block to

```ts
import {
  formatSerial, parseSerialInput, planSerialRange, unitsMadeForPO, MAX_CLAIM_RANGE,
  claimSerialRange, assignSerial,
} from './build';
```

(b) delete the line `void args;`

(c) append:

```ts
describe('claimSerialRange', () => {
  const PO = { id: 'po1', po_number: 'PO-1012' };
  const happyPath = () => results.push(
    { data: [{ serial: S(691), batch: 'P300', po_id: null }], error: null },        // read
    { data: [692, 693, 694, 695].map(n => ({ serial: S(n) })), error: null },      // insert
    { data: [{ serial: S(691) }], error: null },                                   // link
  );

  it('reads the range, inserts new units once, and fills the PO on unlinked same-batch units', async () => {
    happyPath();
    const r = await claimSerialRange({ from: 691, to: 695, batch: 'P300', po: PO });

    expect(calls).toHaveLength(3);
    expect(args(calls[0], 'select')).toEqual(['serial, batch, po_id']);
    expect(args(calls[0], 'gte')).toEqual(['serial', S(691)]);
    expect(args(calls[0], 'lte')).toEqual(['serial', S(695)]);

    const [rows, opts] = args(calls[1], 'upsert')!;
    expect(rows).toEqual([692, 693, 694, 695].map(n => ({ serial: S(n), batch: 'P300', status: 'ca-test', po_id: 'po1' })));
    expect(opts).toEqual({ onConflict: 'serial', ignoreDuplicates: true });

    expect(args(calls[2], 'update')).toEqual([{ po_id: 'po1' }]);
    expect(args(calls[2], 'gte')).toEqual(['serial', S(691)]);
    expect(args(calls[2], 'lte')).toEqual(['serial', S(695)]);
    expect(args(calls[2], 'eq')).toEqual(['batch', 'P300']);
    expect(args(calls[2], 'is')).toEqual(['po_id', null]);

    expect(r).toEqual({ created: [S(692), S(693), S(694), S(695)], linked: [S(691)], skipped: [] });
  });

  it('logs every created and linked unit, plus one summary', async () => {
    happyPath();
    await claimSerialRange({ from: 691, to: 695, batch: 'P300', po: PO });
    expect(logActionMock.mock.calls.filter(c => c[0] === 'serial_assigned')).toHaveLength(4);
    expect(logActionMock).toHaveBeenCalledWith('serial_assigned', S(692), 'P300', { entityType: 'unit', unitSerial: S(692) });
    expect(logActionMock).toHaveBeenCalledWith('unit_po_linked', S(691), 'PO-1012', { entityType: 'unit', unitSerial: S(691) });
    expect(logActionMock).toHaveBeenCalledWith('serials_claimed_range', 'PO-1012', `${S(691)}–${S(695)}: 4 created, 1 linked, 0 skipped`);
  });

  it('treats a serial the insert did not return as already existing', async () => {
    results.push({ data: [], error: null }, { data: [{ serial: S(691) }], error: null });
    const r = await claimSerialRange({ from: 691, to: 692, batch: 'P300', po: null });
    expect(r.created).toEqual([S(691)]);
    expect(r.skipped).toEqual([{ serial: S(692), reason: 'exists' }]);
  });

  it('without a PO: rows carry no po_id, nothing is linked, same-batch units are skipped', async () => {
    results.push(
      { data: [{ serial: S(691), batch: 'P300', po_id: null }], error: null },
      { data: [{ serial: S(692) }], error: null },
    );
    const r = await claimSerialRange({ from: 691, to: 692, batch: 'P300', po: null });
    expect(calls).toHaveLength(2);
    expect(args(calls[1], 'upsert')![0]).toEqual([{ serial: S(692), batch: 'P300', status: 'ca-test' }]);
    expect(r).toEqual({ created: [S(692)], linked: [], skipped: [{ serial: S(691), reason: 'exists' }] });
    expect(logActionMock).toHaveBeenCalledWith('serials_claimed_range', 'P300', `${S(691)}–${S(692)}: 1 created, 0 linked, 1 skipped`);
  });

  it('marks a planned link that was taken in the meantime as on another PO', async () => {
    results.push(
      { data: [{ serial: S(691), batch: 'P300', po_id: null }, { serial: S(692), batch: 'P300', po_id: null }], error: null },
      { data: [{ serial: S(691) }], error: null },
    );
    const r = await claimSerialRange({ from: 691, to: 692, batch: 'P300', po: PO });
    expect(calls).toHaveLength(2);
    expect(r.linked).toEqual([S(691)]);
    expect(r.skipped).toEqual([{ serial: S(692), reason: 'other_po' }]);
  });

  it('writes and logs nothing when every serial is already taken', async () => {
    results.push({ data: [{ serial: S(691), batch: 'P100', po_id: null }], error: null });
    const r = await claimSerialRange({ from: 691, to: 691, batch: 'P300', po: PO });
    expect(calls).toHaveLength(1);
    expect(r).toEqual({ created: [], linked: [], skipped: [{ serial: S(691), reason: 'other_batch', detail: 'P100' }] });
    expect(logActionMock).not.toHaveBeenCalled();
  });

  it('rejects a reversed range before touching the database', async () => {
    await expect(claimSerialRange({ from: 700, to: 691, batch: 'P300', po: null }))
      .rejects.toThrow('The first serial must not come after the last');
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('throws when the insert fails, and logs nothing', async () => {
    results.push({ data: [], error: null }, { data: null, error: { message: 'insert blew up' } });
    await expect(claimSerialRange({ from: 691, to: 691, batch: 'P300', po: null }))
      .rejects.toMatchObject({ message: 'insert blew up' });
    expect(logActionMock).not.toHaveBeenCalled();
  });
});

describe('assignSerial', () => {
  it('writes the PO when one is given', async () => {
    results.push({ error: null });
    await assignSerial({ serial: S(701), batch: 'P300', po_id: 'po1' });
    expect(args(calls[0], 'insert')).toEqual([{ serial: S(701), batch: 'P300', status: 'ca-test', po_id: 'po1' }]);
  });

  it('leaves po_id off the row without a PO', async () => {
    results.push({ error: null });
    await assignSerial({ serial: S(701), batch: 'P300' });
    expect(args(calls[0], 'insert')).toEqual([{ serial: S(701), batch: 'P300', status: 'ca-test' }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npx vitest run src/lib/build.claimRange.test.ts
```

Expected: FAIL. `claimSerialRange is not a function` in its block; the "writes the PO" `assignSerial` case fails because `po_id` is missing from the insert.

- [ ] **Step 3: Implement**

In `app/src/lib/build.ts`, replace the body of `assignSerial`'s insert so the function reads:

```ts
export async function assignSerial(input: {
  serial: string; batch: string; po_id?: string;
}): Promise<void> {
  // Create unit at IQC station. Trigger units_create_lifecycle_on_ship doesn't
  // fire because we start at 'ca-test', not 'shipped'.
  const { error } = await supabase.from('units').insert({
    serial: input.serial,
    batch: input.batch,
    status: 'ca-test',
    ...(input.po_id ? { po_id: input.po_id } : {}),
  });
  if (error) throw error;
  await logAction('serial_assigned', input.serial, input.batch,
    { entityType: 'unit', unitSerial: input.serial });
}
```

After `unitsMadeForPO`, add:

```ts
export type RangeClaimResult = {
  created: string[];
  linked: string[];
  skipped: RangePlan['skipped'];
};

/** Claim every serial from `from` to `to` into `batch`, optionally under a PO.
 *  The database decides, not the dialog's preview: the range is re-read here
 *  and re-planned. New serials go in with one insert that ignores any serial
 *  created in the meantime (insert-only on conflict); existing same-batch units
 *  with no PO get this PO with one update. Nothing existing is moved.
 *
 *  Both writes filter on the serial range rather than an in() list — serials
 *  are fixed-width, so the text range is exact and 500 serials never end up in
 *  a request URL. */
export async function claimSerialRange(args: {
  from: number;
  to: number;
  batch: string;
  po: { id: string; po_number: string } | null;
}): Promise<RangeClaimResult> {
  const { from, to, batch, po } = args;
  assertClaimRange(from, to);
  const first = formatSerial(from);
  const last = formatSerial(to);

  const { data: existing, error: readErr } = await supabase
    .from('units')
    .select('serial, batch, po_id')
    .gte('serial', first)
    .lte('serial', last);
  if (readErr) throw readErr;

  const plan = planSerialRange({
    from, to, batch, poId: po?.id ?? null,
    existing: (existing ?? []) as Pick<Unit, 'serial' | 'batch' | 'po_id'>[],
  });
  const skipped = [...plan.skipped];

  let created: string[] = [];
  if (plan.create.length > 0) {
    const rows = plan.create.map(serial => ({
      serial, batch, status: 'ca-test', ...(po ? { po_id: po.id } : {}),
    }));
    const { data, error } = await supabase
      .from('units')
      .upsert(rows, { onConflict: 'serial', ignoreDuplicates: true })
      .select('serial');
    if (error) throw error;
    const got = new Set((data ?? []).map(r => (r as { serial: string }).serial));
    created = plan.create.filter(s => got.has(s));
    for (const s of plan.create) if (!got.has(s)) skipped.push({ serial: s, reason: 'exists' });
  }

  let linked: string[] = [];
  if (po && plan.linkPo.length > 0) {
    const { data, error } = await supabase
      .from('units')
      .update({ po_id: po.id })
      .gte('serial', first)
      .lte('serial', last)
      .eq('batch', batch)
      .is('po_id', null)
      .select('serial');
    if (error) throw error;
    linked = (data ?? []).map(r => (r as { serial: string }).serial).sort();
    const got = new Set(linked);
    for (const s of plan.linkPo) if (!got.has(s)) skipped.push({ serial: s, reason: 'other_po' });
  }

  skipped.sort((a, b) => a.serial.localeCompare(b.serial));

  await Promise.all([
    ...created.map(s => logAction('serial_assigned', s, batch, { entityType: 'unit', unitSerial: s })),
    ...linked.map(s => logAction('unit_po_linked', s, po!.po_number, { entityType: 'unit', unitSerial: s })),
  ]);
  if (created.length + linked.length > 0) {
    await logAction('serials_claimed_range', po?.po_number ?? batch,
      `${first}–${last}: ${created.length} created, ${linked.length} linked, ${skipped.length} skipped`);
  }
  return { created, linked, skipped };
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npx vitest run src/lib/build.claimRange.test.ts
```

Expected: PASS, 19 tests.

- [ ] **Step 5: Type-check and commit**

```bash
npx tsc -b
printf '%s\n' "feat(build): claimSerialRange creates a serial range under a batch + PO" "" "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" > "$TEMP/msg.txt"
git add src/lib/build.ts src/lib/build.claimRange.test.ts
git commit -q -F "$TEMP/msg.txt" && git log --oneline -1
```

Expected: tsc prints nothing.

---

### Task 4: PO card counts units linked to the PO

**Files:**
- Modify: `app/src/modules/Build/PipelineBoard.tsx:2` (import) and `:101` (count)

- [ ] **Step 1: Use the helper**

Change line 2 from
`import type { FactoryOrder, FreightShipment, BuildDefect, BurnInTest } from '../../lib/build';`
to

```ts
import { unitsMadeForPO, type FactoryOrder, type FreightShipment, type BuildDefect, type BurnInTest } from '../../lib/build';
```

Change
`              unitsMadeCount={units.filter(u => u.batch === o.batch).length}`
to

```tsx
              unitsMadeCount={unitsMadeForPO(o, units)}
```

(`unitsMadeForPO` itself is covered by Task 2's tests.)

- [ ] **Step 2: Type-check and commit**

```bash
npx tsc -b
printf '%s\n' "feat(build): PO card counts units linked to that PO" "" "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" > "$TEMP/msg.txt"
git add src/modules/Build/PipelineBoard.tsx
git commit -q -F "$TEMP/msg.txt" && git log --oneline -1
```

---

### Task 5: `ClaimSerialsModal`

**Files:**
- Create: `app/src/modules/Build/ClaimSerialsModal.tsx`
- Modify: `app/src/modules/Build/Build.module.css` (append)
- Create: `app/src/modules/Build/__tests__/ClaimSerialsModal.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/src/modules/Build/__tests__/ClaimSerialsModal.test.tsx`:

```tsx
// Build › "+ Claim serials": one serial or a whole range, under a batch and
// optionally a PO. The preview is planned against the units already loaded.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { FactoryOrder, RangeClaimResult } from '../../../lib/build';

const claimSerialRange = vi.fn(async (..._args: unknown[]): Promise<RangeClaimResult> =>
  ({ created: [], linked: [], skipped: [] }));
const assignSerial = vi.fn(async (..._args: unknown[]) => {});
vi.mock('../../../lib/build', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/build')>(),
  claimSerialRange: (...a: unknown[]) => claimSerialRange(...a),
  assignSerial: (...a: unknown[]) => assignSerial(...a),
}));

import { ClaimSerialsModal } from '../ClaimSerialsModal';

const S = (n: number) => `LL01-${String(n).padStart(11, '0')}`;
const order = (over: Partial<FactoryOrder> = {}): FactoryOrder => ({
  id: 'po1', po_number: 'PO-1012', batch: 'P300', qty_ordered: 90, unit_cost_usd: null,
  manufacturer: 'LC', ship_target_date: null, status: 'placed', notes: null,
  placed_at: '2026-10-01T00:00:00Z', placed_by: null,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  ...over,
});
const batches = [{ id: 'P100' }, { id: 'P300' }];
const loadedUnits = [
  { serial: S(691), batch: 'P300', po_id: null },
  { serial: S(692), batch: 'P100', po_id: null },
];

function open(orders: FactoryOrder[] = [order()]) {
  const onClose = vi.fn();
  render(<ClaimSerialsModal batches={batches} orders={orders} units={loadedUnits} onClose={onClose} />);
  return { onClose };
}
const pickPo = (id: string) =>
  fireEvent.change(screen.getByLabelText('Purchase order'), { target: { value: id } });
const range = (a: string, b: string) => {
  fireEvent.change(screen.getByLabelText('First serial'), { target: { value: a } });
  fireEvent.change(screen.getByLabelText('Last serial'), { target: { value: b } });
};

describe('ClaimSerialsModal', () => {
  beforeEach(() => { claimSerialRange.mockClear(); assignSerial.mockClear(); });

  it("picking a PO locks the batch to the PO's batch", () => {
    open();
    const batch = screen.getByLabelText('Batch') as HTMLSelectElement;
    expect(batch.value).toBe('P100');
    expect(batch).not.toBeDisabled();
    pickPo('po1');
    expect(batch.value).toBe('P300');
    expect(batch).toBeDisabled();
  });

  it('does not offer cancelled POs', () => {
    open([order(), order({ id: 'po2', po_number: 'PO-0999', status: 'cancelled' })]);
    const options = Array.from((screen.getByLabelText('Purchase order') as HTMLSelectElement).options).map(o => o.text);
    expect(options).toEqual(['No PO', 'PO-1012 · P300']);
  });

  it('previews the range against loaded units', () => {
    open();
    pickPo('po1');
    range('691', '700');
    expect(screen.getByText('8 new · 1 to link · 1 skipped')).toBeInTheDocument();
    expect(screen.getByText('PO PO-1012: 9 of 90 ordered after this')).toBeInTheDocument();
    expect(screen.queryByText(/more than PO/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Create 8 units' })).toBeEnabled();
  });

  it('warns, without blocking, when the PO would go over its ordered quantity', () => {
    open([order({ qty_ordered: 5 })]);
    pickPo('po1');
    range('691', '700');
    expect(screen.getByText('That is more than PO PO-1012 ordered.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create 8 units' })).toBeEnabled();
  });

  it('blocks a reversed range', () => {
    open();
    range('700', '691');
    expect(screen.getByText('The first serial must not come after the last')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create units' })).toBeDisabled();
  });

  it('blocks text that is not a serial', () => {
    open();
    range('69a', '700');
    expect(screen.getByText('Enter a serial like 691 or LL01-00000000691')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create units' })).toBeDisabled();
  });

  it('blocks a PO whose batch has no batch record', () => {
    open([order({ batch: 'P200' })]);
    pickPo('po1');
    range('691', '700');
    expect(screen.getByText('Batch P200 has no batch record yet. Add it on the LILA Units tab first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create units' })).toBeDisabled();
  });

  it('submits the range with the PO and shows what happened', async () => {
    claimSerialRange.mockResolvedValueOnce({
      created: [693, 694, 695, 696, 697, 698, 699, 700].map(S),
      linked: [S(691)],
      skipped: [{ serial: S(692), reason: 'other_batch', detail: 'P100' }],
    });
    open();
    pickPo('po1');
    range('691', '700');
    fireEvent.click(screen.getByRole('button', { name: 'Create 8 units' }));
    await waitFor(() => expect(claimSerialRange).toHaveBeenCalledWith({
      from: 691, to: 700, batch: 'P300', po: { id: 'po1', po_number: 'PO-1012' },
    }));
    expect(await screen.findByText(/linked to PO/)).toHaveTextContent('8 created · 1 linked to PO · 1 skipped');
    expect(screen.getByText(`${S(692)}: already in batch P100`)).toBeInTheDocument();
  });

  it('single mode creates one unit under the PO', async () => {
    const { onClose } = open();
    pickPo('po1');
    fireEvent.click(screen.getByRole('button', { name: 'One serial' }));
    fireEvent.change(screen.getByLabelText('Serial'), { target: { value: '701' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create unit' }));
    await waitFor(() => expect(assignSerial).toHaveBeenCalledWith({ serial: S(701), batch: 'P300', po_id: 'po1' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npx vitest run src/modules/Build/__tests__/ClaimSerialsModal.test.tsx
```

Expected: FAIL — cannot resolve `../ClaimSerialsModal`.

- [ ] **Step 3: Implement the component**

Create `app/src/modules/Build/ClaimSerialsModal.tsx`:

```tsx
import { useMemo, useState } from 'react';
import {
  assignSerial, claimSerialRange, formatSerial, parseSerialInput, planSerialRange,
  RANGE_SKIP_LABEL,
  type FactoryOrder, type RangeClaimResult, type RangePlan,
} from '../../lib/build';
import type { Batch, Unit } from '../../lib/stock';
import styles from './Build.module.css';

type Mode = 'range' | 'single';

type Props = {
  batches: Pick<Batch, 'id'>[];
  orders: FactoryOrder[];
  units: Pick<Unit, 'serial' | 'batch' | 'po_id'>[];
  onClose: () => void;
};

type FormState = {
  error: string | null;
  plan: RangePlan | null;
  from: number | null;
  to: number | null;
  one: number | null;
};

const BAD_SERIAL = 'Enter a serial like 691 or LL01-00000000691';
const unitsLabel = (n: number) => `${n} unit${n === 1 ? '' : 's'}`;

/** Claim one serial, or a whole range, into a batch and optionally a PO.
 *  Picking a PO fixes the batch to the PO's batch, so a unit can never land in
 *  a batch its PO does not belong to. The range preview is planned against the
 *  units already loaded; claimSerialRange re-reads the database before writing. */
export function ClaimSerialsModal({ batches, orders, units, onClose }: Props) {
  const openOrders = useMemo(() => orders.filter(o => o.status !== 'cancelled'), [orders]);
  const [poId, setPoId] = useState('');
  const [batchPick, setBatchPick] = useState(
    () => batches.find(b => b.id === 'P100')?.id ?? batches[0]?.id ?? '',
  );
  const [mode, setMode] = useState<Mode>('range');
  const [single, setSingle] = useState('');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [result, setResult] = useState<RangeClaimResult | null>(null);

  const po = openOrders.find(o => o.id === poId) ?? null;
  const batch = po ? po.batch : batchPick;
  const poBatchMissing = po != null && !batches.some(b => b.id === po.batch);

  // Everything derived from the form: the parsed input, the plan, and the one
  // error (if any) that blocks the create button.
  const form = useMemo((): FormState => {
    const blank: FormState = { error: null, plan: null, from: null, to: null, one: null };
    if (poBatchMissing) {
      return { ...blank, error: `Batch ${po!.batch} has no batch record yet. Add it on the LILA Units tab first.` };
    }
    if (!batch) return { ...blank, error: 'Pick a batch' };
    if (mode === 'single') {
      const one = parseSerialInput(single);
      return { ...blank, one, error: single.trim() && one == null ? BAD_SERIAL : null };
    }
    const from = parseSerialInput(first);
    const to = parseSerialInput(last);
    if ((first.trim() && from == null) || (last.trim() && to == null)) return { ...blank, error: BAD_SERIAL };
    if (from == null || to == null) return blank;
    try {
      return { ...blank, from, to, plan: planSerialRange({ from, to, batch, poId: po?.id ?? null, existing: units }) };
    } catch (e) {
      return { ...blank, error: (e as Error).message };
    }
  }, [poBatchMissing, po, batch, mode, single, first, last, units]);

  const plan = form.plan;
  const onPo = po ? units.filter(u => u.po_id === po.id).length : 0;
  const afterPo = po && plan ? onPo + plan.create.length + plan.linkPo.length : null;
  const canSubmit = !busy && !form.error && (
    mode === 'single' ? form.one != null : plan != null && plan.create.length + plan.linkPo.length > 0
  );
  const submitLabel = busy ? 'Saving…'
    : mode === 'single' ? 'Create unit'
    : plan && plan.create.length > 0 ? `Create ${unitsLabel(plan.create.length)}`
    : plan && plan.linkPo.length > 0 ? `Link ${unitsLabel(plan.linkPo.length)}`
    : 'Create units';

  async function submit() {
    if (!canSubmit) return;
    setBusy(true); setSaveError(null);
    try {
      if (mode === 'single') {
        await assignSerial({ serial: formatSerial(form.one!), batch, ...(po ? { po_id: po.id } : {}) });
        onClose();
      } else {
        setResult(await claimSerialRange({
          from: form.from!, to: form.to!, batch,
          po: po ? { id: po.id, po_number: po.po_number } : null,
        }));
      }
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={e => e.stopPropagation()} role="dialog" aria-label="Claim serials">
        <h3 className={styles.modalTitle}>Claim serials</h3>
        {result ? (
          <div className={styles.claimResult}>
            <div><strong>{result.created.length}</strong> created · <strong>{result.linked.length}</strong> linked to PO · <strong>{result.skipped.length}</strong> skipped</div>
            {result.skipped.length > 0 && (
              <ul className={styles.claimSkipped}>
                {result.skipped.map(s => (
                  <li key={s.serial}>{s.serial}: {RANGE_SKIP_LABEL[s.reason]}{s.detail ? ` ${s.detail}` : ''}</li>
                ))}
              </ul>
            )}
            <div className={styles.actionsRow}>
              <button className={styles.btnPrimary} onClick={onClose}>Close</button>
            </div>
          </div>
        ) : (
          <>
            <div className={styles.modalField}>
              <label className={styles.modalLabel} htmlFor="claim-po">Purchase order</label>
              <select id="claim-po" className={styles.input} value={poId} onChange={e => setPoId(e.target.value)}>
                <option value="">No PO</option>
                {openOrders.map(o => (
                  <option key={o.id} value={o.id}>{o.po_number} · {o.batch}</option>
                ))}
              </select>
            </div>
            <div className={styles.modalField}>
              <label className={styles.modalLabel} htmlFor="claim-batch">Batch</label>
              <select
                id="claim-batch"
                className={styles.input}
                value={batch}
                disabled={po != null}
                onChange={e => setBatchPick(e.target.value)}
              >
                {batches.map(b => <option key={b.id} value={b.id}>{b.id}</option>)}
                {poBatchMissing && <option value={po!.batch}>{po!.batch}</option>}
              </select>
            </div>
            <div className={styles.modeToggle} role="group" aria-label="Claim mode">
              <button
                type="button"
                className={`${styles.chip} ${mode === 'range' ? styles.chipActive : ''}`}
                aria-pressed={mode === 'range'}
                onClick={() => setMode('range')}
              >Range</button>
              <button
                type="button"
                className={`${styles.chip} ${mode === 'single' ? styles.chipActive : ''}`}
                aria-pressed={mode === 'single'}
                onClick={() => setMode('single')}
              >One serial</button>
            </div>
            {mode === 'single' ? (
              <div className={styles.modalField}>
                <label className={styles.modalLabel} htmlFor="claim-single">Serial</label>
                <input
                  id="claim-single"
                  className={styles.input}
                  placeholder="LL01-00000000XYZ"
                  value={single}
                  onChange={e => setSingle(e.target.value.toUpperCase())}
                />
              </div>
            ) : (
              <div className={styles.rangeRow}>
                <div className={styles.modalField}>
                  <label className={styles.modalLabel} htmlFor="claim-first">First serial</label>
                  <input id="claim-first" className={styles.input} placeholder="691"
                    value={first} onChange={e => setFirst(e.target.value)} />
                </div>
                <div className={styles.modalField}>
                  <label className={styles.modalLabel} htmlFor="claim-last">Last serial</label>
                  <input id="claim-last" className={styles.input} placeholder="780"
                    value={last} onChange={e => setLast(e.target.value)} />
                </div>
              </div>
            )}
            {plan && (
              <div className={styles.claimPreview}>
                <div>{plan.create.length} new · {plan.linkPo.length} to link · {plan.skipped.length} skipped</div>
                {po && afterPo != null && (
                  <div>PO {po.po_number}: {afterPo} of {po.qty_ordered} ordered after this</div>
                )}
                {po && afterPo != null && afterPo > po.qty_ordered && (
                  <div className={styles.claimWarn}>That is more than PO {po.po_number} ordered.</div>
                )}
              </div>
            )}
            {(form.error || saveError) && <div className={styles.claimError}>{form.error ?? saveError}</div>}
            <div className={styles.actionsRow}>
              <button className={styles.btnPrimary} disabled={!canSubmit} onClick={() => void submit()}>
                {submitLabel}
              </button>
              <button className={styles.btnSecondary} disabled={busy} onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

Append to `app/src/modules/Build/Build.module.css`:

```css
/* ── Claim serials dialog ─────────────────────────────────────────────── */
.modalBackdrop {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0, 0, 0, 0.4);
  display: flex; align-items: center; justify-content: center;
}
.modalCard {
  background: #fff; border-radius: var(--radius-md);
  padding: 20px; width: 400px; max-width: calc(100vw - 32px);
  box-shadow: var(--shadow-lg);
}
.modalTitle { margin: 0 0 12px; font-size: 16px; }
.modalField { margin-bottom: 10px; flex: 1; }
.modalLabel { display: block; font-size: 12px; margin-bottom: 4px; color: var(--color-ink-muted); }
.modeToggle { display: flex; gap: 6px; margin-bottom: 10px; }
.rangeRow { display: flex; gap: 10px; }
.claimPreview { font-size: 12px; color: var(--color-ink-muted); margin-bottom: 6px; }
.claimWarn { color: var(--color-warning); font-weight: 600; }
.claimError { color: var(--color-error); font-size: 11px; margin-top: 6px; }
.claimResult { font-size: 12px; color: var(--color-ink); }
.claimSkipped {
  margin: 8px 0 0; padding-left: 16px;
  max-height: 180px; overflow-y: auto;
  color: var(--color-ink-muted);
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npx vitest run src/modules/Build/__tests__/ClaimSerialsModal.test.tsx
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Type-check and commit**

```bash
npx tsc -b
printf '%s\n' "feat(build): Claim serials dialog with a range mode, PO picker and preview" "" "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" > "$TEMP/msg.txt"
git add src/modules/Build/ClaimSerialsModal.tsx src/modules/Build/Build.module.css src/modules/Build/__tests__/ClaimSerialsModal.test.tsx
git commit -q -F "$TEMP/msg.txt" && git log --oneline -1
```

---

### Task 6: Wire the dialog into Build

**Files:**
- Modify: `app/src/modules/Build/index.tsx` (imports; claim state at ~68-91; header button ~221; modal JSX ~256-285)
- Modify: `app/src/modules/Build/__tests__/batchSource.test.tsx`

- [ ] **Step 1: Update the existing test first**

In `app/src/modules/Build/__tests__/batchSource.test.tsx`:

(a) replace the `vi.mock('../../../lib/build', ...)` block with

```ts
vi.mock('../../../lib/build', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../lib/build')>(),
  useFactoryOrders: () => ({ orders: [], loading: false }),
  useFreightShipments: () => ({ shipments: [], loading: false }),
  useBuildDefects: () => ({ defects: [], loading: false }),
  useBurnInTests: () => ({ tests: [], loading: false }),
  assignSerial: vi.fn().mockResolvedValue(undefined),
  claimSerialRange: vi.fn(),
}));
```

(b) replace `openClaim` with

```ts
function openClaim() {
  render(<Build />);
  fireEvent.click(screen.getByRole('button', { name: '+ Claim serials' }));
  return screen.getByLabelText('Batch');
}
```

(c) in "claims against the selected batch", directly after the `fireEvent.change(select, ...)` line add

```ts
    fireEvent.click(screen.getByRole('button', { name: 'One serial' }));
```

- [ ] **Step 2: Run to verify it fails**

```bash
VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npx vitest run src/modules/Build/__tests__/batchSource.test.tsx
```

Expected: FAIL — no button named "+ Claim serials".

- [ ] **Step 3: Swap the inline modal for `ClaimSerialsModal`**

In `app/src/modules/Build/index.tsx`:

(a) imports — remove `assignSerial,` from the `../../lib/build` import so it reads

```ts
import {
  useFactoryOrders, useFreightShipments, useBuildDefects, useBurnInTests,
} from '../../lib/build';
```

and after `import { NewPOModal } from './NewPOModal';` add

```ts
import { ClaimSerialsModal } from './ClaimSerialsModal';
```

(b) replace the whole claim-state block — from
`  const [showClaimSerial, setShowClaimSerial] = useState<{ batch: string } | null>(null);`
through the closing `  }` of `async function submitClaim()` — with

```ts
  // The dialog lists batches from the `batches` table (same source as Stock >
  // LILA Units); units.batch is an FK to it, so a hardcoded list would drift.
  const [showClaim, setShowClaim] = useState(false);
```

(c) header button:

```tsx
          <button className={styles.btnSecondary} onClick={() => setShowClaim(true)}>+ Claim serials</button>
```

(d) replace the whole `{showClaimSerial && ( ... )}` JSX block (the inline fixed-position modal) with

```tsx
    {showClaim && (
      <ClaimSerialsModal
        batches={batches}
        orders={orders}
        units={units}
        onClose={() => setShowClaim(false)}
      />
    )}
```

- [ ] **Step 4: Run Build's tests**

```bash
VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npx vitest run src/modules/Build
```

Expected: PASS — `batchSource.test.tsx` (3) and `ClaimSerialsModal.test.tsx` (9).

- [ ] **Step 5: Type-check, build, commit**

```bash
npx tsc -b
VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npm run build
printf '%s\n' "feat(build): + Claim serials opens the range dialog" "" "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" > "$TEMP/msg.txt"
git add src/modules/Build/index.tsx src/modules/Build/__tests__/batchSource.test.tsx
git commit -q -F "$TEMP/msg.txt" && git log --oneline -1
```

Expected: tsc prints nothing; build ends with `✓ built in …`.

---

### Task 7: Full verification + spec status

- [ ] **Step 1: Whole suite**

```bash
VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npx vitest run
```

Expected: everything passes except the 2 known CRLF-only failures in `shipmentEmailTemplate.test.ts`.

- [ ] **Step 2: Lint the touched files**

```bash
npx eslint src/lib/build.ts src/lib/build.claimRange.test.ts src/modules/Build
```

Expected: 0 errors.

- [ ] **Step 3: Mark the spec built and commit**

In `docs/superpowers/specs/2026-10-13-claim-serial-range-design.md` change
`**Status:** designed, not built.` to
`**Status:** built on branch feat/claim-serial-range; migration not yet applied.`

```bash
printf '%s\n' "docs(build): mark claim-serial-range spec as built" "" "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" > "$TEMP/msg.txt"
git add ../docs/superpowers/specs/2026-10-13-claim-serial-range-design.md ../docs/superpowers/plans/2026-10-13-claim-serial-range.md
git commit -q -F "$TEMP/msg.txt" && git log --oneline -9
```

- [ ] **Step 4: Left for the repo owner**

1. Apply `20261013120000_units_po_id.sql` (and the earlier `20261008120000_units_mac_address.sql`) before this code is live; until then the Build page's unit insert with `po_id` fails.
2. Pull origin into local main, then push.
