# Stock: gated batch-creation section — design

**Date:** 2026-08-28
**Module:** Stock (LILA Units tab) + a new `stock_managers` access table
**Status:** designed, not built.

## Problem

There is no way to add a batch from inside makeLILA. The Stock page's batch cards
are a straight read of the `batches` table via `useBatches()`
(`app/src/lib/stock.ts:130`), rendered by `Stock/BatchCards.tsx` — and `batches`
carries only SELECT and UPDATE policies
(`supabase/migrations/20260604200000_rls_internal_only.sql:21-28`). It has no
INSERT policy at all, so no browser client can create one regardless of who is
signed in. Every batch since the original seed has been added by hand, as a SQL
migration.

That matters beyond convenience: `units.batch` is an FK to `batches(id)` with
`on delete restrict`, so a serial cannot be claimed into a batch that has no row.
The Build module's New PO dropdown already offers `P200` and `LILA-Mini`
(`app/src/modules/Build/NewPOModal.tsx:66-67`), neither of which has a `batches`
row — the PO saves (`factory_orders.batch` is plain text, no FK) and then the
first serial claim fails on the FK.

We want an in-app "Add batch" section on the Stock page, visible only to the
people who run Stock, plus leadership.

## Access model

### The constraint

There is no `stock` role. `user_role` is
`('operator','manager','finance','admin')`
(`supabase/migrations/20260607020000_profiles_role_enum_and_canDo_canView.sql:50`),
mirrored by the `Role` union in `app/src/lib/permissions.ts:17`. `'stock'` exists
only as a **Module** name (`permissions.ts:36`), which governs nav and route
visibility, not identity. "Stock = Junaid" is a docs convention
(`docs/session-notes/README.md:93`), not an enforced grant.

Junaid is an `operator`: `junaid@virgohome.io` is in `team_invite_list`
(`20260417023746_seed_team_invite_list.sql:13`), and the only role ever seeded
above the `'operator'` default is `finance`, for george@ / huayi@ / yueli@
(`20260607020000...sql:89-96`).

Two dead ends follow:

- **Gating on `operator` gates on everyone** — it is the default role assigned by
  `handle_new_user()` to every new sign-in.
- **Moving Junaid to a new `stock` role silently revokes three grants.**
  `submit_to_manager`, `move_refund_flow`, and `edit_warranty_registration` all
  list `operator` in `ACTION_ROLES` (`permissions.ts:44-58`); that last one is
  Junaid's own warranty write path.

**Decision: roles are not touched.** No enum change, no role reassignment, no
edits to existing `ACTION_ROLES` entries.

### The allowlist

A per-person table, mirroring how Hiring grants posting access:

```sql
create table public.stock_managers (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  added_by   uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create or replace function public.can_manage_batches()
returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_finance() or exists (
    select 1 from public.stock_managers where profile_id = auth.uid()
  );
$$;

grant execute on function public.can_manage_batches() to authenticated;
```

`is_finance()` already resolves to finance-or-admin, so leadership is always
included — the same construction as `can_view_posting()`
(`20260724140000_hiring_schema.sql:86-93`).

RLS on `stock_managers`:

| Op | Policy |
|---|---|
| select | `profile_id = auth.uid() or public.is_finance()` |
| insert | `public.is_finance()` |
| delete | `public.is_finance()` |

The narrow SELECT lets a user resolve their own membership without being able to
enumerate the list, and avoids a chicken-and-egg where a non-member cannot read
the table to learn they are not a member. INSERT/DELETE match
`posting_interviewers` (`20260724140000_hiring_schema.sql:120-123`): leadership
grants and revokes.

Seed Junaid in the same migration, by email, guarded so a missing profile is not
an error:

```sql
insert into public.stock_managers (profile_id)
select p.id from public.profiles p
  join auth.users u on u.id = p.id
 where lower(u.email) = 'junaid@virgohome.io'
on conflict (profile_id) do nothing;
```

### The INSERT policy `batches` never had

```sql
create policy "batches_insert" on public.batches
  for insert to authenticated
  with check (public.can_manage_batches());
```

This is the real security boundary. The UI gate below is cosmetic.

`batches_update` is deliberately left as-is (`is_internal_user()`). Tightening it
would change who can edit existing batches, which is outside this request.

A new enum value was considered and rejected, but note for the record that it
would also have been safe on the SQL side: `current_user_role()` is defined and
never referenced by any policy, and `is_manager()` / `is_finance()` use explicit
IN-lists.

## Client gate

Split the same way Hiring splits it, so the decision itself stays pure and
testable:

- `app/src/lib/stock.ts` — `isStockManager(): Promise<boolean>` (a `limit(1)`
  read of `stock_managers` filtered on the caller's own id) and a
  `useIsStockManager()` hook wrapping it, modelled on
  `isAssignedInterviewerAnywhere()` / `useIsAssignedInterviewer()`
  (`app/src/lib/hiring.ts:340-365`).
- `app/src/lib/permissions.ts` — `canManageBatches(role, isStockManager)`,
  returning `isLeadership(role) || isStockManager`.

`canManageBatches` follows `canAccessHiringModule`'s null-role handling: a true
`isStockManager` is sufficient on its own, because it can only be true after an
RLS-gated read filtered on the caller's own id has already succeeded. A null
`role` at that moment means AuthProvider's profile fetch has not resolved yet —
not an unauthenticated caller — so treating it as a denial would flash-hide the
section from a legitimate stock manager.

## UI

An **Add batch** button above the `BatchCards` grid in
`app/src/modules/Stock/UnitsTab.tsx`, rendered only when the gate passes. It
opens a new `app/src/modules/Stock/NewBatchModal.tsx`, built on the
`NewPOModal.tsx` structure and using `btnPrimary` / `btnSecondary` from
`Stock.module.css`.

Fields, all writing to `batches`:

| Field | Notes |
|---|---|
| `id` | required; the batch key, e.g. `P200` |
| `unit_count` | required; invoice quantity |
| `version`, `manufacturer`, `manufacturer_short`, `incoterm` | free text |
| `unit_cost_usd`, `total_cost_usd` | `total` prefills to cost × count, stays editable |
| `invoice_no`, `invoice_date` | |
| `expected_arrival_date`, `arrived_at` | `arrived_at` null renders "In production" on the card |
| `destination`, `notes` | |

`total_cost_usd` must stay editable rather than being computed: P50N is
314.00 × 40 = 12,560 but stored as 13,300, because that invoice also covered 40
replacement top lids.

`phases` is omitted in v1. It defaults to `'[]'::jsonb` and only feeds the
Finance production-projection Gantt.

Duplicate `id` surfaces as an inline error from the PK violation; no pre-check.

## Data layer

`createBatch(input)` in `app/src/lib/stock.ts` — a single insert, followed by
`logAction('batch_created', id, ...)` per the repo convention that every mutation
writes to the audit trail. Errors propagate to the modal for inline display, the
same shape as `createPO()`.

Realtime is already enabled on `batches`, and `useBatches()` subscribes, so a new
card appears without a reload.

## Scope

- **In scope:** the migration (table, helper, policies, Junaid seed, `batches`
  INSERT policy), `createBatch()`, the two gate helpers, `NewBatchModal.tsx`, the
  gated button in `UnitsTab.tsx`, and tests.
- **Out of scope:** bulk unit creation (decided: batch row only — units keep
  arriving through the Build tab's claim-serial flow, which is how P100 worked);
  editing or deleting existing batches; a UI for managing `stock_managers`
  membership (leadership adds rows by SQL, as with `posting_interviewers`);
  `phases` editing; tightening `batches_update`.

## Tests

- `permissions.test.ts` — `canManageBatches` across all four roles × both
  `isStockManager` values, including the null-role-but-manager case.
- `stock.test.ts` — `createBatch` issues the insert and logs; `isStockManager`
  returns false on a query error rather than throwing.

## Watch-outs

- **`unit_count` is invoice metadata, not a row count.** The card's "Total" is
  computed from real `units` rows via `sliceTotals()`
  (`BatchCards.tsx:18-28`), so a freshly created batch reads **Total 0** until
  serials are claimed. This is correct, and will look wrong to an operator who
  just typed `200` into the form. Worth a hint in the modal.
- **Hiding a button is not access control.** The `batches_insert` policy is what
  enforces this; the client gate only avoids showing an affordance that would
  fail.
- **P200 and LILA-Mini already exist as PO dropdown options** with no `batches`
  row. Once this ships, creating those batch rows is the fix for the FK error on
  serial claim.
