# Fulfillment → Auto-Verification Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Units shipped through the fulfillment wizard land in `customers.serials[]` immediately (so Lovely app buyers auto-verify), and the `/lovely` Verification tab diagnoses why each pending user didn't auto-verify, with a one-click "Add serial + verify" fix.

**Architecture:** One ops-DB migration (new `customer_serial_overrides` table, 3-source redefinition of `sync_customer_serials_from_fulfillment()`, a step-6 append trigger, and an `add_customer_serial` RPC), plus a new `lovelyVerification` lib module and Verification tab UI. Spec: `docs/superpowers/specs/2026-07-03-fulfillment-auto-verification-loop-design.md`.

**Tech Stack:** Postgres/Supabase migration SQL, React 19 + TypeScript, CSS Modules, Vitest + Testing Library.

## Global Constraints

- **NEVER run `git add` / `git commit` / `git push`.** Ryan commits manually. Where a normal plan would commit, run the test suite instead and stop.
- Repo root: `c:\Users\ryany\OneDrive\Desktop\Projects\makelila`. App code in `app/`, backend in `supabase/`.
- All Supabase queries go through `app/src/lib/` — components never import `supabase` directly.
- CSS Modules only, no inline styles.
- Match the Lovely app's matching semantics exactly: email `trim().toLowerCase()` exact match; serial `trim().toUpperCase()` compared element-wise against `serials[]` (each element also trimmed/uppercased).
- The migration cannot be executed locally (no local Supabase stack); it ships via the gated `workflow_dispatch` CI path. Its in-plan verification is careful review, not execution.
- Test commands run from `app/`: `npx vitest run <file>` for one file, `npm run test:run` for the suite, `npm run lint` for ESLint.

---

### Task 1: Migration — overrides table, 3-source sync, step-6 trigger, add_customer_serial RPC

**Files:**
- Create: `supabase/migrations/20260703090000_fulfillment_auto_verification_loop.sql`

**Interfaces:**
- Consumes: existing `public.customers (id, email, full_name, serials text[], serials_synced_at)`, `public.fulfillment_queue (step, assigned_serial, order_id)`, `public.orders (id, customer_id)`, `public.fulfillment_log`, `public.units`, `public.profiles (id, display_name)`, `public.is_internal_user()`.
- Produces: table `public.customer_serial_overrides`; RPC `public.add_customer_serial(p_customer_id uuid, p_serial text, p_reason text default null) returns text[]` (callable from the client as `supabase.rpc('add_customer_serial', { p_customer_id, p_serial, p_reason })`); trigger `fq_append_customer_serial` on `public.fulfillment_queue`; redefined `public.sync_customer_serials_from_fulfillment()` returning the same jsonb report shape plus `wizard_serials` and `override_serials` counts.

- [ ] **Step 1: Write the migration file**

The sync redefinition below is the CURRENT definition from
`supabase/migrations/20260605090000_sync_serials_writeback_units.sql` with one
change: `customers.serials` is rebuilt from the union of three sources instead
of the sheet alone. The `_serial_resolved` CTE and the units write-back are
byte-for-byte the same logic; do not "improve" them.

```sql
-- Fulfillment → auto-verification loop.
-- Spec: docs/superpowers/specs/2026-07-03-fulfillment-auto-verification-loop-design.md
--
-- The Lovely app auto-verifies a signup when email + serial match
-- customers.serials[]. Until now that column was populated ONLY from the
-- fulfillment sheet (fulfillment_log), so wizard-shipped units never made
-- their buyers auto-verifiable. This migration makes customers.serials the
-- union of three sources and keeps it fresh in real time:
--   1. sheet-derived   (fulfillment_log, unchanged resolution logic)
--   2. wizard-derived  (fulfillment_queue step 6 → orders.customer_id)
--   3. operator adds   (customer_serial_overrides, new — Verification tab fix)
-- Clear + repopulate semantics are preserved: a serial removed from the sheet
-- disappears on re-sync unless the wizard or an override still claims it.

-- ── 1. Operator overrides: durable, audited manual serial additions ─────────
create table if not exists public.customer_serial_overrides (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.customers(id) on delete cascade,
  serial        text not null,
  added_by      uuid,            -- auth.uid() of the operator
  added_by_name text,
  reason        text,
  created_at    timestamptz not null default now(),
  unique (customer_id, serial)
);

comment on table public.customer_serial_overrides is
  'Operator-added serial→customer links (Verification tab fix). Insert-only; merged into customers.serials by sync_customer_serials_from_fulfillment() and add_customer_serial().';

alter table public.customer_serial_overrides enable row level security;

drop policy if exists "customer_serial_overrides_read" on public.customer_serial_overrides;
create policy "customer_serial_overrides_read" on public.customer_serial_overrides
  for select to authenticated using (public.is_internal_user());

drop policy if exists "customer_serial_overrides_insert" on public.customer_serial_overrides;
create policy "customer_serial_overrides_insert" on public.customer_serial_overrides
  for insert to authenticated with check (public.is_internal_user());

-- ── 2. Sync RPC: 3-source union ──────────────────────────────────────────────
create or replace function public.sync_customer_serials_from_fulfillment()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int := 0;
  v_units_updated int := 0;
  v_wizard int := 0;
  v_overrides int := 0;
  v_unmatched jsonb;
begin
  -- Resolve every distinct sheet serial to a customer id (or null = unmatched).
  drop table if exists _serial_resolved;
  create temp table _serial_resolved as
    with src as (
      -- Only real unit serials (LL01-NNNN). Normalizes trailing junk like
      -- 'LL01-00000000307 (?)' and ignores non-serials ('Posters', notes, etc).
      select
        substring(serial_number from 'LL01-[0-9]+')  as serial,
        lower(nullif(trim(email), ''))               as email_key,
        lower(nullif(trim(customer_name), ''))       as name_key,
        nullif(trim(customer_name), '')              as name_display
      from public.fulfillment_log
      where serial_number ~ 'LL01-[0-9]+'
    ),
    -- Collapse to ONE row per serial. Prefer a sheet row that carries an
    -- email, then one that carries a name, so resolution is deterministic
    -- and the units write-back updates each serial exactly once.
    dedup as (
      select distinct on (serial)
        serial, email_key, name_key, name_display
      from src
      order by serial, (email_key is null), (name_key is null)
    )
    select
      d.serial,
      d.email_key,
      d.name_key,
      d.name_display,
      coalesce(
        (select c.id from public.customers c
           where d.email_key is not null and lower(c.email) = d.email_key
           order by c.created_at limit 1),
        (select c.id from public.customers c
           where d.name_key is not null and lower(c.full_name) = d.name_key
           order by c.created_at limit 1)
      ) as customer_id
    from dedup d;

  -- ── customers.serials[]: union of sheet + wizard + overrides ──────────────
  drop table if exists _all_serials;
  create temp table _all_serials as
    select customer_id, serial
      from _serial_resolved
     where customer_id is not null
    union
    select o.customer_id, q.assigned_serial
      from public.fulfillment_queue q
      join public.orders o on o.id = q.order_id
     where q.step = 6
       and q.assigned_serial is not null
       and o.customer_id is not null
    union
    select customer_id, serial
      from public.customer_serial_overrides;

  select count(*) into v_wizard
    from public.fulfillment_queue q
    join public.orders o on o.id = q.order_id
   where q.step = 6 and q.assigned_serial is not null and o.customer_id is not null;
  select count(*) into v_overrides from public.customer_serial_overrides;

  update public.customers set serials = null where serials is not null;

  with dedup as (
    -- Case-insensitive de-dup per customer; keep one stored casing.
    select distinct on (customer_id, upper(trim(serial)))
      customer_id, trim(serial) as serial
    from _all_serials
    order by customer_id, upper(trim(serial)), serial
  ),
  agg as (
    select customer_id, array_agg(serial order by serial) as serials
    from dedup
    group by customer_id
  )
  update public.customers c
    set serials = a.serials, serials_synced_at = now()
    from agg a
    where a.customer_id = c.id;
  get diagnostics v_updated = row_count;

  -- ── units write-back (unchanged) — fills NULLs only, never clobbers ───────
  update public.units u
    set
      customer_id   = coalesce(u.customer_id, r.customer_id),
      customer_name = coalesce(u.customer_name, cust.full_name, r.name_display)
    from _serial_resolved r
    left join public.customers cust on cust.id = r.customer_id
    where u.serial = r.serial
      and u.is_team_test = false
      and (
        (u.customer_id   is null and r.customer_id is not null)
        or
        (u.customer_name is null and coalesce(cust.full_name, r.name_display) is not null)
      );
  get diagnostics v_units_updated = row_count;

  select coalesce(jsonb_agg(jsonb_build_object(
           'serial', serial, 'email', email_key, 'name', name_key)), '[]'::jsonb)
    into v_unmatched
    from _serial_resolved
    where customer_id is null;

  drop table if exists _serial_resolved;
  drop table if exists _all_serials;

  return jsonb_build_object(
    'customers_updated', v_updated,
    'units_updated', v_units_updated,
    'wizard_serials', v_wizard,
    'override_serials', v_overrides,
    'unmatched_count', jsonb_array_length(v_unmatched),
    'unmatched', v_unmatched
  );
end;
$$;

-- ── 3. Real-time append when a queue row reaches step 6 ─────────────────────
-- Mirrors fq_sync_unit's transition guard. The body is wrapped so a serials
-- failure can NEVER abort the step-6 update — shipping must not break
-- because of this feature (worst case the serial arrives at the next sync).
create or replace function public.append_customer_serial_on_fulfillment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id uuid;
begin
  if new.assigned_serial is null then return new; end if;
  if new.step <> 6 then return new; end if;
  if tg_op = 'UPDATE' and old.step = 6 then return new; end if;

  begin
    select customer_id into v_customer_id
      from public.orders where id = new.order_id;
    if v_customer_id is null then return new; end if;

    update public.customers c
       set serials = array_append(coalesce(c.serials, '{}'), trim(new.assigned_serial))
     where c.id = v_customer_id
       and not exists (
         select 1 from unnest(coalesce(c.serials, '{}')) s
         where upper(trim(s)) = upper(trim(new.assigned_serial))
       );
  exception when others then
    raise warning 'append_customer_serial_on_fulfillment failed for queue %: %',
      new.id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists fq_append_customer_serial on public.fulfillment_queue;
create trigger fq_append_customer_serial
  after insert or update on public.fulfillment_queue
  for each row execute function public.append_customer_serial_on_fulfillment();

-- ── 4. Operator fix RPC (atomic + idempotent) ────────────────────────────────
-- security definer bypasses RLS, so gate explicitly on is_internal_user().
create or replace function public.add_customer_serial(
  p_customer_id uuid,
  p_serial      text,
  p_reason      text default null
)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_serial text := upper(trim(p_serial));
  v_name   text;
  v_result text[];
begin
  if not public.is_internal_user() then
    raise exception 'internal users only';
  end if;
  if v_serial is null or v_serial = '' then
    raise exception 'serial must not be empty';
  end if;

  select display_name into v_name from public.profiles where id = auth.uid();

  insert into public.customer_serial_overrides
    (customer_id, serial, added_by, added_by_name, reason)
  values (p_customer_id, v_serial, auth.uid(), v_name, p_reason)
  on conflict (customer_id, serial) do nothing;

  update public.customers c
     set serials = array_append(coalesce(c.serials, '{}'), v_serial)
   where c.id = p_customer_id
     and not exists (
       select 1 from unnest(coalesce(c.serials, '{}')) s
       where upper(trim(s)) = v_serial
     );

  select serials into v_result from public.customers where id = p_customer_id;
  if not found then
    raise exception 'customer % not found', p_customer_id;
  end if;
  return v_result;
end;
$$;

revoke execute on function public.add_customer_serial(uuid, text, text) from public, anon;
grant execute on function public.add_customer_serial(uuid, text, text) to authenticated;

-- ── 5. Backfill: fold existing wizard fulfillments in now ───────────────────
select public.sync_customer_serials_from_fulfillment();
```

- [ ] **Step 2: Review the migration against its sources**

No local database exists, so verification is a line-by-line diff review:

1. Compare the `_serial_resolved` CTE and the units write-back block against
   `supabase/migrations/20260605090000_sync_serials_writeback_units.sql`
   lines 40–109. They must be identical.
2. Compare the trigger's guard clauses against
   `supabase/migrations/20260420310000_sync_unit_on_fulfillment.sql` lines
   20–24 (same null-serial / step-6 / transition semantics).
3. Confirm every referenced column exists: `orders.customer_id`
   (`20260604300000_orders_customer_id_fk.sql`), `units.is_team_test`
   (grep migrations if unsure), `profiles.display_name`
   (`20260417015714_profiles.sql`), `public.is_internal_user()`
   (`20260604200000_rls_internal_only.sql`).

Expected: no differences other than the documented union change; all
references resolve.

---

### Task 2: `diagnoseUser` pure function (lib + tests)

**Files:**
- Create: `app/src/lib/lovelyVerification.ts`
- Create: `app/src/lib/lovelyVerification.test.ts`

**Interfaces:**
- Consumes: `LovelyUser` type from `app/src/lib/lovely.ts` (fields used: `email: string`, `serial_number: string | null`).
- Produces (used by Tasks 3–4):

```ts
export type CustomerSerialRecord = {
  id: string;
  email: string | null;
  full_name: string | null;
  serials: string[] | null;
};

export type VerificationVerdict =
  | 'will_auto_verify' | 'no_serial' | 'no_customer' | 'serial_mismatch';

export type Diagnosis = {
  verdict: VerificationVerdict;
  matchedCustomers: CustomerSerialRecord[]; // customers sharing the user's email
  serialOwner: CustomerSerialRecord | null; // DIFFERENT customer already holding the serial
};

export function diagnoseUser(
  user: Pick<LovelyUser, 'email' | 'serial_number'>,
  customersByEmail: CustomerSerialRecord[],
  serialOwners: CustomerSerialRecord[],
): Diagnosis;
export function normalizeSerial(s: string | null | undefined): string;
```

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/lovelyVerification.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { diagnoseUser, type CustomerSerialRecord } from './lovelyVerification';

const cust = (over: Partial<CustomerSerialRecord>): CustomerSerialRecord => ({
  id: 'c1', email: 'jane@x.com', full_name: 'Jane Doe', serials: null, ...over,
});

describe('diagnoseUser', () => {
  it('no_serial when the user has no paired serial', () => {
    const d = diagnoseUser({ email: 'jane@x.com', serial_number: null }, [cust({})], []);
    expect(d.verdict).toBe('no_serial');
  });

  it('no_serial when the serial is whitespace only', () => {
    const d = diagnoseUser({ email: 'jane@x.com', serial_number: '   ' }, [cust({})], []);
    expect(d.verdict).toBe('no_serial');
  });

  it('no_customer when no customer shares the email', () => {
    const d = diagnoseUser(
      { email: 'nobody@x.com', serial_number: 'LL01-00000000307' },
      [cust({ email: 'jane@x.com' })], [],
    );
    expect(d.verdict).toBe('no_customer');
    expect(d.matchedCustomers).toHaveLength(0);
  });

  it('will_auto_verify when email + serial match the same customer (case/space-insensitive both sides)', () => {
    const d = diagnoseUser(
      { email: '  Jane@X.com ', serial_number: 'll01-00000000307' },
      [cust({ serials: [' LL01-00000000307 '] })], [],
    );
    expect(d.verdict).toBe('will_auto_verify');
    expect(d.matchedCustomers).toHaveLength(1);
  });

  it('serial_mismatch when the email matches but no array contains the serial', () => {
    const d = diagnoseUser(
      { email: 'jane@x.com', serial_number: 'LL01-00000000999' },
      [cust({ serials: ['LL01-00000000307'] })], [],
    );
    expect(d.verdict).toBe('serial_mismatch');
    expect(d.matchedCustomers[0].id).toBe('c1');
  });

  it('checks every duplicate customer row sharing the email', () => {
    const d = diagnoseUser(
      { email: 'jane@x.com', serial_number: 'LL01-00000000307' },
      [
        cust({ id: 'c1', serials: ['LL01-00000000111'] }),
        cust({ id: 'c2', serials: ['LL01-00000000307'] }),
      ], [],
    );
    expect(d.verdict).toBe('will_auto_verify');
    expect(d.matchedCustomers).toHaveLength(2);
  });

  it('flags serialOwner when a DIFFERENT customer holds the serial', () => {
    const owner = cust({ id: 'c9', email: 'other@x.com', serials: ['LL01-00000000307'] });
    const d = diagnoseUser(
      { email: 'jane@x.com', serial_number: 'LL01-00000000307' },
      [cust({ serials: null })],
      [owner],
    );
    expect(d.verdict).toBe('serial_mismatch');
    expect(d.serialOwner?.id).toBe('c9');
  });

  it('does NOT set serialOwner when the holder is the matched customer itself', () => {
    const same = cust({ serials: ['LL01-00000000307'] });
    const d = diagnoseUser(
      { email: 'jane@x.com', serial_number: 'LL01-00000000307' },
      [same], [same],
    );
    expect(d.verdict).toBe('will_auto_verify');
    expect(d.serialOwner).toBeNull();
  });

  it('ignores non-string junk inside serials arrays', () => {
    const d = diagnoseUser(
      { email: 'jane@x.com', serial_number: 'LL01-00000000307' },
      [cust({ serials: [null as unknown as string, 'LL01-00000000307'] })], [],
    );
    expect(d.verdict).toBe('will_auto_verify');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `app/`): `npx vitest run src/lib/lovelyVerification.test.ts`
Expected: FAIL — cannot resolve `./lovelyVerification`.

- [ ] **Step 3: Write the implementation**

Create `app/src/lib/lovelyVerification.ts`:

```ts
// Diagnoses why a pending Lovely app user did or didn't auto-verify, using
// EXACTLY the Lovely app's matching rules (Lovely repo lib/inventory.ts):
// email trim+lowercase exact match; serial trim+uppercase compared to each
// serials[] element (elements also trimmed+uppercased). Keep in sync.
import type { LovelyUser } from './lovely';

export type CustomerSerialRecord = {
  id: string;
  email: string | null;
  full_name: string | null;
  serials: string[] | null;
};

export type VerificationVerdict =
  | 'will_auto_verify'   // match exists; user just needs to revisit the app
  | 'no_serial'          // nothing paired on the Lovely account yet
  | 'no_customer'        // no ops customer with this email
  | 'serial_mismatch';   // customer found, serial absent from their arrays

export type Diagnosis = {
  verdict: VerificationVerdict;
  matchedCustomers: CustomerSerialRecord[];
  serialOwner: CustomerSerialRecord | null;
};

const normalizeEmail = (e: string | null | undefined) => (e ?? '').trim().toLowerCase();
export const normalizeSerial = (s: string | null | undefined) => (s ?? '').trim().toUpperCase();

function hasSerial(c: CustomerSerialRecord, serial: string): boolean {
  return (c.serials ?? []).some(
    s => typeof s === 'string' && s.trim().toUpperCase() === serial,
  );
}

export function diagnoseUser(
  user: Pick<LovelyUser, 'email' | 'serial_number'>,
  customersByEmail: CustomerSerialRecord[],
  serialOwners: CustomerSerialRecord[],
): Diagnosis {
  const email = normalizeEmail(user.email);
  const serial = normalizeSerial(user.serial_number);
  const matchedCustomers = customersByEmail.filter(c => normalizeEmail(c.email) === email);
  const serialOwner = serial
    ? serialOwners.find(c => hasSerial(c, serial) && normalizeEmail(c.email) !== email) ?? null
    : null;

  let verdict: VerificationVerdict;
  if (!serial) verdict = 'no_serial';
  else if (matchedCustomers.length === 0) verdict = 'no_customer';
  else if (matchedCustomers.some(c => hasSerial(c, serial))) verdict = 'will_auto_verify';
  else verdict = 'serial_mismatch';

  return { verdict, matchedCustomers, serialOwner };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `app/`): `npx vitest run src/lib/lovelyVerification.test.ts`
Expected: PASS (9 tests).

---

### Task 3: Data fetch + fix action (lib + tests)

**Files:**
- Modify: `app/src/lib/lovelyVerification.ts` (append)
- Modify: `app/src/lib/lovelyVerification.test.ts` (append)

**Interfaces:**
- Consumes: `supabase` from `app/src/lib/supabase.ts`; `approveLovelyUser(userId)` from `app/src/lib/lovely.ts`; `logAction(type, entity, detail, refs?)` from `app/src/lib/activityLog.ts`; RPC `add_customer_serial` from Task 1.
- Produces (used by Task 4):

```ts
export type VerificationContext = {
  customersByEmail: CustomerSerialRecord[];
  serialOwners: CustomerSerialRecord[];
};
export async function fetchVerificationContext(users: LovelyUser[]): Promise<VerificationContext>;
export async function addSerialAndVerify(user: LovelyUser, customerId: string): Promise<void>;
```

- [ ] **Step 1: Write the failing tests**

Append to `app/src/lib/lovelyVerification.test.ts`. The existing import block
must gain `vi` and the new functions; the mocks follow the repo's
`vi.hoisted` pattern (see `app/src/lib/lovely.test.ts`).

```ts
// -- at top of file, replace the vitest import and add mocks ------------------
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, rpcMock, approveMock, logActionMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  approveMock: vi.fn(),
  logActionMock: vi.fn(),
}));

vi.mock('./supabase', () => ({ supabase: { from: fromMock, rpc: rpcMock } }));
vi.mock('./lovely', () => ({ approveLovelyUser: approveMock }));
vi.mock('./activityLog', () => ({ logAction: logActionMock }));

import {
  diagnoseUser, fetchVerificationContext, addSerialAndVerify,
  type CustomerSerialRecord,
} from './lovelyVerification';
import type { LovelyUser } from './lovely';

const user = (over: Partial<LovelyUser>): LovelyUser => ({
  id: 'u1', email: 'jane@x.com', first_name: 'Jane', last_name: 'Doe',
  serial_number: 'LL01-00000000307', onboarding_step: 'pairing',
  is_verified: false, verified_at: null, mailing_list: null,
  last_login_at: null, login_count: null, created_at: null, updated_at: null,
  ...over,
});

// PostgREST-ish chain: .select().or() and .select().overlaps() both resolve.
function tableMock(rows: unknown[], error: unknown = null) {
  const result = Promise.resolve({ data: rows, error });
  return {
    select: vi.fn().mockReturnValue({
      or: vi.fn().mockReturnValue(result),
      overlaps: vi.fn().mockReturnValue(result),
    }),
  };
}

beforeEach(() => {
  fromMock.mockReset(); rpcMock.mockReset();
  approveMock.mockReset(); logActionMock.mockReset();
});

describe('fetchVerificationContext', () => {
  it('queries customers by email (ilike or-chain) and by serial overlap', async () => {
    const emailTable = tableMock([{ id: 'c1', email: 'jane@x.com', full_name: 'Jane', serials: [] }]);
    const serialTable = tableMock([{ id: 'c9', email: 'o@x.com', full_name: 'O', serials: ['LL01-00000000307'] }]);
    fromMock.mockReturnValueOnce(emailTable).mockReturnValueOnce(serialTable);

    const ctx = await fetchVerificationContext([user({})]);

    expect(fromMock).toHaveBeenNthCalledWith(1, 'customers');
    expect(fromMock).toHaveBeenNthCalledWith(2, 'customers');
    expect(emailTable.select).toHaveBeenCalledWith('id, email, full_name, serials');
    expect(ctx.customersByEmail).toHaveLength(1);
    expect(ctx.serialOwners).toHaveLength(1);
  });

  it('skips the serial query when no pending user has a serial', async () => {
    const emailTable = tableMock([]);
    fromMock.mockReturnValueOnce(emailTable);

    const ctx = await fetchVerificationContext([user({ serial_number: null })]);

    expect(fromMock).toHaveBeenCalledTimes(1);
    expect(ctx.serialOwners).toEqual([]);
  });

  it('returns empty context for an empty user list without querying', async () => {
    const ctx = await fetchVerificationContext([]);
    expect(fromMock).not.toHaveBeenCalled();
    expect(ctx).toEqual({ customersByEmail: [], serialOwners: [] });
  });

  it('throws when the email query errors', async () => {
    fromMock.mockReturnValueOnce(tableMock([], { message: 'boom' }));
    await expect(fetchVerificationContext([user({})])).rejects.toThrow('boom');
  });
});

describe('addSerialAndVerify', () => {
  it('runs RPC, then approve, then logs', async () => {
    rpcMock.mockResolvedValue({ data: ['LL01-00000000307'], error: null });
    approveMock.mockResolvedValue(undefined);

    await addSerialAndVerify(user({}), 'c1');

    expect(rpcMock).toHaveBeenCalledWith('add_customer_serial', {
      p_customer_id: 'c1',
      p_serial: 'LL01-00000000307',
      p_reason: 'Verification tab fix for Lovely user jane@x.com',
    });
    expect(approveMock).toHaveBeenCalledWith('u1');
    expect(logActionMock).toHaveBeenCalled();
  });

  it('throws and skips approve when the RPC fails', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'nope' } });
    await expect(addSerialAndVerify(user({}), 'c1')).rejects.toThrow('nope');
    expect(approveMock).not.toHaveBeenCalled();
  });

  it('surfaces an approve failure after a successful RPC (retry-safe)', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    approveMock.mockRejectedValue(new Error('verify down'));
    await expect(addSerialAndVerify(user({}), 'c1')).rejects.toThrow('verify down');
  });

  it('rejects a user with no serial', async () => {
    await expect(addSerialAndVerify(user({ serial_number: '  ' }), 'c1'))
      .rejects.toThrow('no paired serial');
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run (from `app/`): `npx vitest run src/lib/lovelyVerification.test.ts`
Expected: Task 2's tests still PASS; the new describes FAIL
(`fetchVerificationContext is not a function`).

- [ ] **Step 3: Implement fetch + fix**

Append to `app/src/lib/lovelyVerification.ts` (and add the imports at top):

```ts
import { supabase } from './supabase';
import { approveLovelyUser } from './lovely';
import { logAction } from './activityLog';
```

```ts
export type VerificationContext = {
  customersByEmail: CustomerSerialRecord[];
  serialOwners: CustomerSerialRecord[];
};

// Escape ILIKE wildcards so emails containing _ or % only match literally
// (mirrors the Lovely app's escapeIlike).
const escapeIlike = (v: string) => v.replace(/([\\%_])/g, '\\$1');

/** One email query (case-insensitive or-chain) + one serials-overlap query.
 *  Exact-element overlap is OK: stored serials are normalized LL01-… uppercase
 *  (queue serials validated on assignment; sheet sync extracts LL01-[0-9]+). */
export async function fetchVerificationContext(users: LovelyUser[]): Promise<VerificationContext> {
  const emails = [...new Set(
    users.map(u => (u.email ?? '').trim().toLowerCase()).filter(Boolean),
  )];
  const serials = [...new Set(
    users.map(u => normalizeSerial(u.serial_number)).filter(Boolean),
  )];
  if (emails.length === 0) return { customersByEmail: [], serialOwners: [] };

  const orFilter = emails.map(e => `email.ilike.${escapeIlike(e)}`).join(',');
  const { data: byEmail, error: emailErr } = await supabase
    .from('customers')
    .select('id, email, full_name, serials')
    .or(orFilter);
  if (emailErr) throw new Error(emailErr.message);

  let serialOwners: CustomerSerialRecord[] = [];
  if (serials.length > 0) {
    const { data: owners, error: serialErr } = await supabase
      .from('customers')
      .select('id, email, full_name, serials')
      .overlaps('serials', serials);
    if (serialErr) throw new Error(serialErr.message);
    serialOwners = (owners ?? []) as CustomerSerialRecord[];
  }

  return {
    customersByEmail: (byEmail ?? []) as CustomerSerialRecord[],
    serialOwners,
  };
}

/** Verification-tab fix: add the user's serial to the customer record
 *  (durable via customer_serial_overrides), then verify them in the Lovely
 *  app. Idempotent RPC + plain flag set, so retrying after a partial
 *  failure is safe. */
export async function addSerialAndVerify(user: LovelyUser, customerId: string): Promise<void> {
  const serial = normalizeSerial(user.serial_number);
  if (!serial) throw new Error('User has no paired serial to add.');

  const { error } = await supabase.rpc('add_customer_serial', {
    p_customer_id: customerId,
    p_serial: serial,
    p_reason: `Verification tab fix for Lovely user ${user.email}`,
  });
  if (error) throw new Error(error.message);

  await approveLovelyUser(user.id);
  await logAction(
    'lovely_serial_added',
    user.email ?? user.id,
    `Added ${serial} to customer + verified ${user.email ?? user.id}`,
    { entityType: 'customer', entityId: customerId, unitSerial: serial },
  );
}
```

- [ ] **Step 4: Run to verify all tests pass**

Run (from `app/`): `npx vitest run src/lib/lovelyVerification.test.ts`
Expected: PASS (17 tests).

---

### Task 4: Verification tab UI (diagnosis column + fix button)

**Files:**
- Modify: `app/src/modules/Lovely/VerificationTab.tsx` (full replacement below)
- Modify: `app/src/modules/Lovely/Lovely.module.css` (append + one edit)
- Create: `app/src/modules/Lovely/VerificationTab.test.tsx`

**Interfaces:**
- Consumes: `useLovelyUsers`, `approveLovelyUser` (`../../lib/lovely`); `diagnoseUser`, `fetchVerificationContext`, `addSerialAndVerify`, types (`../../lib/lovelyVerification`); `logAction` (`../../lib/activityLog`); existing CSS classes `sectionNote`, `errorBar`, `retryBtn`, `tableWrap`, `table`, `mono`, `muted`, `empty`, `approveBtn`, `badgeOk`, `badgeWarn`, `linkBtn`, `calloutBar`.
- Produces: no exports consumed elsewhere (`VerificationTab` is already wired into `modules/Lovely/index.tsx`).

- [ ] **Step 1: Write the failing component test**

Create `app/src/modules/Lovely/VerificationTab.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { useLovelyUsersMock, approveMock, fetchCtxMock, addSerialAndVerifyMock, logActionMock } =
  vi.hoisted(() => ({
    useLovelyUsersMock: vi.fn(),
    approveMock: vi.fn(),
    fetchCtxMock: vi.fn(),
    addSerialAndVerifyMock: vi.fn(),
    logActionMock: vi.fn(),
  }));

vi.mock('../../lib/lovely', () => ({
  useLovelyUsers: useLovelyUsersMock,
  approveLovelyUser: approveMock,
}));
vi.mock('../../lib/lovelyVerification', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/lovelyVerification')>()),
  fetchVerificationContext: fetchCtxMock,
  addSerialAndVerify: addSerialAndVerifyMock,
}));
vi.mock('../../lib/activityLog', () => ({ logAction: logActionMock }));

import { VerificationTab } from './VerificationTab';

const baseUser = {
  id: 'u1', email: 'jane@x.com', first_name: 'Jane', last_name: 'Doe',
  serial_number: 'LL01-00000000307', onboarding_step: 'pairing',
  is_verified: false, verified_at: null, mailing_list: null,
  last_login_at: null, login_count: null,
  created_at: '2026-07-01T00:00:00Z', updated_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  useLovelyUsersMock.mockReturnValue({
    users: [baseUser], loading: false, error: null, refetch: vi.fn(),
  });
});

describe('VerificationTab diagnosis', () => {
  it('shows a mismatch badge and the fix button when the serial is missing from the customer', async () => {
    fetchCtxMock.mockResolvedValue({
      customersByEmail: [{ id: 'c1', email: 'jane@x.com', full_name: 'Jane Doe', serials: ['LL01-00000000111'] }],
      serialOwners: [],
    });
    render(<VerificationTab />);
    expect(await screen.findByText('Serial mismatch')).toBeTruthy();
    expect(screen.getByRole('button', { name: /add serial \+ verify/i })).toBeTruthy();
  });

  it('runs the fix on click', async () => {
    fetchCtxMock.mockResolvedValue({
      customersByEmail: [{ id: 'c1', email: 'jane@x.com', full_name: 'Jane Doe', serials: [] }],
      serialOwners: [],
    });
    addSerialAndVerifyMock.mockResolvedValue(undefined);
    render(<VerificationTab />);
    fireEvent.click(await screen.findByRole('button', { name: /add serial \+ verify/i }));
    await waitFor(() =>
      expect(addSerialAndVerifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'u1' }), 'c1',
      ));
  });

  it('shows will-auto-verify with Approve only', async () => {
    fetchCtxMock.mockResolvedValue({
      customersByEmail: [{ id: 'c1', email: 'jane@x.com', full_name: 'Jane Doe', serials: ['LL01-00000000307'] }],
      serialOwners: [],
    });
    render(<VerificationTab />);
    expect(await screen.findByText('Will auto-verify')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /add serial \+ verify/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeTruthy();
  });

  it('shows no-customer and degrades to Approve when diagnosis fetch fails', async () => {
    fetchCtxMock.mockRejectedValue(new Error('offline'));
    render(<VerificationTab />);
    // Appears twice (error bar + per-row cell), so findAllByText, not findByText.
    expect((await screen.findAllByText(/diagnosis unavailable/i)).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `app/`): `npx vitest run src/modules/Lovely/VerificationTab.test.tsx`
Expected: FAIL — `Serial mismatch` not found (component has no diagnosis yet).

- [ ] **Step 3: Add CSS**

In `app/src/modules/Lovely/Lovely.module.css` there is one shared badge rule
whose selector list is exactly `.badgeOk, .badgeWarn` (around line 55). Edit
ONLY its selector list to `.badgeOk, .badgeWarn, .badgeErr` — do not touch
the declarations inside the braces.

Then append at the end of the file:

```css
/* Verification tab diagnosis */
.badgeErr { color: #9b2c2c; background: #fed7d7; }
.diagCell { display: flex; align-items: center; gap: 8px; }
.diagDetailRow td { background: #f7fafc; padding: 10px 12px; }
.diagDetail { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #4a5568; }
.fixBtn { border: 1px solid #2b6cb0; background: #2b6cb0; color: #fff; border-radius: 6px; padding: 5px 12px; font-size: 13px; cursor: pointer; }
.fixBtn:disabled { opacity: 0.6; cursor: default; }
```

- [ ] **Step 4: Replace `VerificationTab.tsx`**

Full new content of `app/src/modules/Lovely/VerificationTab.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useLovelyUsers, approveLovelyUser, type LovelyUser } from '../../lib/lovely';
import {
  diagnoseUser, fetchVerificationContext, addSerialAndVerify,
  type Diagnosis, type VerificationContext,
} from '../../lib/lovelyVerification';
import { logAction } from '../../lib/activityLog';
import styles from './Lovely.module.css';

const VERDICT_BADGE: Record<Diagnosis['verdict'], { label: string; className: string }> = {
  will_auto_verify: { label: 'Will auto-verify', className: 'badgeOk' },
  serial_mismatch:  { label: 'Serial mismatch',  className: 'badgeWarn' },
  no_customer:      { label: 'No customer',      className: 'badgeErr' },
  no_serial:        { label: 'No serial',        className: 'badgeErr' },
};

export function VerificationTab() {
  const { users, loading, error, refetch } = useLovelyUsers();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [ctx, setCtx] = useState<VerificationContext | null>(null);
  const [ctxErr, setCtxErr] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const pending = useMemo(
    () =>
      users
        .filter(u => u.is_verified !== true)
        .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')),
    [users],
  );

  useEffect(() => {
    if (pending.length === 0) {
      setCtx({ customersByEmail: [], serialOwners: [] });
      setCtxErr(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const next = await fetchVerificationContext(pending);
        if (!cancelled) { setCtx(next); setCtxErr(null); }
      } catch (e) {
        if (!cancelled) { setCtx(null); setCtxErr((e as Error).message); }
      }
    })();
    return () => { cancelled = true; };
  }, [pending]);

  const approve = async (u: LovelyUser) => {
    setBusyId(u.id);
    setActionErr(null);
    try {
      await approveLovelyUser(u.id);
      await logAction('lovely_user_verified', u.email ?? u.id, `Approved Lovely app user ${u.email ?? u.id}`);
      await refetch();
    } catch (e) {
      setActionErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  // Add the serial to the ops customer (durable + audited), then verify the
  // user. addSerialAndVerify logs its own activity entry.
  const fix = async (u: LovelyUser, customerId: string) => {
    setBusyId(u.id);
    setActionErr(null);
    try {
      await addSerialAndVerify(u, customerId);
      await refetch();
    } catch (e) {
      setActionErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const renderDiagnosis = (u: LovelyUser) => {
    if (ctxErr) return <span className={styles.muted}>Diagnosis unavailable</span>;
    if (!ctx) return <span className={styles.muted}>…</span>;
    const d = diagnoseUser(u, ctx.customersByEmail, ctx.serialOwners);
    const badge = VERDICT_BADGE[d.verdict];
    return (
      <span className={styles.diagCell}>
        <span className={styles[badge.className]}>{badge.label}</span>
        {(d.matchedCustomers.length > 0 || d.serialOwner) && (
          <button
            className={styles.linkBtn}
            onClick={() => setExpandedId(expandedId === u.id ? null : u.id)}
          >
            {expandedId === u.id ? 'hide' : 'detail'}
          </button>
        )}
      </span>
    );
  };

  const renderDetail = (u: LovelyUser) => {
    if (!ctx || expandedId !== u.id) return null;
    const d = diagnoseUser(u, ctx.customersByEmail, ctx.serialOwners);
    return (
      <tr key={`${u.id}-detail`} className={styles.diagDetailRow}>
        <td colSpan={7}>
          <div className={styles.diagDetail}>
            {d.matchedCustomers.map(c => (
              <span key={c.id}>
                Customer <strong>{c.full_name ?? c.email}</strong>: serials{' '}
                <span className={styles.mono}>{(c.serials ?? []).join(', ') || 'none'}</span>
                {' '}vs user serial{' '}
                <span className={styles.mono}>{u.serial_number ?? 'none'}</span>
              </span>
            ))}
            {d.serialOwner && (
              <span className={styles.calloutBar}>
                Warning: this serial is already on{' '}
                <strong>{d.serialOwner.full_name ?? d.serialOwner.email}</strong>. No automated
                fix; check which customer actually owns the unit.
              </span>
            )}
          </div>
        </td>
      </tr>
    );
  };

  const renderActions = (u: LovelyUser) => {
    const d = ctx && !ctxErr ? diagnoseUser(u, ctx.customersByEmail, ctx.serialOwners) : null;
    const fixTarget = d?.verdict === 'serial_mismatch' ? d.matchedCustomers[0] : null;
    return (
      <>
        {fixTarget && (
          <button
            className={styles.fixBtn}
            disabled={busyId === u.id}
            onClick={() => void fix(u, fixTarget.id)}
            title={`Add ${u.serial_number} to ${fixTarget.full_name ?? fixTarget.email} and verify`}
          >
            {busyId === u.id ? 'Fixing…' : 'Add serial + verify'}
          </button>
        )}{' '}
        <button
          className={styles.approveBtn}
          disabled={busyId === u.id}
          onClick={() => void approve(u)}
        >
          {busyId === u.id ? 'Approving…' : 'Approve'}
        </button>
      </>
    );
  };

  return (
    <>
      <div className={styles.sectionNote}>
        Approving sets the user to verified in the Lovely app — they’re let through the
        pending-approval gate on their next visit. Diagnosis shows why each user didn’t
        auto-verify; "Add serial + verify" also fixes the customer record.
      </div>
      {error && (
        <div className={styles.errorBar}>
          Error: {error}{' '}
          <button onClick={() => void refetch()} className={styles.retryBtn}>Retry</button>
        </div>
      )}
      {ctxErr && <div className={styles.errorBar}>Diagnosis unavailable: {ctxErr}</div>}
      {actionErr && <div className={styles.errorBar}>{actionErr}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Paired serial</th>
              <th>Step</th>
              <th>Signed up</th>
              <th>Diagnosis</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && users.length === 0 ? (
              <tr><td colSpan={7} className={styles.empty}>Loading…</td></tr>
            ) : pending.length === 0 ? (
              <tr><td colSpan={7} className={styles.empty}>No users pending verification. 🎉</td></tr>
            ) : (
              pending.flatMap(u => [
                <tr key={u.id}>
                  <td><strong>{[u.first_name, u.last_name].filter(Boolean).join(' ') || <span className={styles.muted}>—</span>}</strong></td>
                  <td className={styles.mono}>{u.email || <span className={styles.muted}>—</span>}</td>
                  <td className={styles.mono}>{u.serial_number || <span className={styles.muted}>—</span>}</td>
                  <td>{u.onboarding_step || <span className={styles.muted}>—</span>}</td>
                  <td className={styles.mono}>
                    {u.created_at
                      ? new Date(u.created_at).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' })
                      : '—'}
                  </td>
                  <td>{renderDiagnosis(u)}</td>
                  <td>{renderActions(u)}</td>
                </tr>,
                renderDetail(u),
              ])
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
```

Notes for the implementer:
- The em dash in the pre-existing sectionNote sentence stays (existing copy);
  the appended sentence must not introduce new em dashes.
- `styles[badge.className]` indexes the CSS module with a string; if
  typescript-eslint complains, use
  `styles[badge.className as keyof typeof styles]`.

- [ ] **Step 5: Run the component tests**

Run (from `app/`): `npx vitest run src/modules/Lovely/VerificationTab.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Run lint and the full suite**

Run (from `app/`): `npm run lint && npm run test:run`
Expected: lint clean; full suite green (no pre-existing failures in this repo).

---

### Task 5: Wrap-up verification

**Files:** none (verification only)

- [ ] **Step 1: Full check**

Run (from `app/`): `npm run lint && npm run test:run && npm run build`
Expected: all green. (`build` runs `tsc -b`, which is the type check — the
Vite build also confirms the lazy-loaded Lovely module still compiles.)

- [ ] **Step 2: Report deferred items to Ryan**

These cannot be done from this machine/plan and must be listed in the final
summary, not silently dropped:

1. Commit and push (Ryan does this manually).
2. Apply the migration via the gated `workflow_dispatch` (`apply_migrations`)
   CI path.
3. Post-apply: run `select public.sync_customer_serials_from_fulfillment();`
   once and compare its report to a pre-migration run. Every previously
   synced serial must still be present; `wizard_serials` and
   `override_serials` counts explain any additions.
4. Spot-check one pending Lovely user in the Verification tab and exercise
   "Add serial + verify" on a known-good mismatch.
