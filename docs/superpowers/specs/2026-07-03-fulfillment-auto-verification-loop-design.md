# Fulfillment → Auto-Verification Loop

**Date:** 2026-07-03
**Status:** Approved design, pending implementation plan

## Context

When a Lovely app user signs up, the app auto-verifies them by matching their
session email AND paired serial against `customers.serials[]` in the makelila
ops project (Lovely repo: `lib/verification.ts` + `lib/inventory.ts`, reading
`INVENTORY_SUPABASE_URL` = this project). Users who don't match land on a
manual "verification pending" screen and wait for an admin to approve them in
makelila's `/lovely` Verification tab.

Two gaps cause unnecessary manual approvals:

1. **Write side.** `customers.serials` is populated only by
   `sync_customer_serials_from_fulfillment()`, whose sole source is
   `fulfillment_log` (the "LILA customer fulfillment.xlsx" sheet, imported
   on demand by `scripts/import-fulfillment-sheet.mjs`). Units shipped through
   the in-app fulfillment wizard never reach `customers.serials`, so their
   buyers always fail auto-verification.
2. **Diagnostics.** The Verification tab shows pending users but cannot say
   *why* a user didn't auto-verify (no customer row, serial missing from the
   array, serial typo, nothing paired yet), and offers no data fix, only a
   blanket Approve.

Decision (confirmed with Ryan): the sheet remains the record for
historical/off-app shipments; the wizard is the record for new shipments.
Both must coexist ("Approach A: 3-source recompute").

## Goals

- A unit fulfilled through the wizard makes its buyer auto-verifiable the
  moment the queue row reaches step 6, with no manual sync.
- Re-running the sheet sync never wipes wizard-derived or operator-added
  serials.
- The Verification tab explains each pending user's auto-verification state
  using exactly the Lovely app's matching rules, and offers a one-click
  "fix data + verify" where the fix is well-defined.
- Operator serial additions are durable and audited.

## Non-Goals

- Creating `customers` rows from the Verification tab (no-customer case gets
  Approve only).
- Any UI change to the fulfillment wizard (e.g. a "customer link missing"
  warning on StepFulfilled). Possible follow-up.
- Changing the Lovely app repo. Its matching logic is mirrored, not modified.
- Removing serials from customers outside the existing sheet-sync semantics.

## Design

### 1. Migration (ops DB)

One migration file containing:

**a. `customer_serial_overrides` table**

```sql
create table public.customer_serial_overrides (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.customers(id) on delete cascade,
  serial        text not null,
  added_by      uuid,            -- auth.uid() of the operator
  added_by_name text,
  reason        text,
  created_at    timestamptz not null default now(),
  unique (customer_id, serial)
);
```

RLS: internal-only (same `rls_internal_only` pattern as sibling tables).
Insert-only by convention (System of record: operator-curated).

**b. Redefine `sync_customer_serials_from_fulfillment()`**

Keep the current behavior (latest definition in
`20260605090000_sync_serials_writeback_units.sql`, including the
`units.customer_id`/`customer_name` write-back and the unmatched report), but
the final per-customer array becomes the union of three sources:

1. Sheet-derived: existing `fulfillment_log` resolution CTE, unchanged.
2. Wizard-derived: `fulfillment_queue` rows with `step = 6` and
   `assigned_serial is not null`, joined via `orders.customer_id`
   (skip null `customer_id`).
3. Operator overrides: all rows of `customer_serial_overrides`.

Serials are de-duplicated case-insensitively (arrays store the stored casing;
queue serials are already normalized `LL01-…`). The RPC still clears all
`customers.serials` first, so a serial removed from the sheet disappears on
re-sync unless the wizard or an override still claims it.

**c. Trigger `fq_append_customer_serial` on `fulfillment_queue`**

A new, separate trigger function (not merged into `sync_unit_on_fulfillment`)
that fires after insert/update, on transition into step 6 (mirroring the
existing trigger's guard: skip when `tg_op = 'UPDATE' and old.step = 6`):

- Look up `orders.customer_id` for `new.order_id`; return if null or
  `new.assigned_serial` is null.
- Append `new.assigned_serial` to that customer's `serials` if no existing
  element matches case-insensitively.
- The whole body is wrapped in `begin … exception when others then
  raise warning …; return new;` so a serials failure can never abort the
  step-6 update (shipping must not break because of this feature).

**d. RPC `add_customer_serial(p_customer_id uuid, p_serial text, p_reason text)`**

Atomic, idempotent operator fix used by the Verification tab:

- Insert into `customer_serial_overrides` (`added_by = auth.uid()`,
  `added_by_name` from `profiles`), `on conflict do nothing`.
- Append to `customers.serials` if not already present (case-insensitive).
- Returns the resulting serials array. Security: internal-only via RLS/grants
  consistent with existing internal RPCs; callable by any internal operator
  (the UI surface is already leadership-gated).

### 2. Wizard write path

No client changes. The trigger covers every path into step 6: the
`send-fulfillment-email` edge function (the normal flow), backfills, and
manual step edits.

### 3. Verification tab diagnostics (`/lovely`)

**New `app/src/lib/lovelyVerification.ts`:**

- `fetchCustomersForEmails(emails: string[])`: one query on ops `customers`
  (`id, email, full_name, serials`) filtered case-insensitively to the
  pending users' emails. A second query feeds the `serial_elsewhere` check:
  `customers` rows whose `serials` array overlaps the pending users'
  normalized serials (`.overlaps('serials', [...])`). Exact-element overlap
  is sufficient because both sides are normalized `LL01-…` uppercase (queue
  serials are validated on assignment; the sheet sync extracts serials with
  the `LL01-[0-9]+` pattern).
- `diagnoseUser(user, customers)`: pure function mirroring the Lovely app's
  matching exactly (email `trim().toLowerCase()` exact match; serial
  `trim().toUpperCase()` compared to each element of `serials[]`,
  trimmed/uppercased). Verdicts:
  - `will_auto_verify`: email + serial match a customer; user just hasn't
    re-visited the pending screen.
  - `no_serial`: user has no paired serial. Note: diagnosis sees only
    `serial_number` as returned by the `lovely-users` edge function (the
    `public.users` row). The Lovely app also falls back to auth metadata,
    which makelila cannot see; in practice the signup trigger copies the
    metadata serial into the users row, so the gap is rare. Extending the
    edge function to expose the metadata fallback is out of scope.
  - `no_customer`: no ops customer with that email.
  - `serial_mismatch`: customer(s) found by email, serial absent from their
    arrays. Detail shows both sides.
  - `serial_elsewhere` (modifier on the above): the user's serial exists on a
    *different* customer's array; shown as a warning, no automated fix.
- `addSerialAndVerify(user, customerId)`: calls `add_customer_serial` RPC with a
  reason referencing the Lovely user, then `approveLovelyUser(user.id)`
  (existing), then `logAction`. If approve fails after the data fix, the
  error surfaces; retry is safe because the RPC is idempotent and approve is
  a plain flag set.

**`VerificationTab.tsx` changes:**

- New "Diagnosis" column: compact badge per verdict, expandable row detail
  showing the matched customer's name and serials next to the user's serial.
- Action button per verdict:
  - `serial_mismatch` → "Add serial + verify" (runs `fixAndVerify`).
  - `will_auto_verify` → existing Approve.
  - `no_customer`, `no_serial` → existing Approve, with the reason visible.
- Diagnosis-fetch failure degrades gracefully: error bar, table still renders
  with Approve buttons (current behavior preserved).

### 4. Error handling summary

| Failure | Behavior |
|---|---|
| Trigger append fails | Warning logged in Postgres; step-6 update commits; serial arrives at next full sync |
| Order has no `customer_id` | Trigger no-ops; serial surfaces in the sync RPC's unmatched report |
| RPC insert conflicts (retry) | `on conflict do nothing`; append guarded by containment check |
| `approveLovelyUser` fails after data fix | Error shown; button retryable; data fix already durable |
| Customers query fails in tab | Error bar + Approve-only fallback |

## Testing

- **Vitest (colocated):**
  - `diagnoseUser`: every verdict; casing/whitespace variants (mirror
    `inventory.ts` semantics); duplicate customer rows sharing an email;
    serial owned by another customer; user with no serial.
  - `fixAndVerify`: mocked supabase client / fetch; RPC error, approve error
    after successful RPC, happy path with logAction call.
- **Migration verification (manual, no SQL harness exists):** before applying,
  run the current sync and record its report; after applying, run the new sync
  and diff: every previously-synced serial must still be present, plus
  wizard-derived ones. The RPC's returned jsonb report makes this a
  copy-paste comparison.
- Migrations ship through the existing gated `workflow_dispatch` CI path.

## Rollout

1. Land migration + lib + UI in one branch (Ryan commits/pushes manually).
2. Apply migration via the gated workflow.
3. Run `sync_customer_serials_from_fulfillment()` once; compare reports
   (see Testing).
4. Spot-check one pending Lovely user in the Verification tab; use
   "Add serial + verify" on a known-good mismatch.
