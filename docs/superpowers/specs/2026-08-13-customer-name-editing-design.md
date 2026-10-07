# Customer name editing, propagated everywhere

**Date:** 2026-08-13
**Module:** Customers
**Status:** Approved for planning

## Problem

Operators cannot correct a customer's name. `customers.first_name` and
`customers.last_name` are written by the HubSpot sync and never edited in the
app, so a typo, a maiden name, or a missing name stays wrong forever. 55 of 378
customers currently have no name at all.

Fixing the `customers` row alone is not enough. Eleven other tables keep a
denormalized snapshot of the name as plain text, and several of them are matched
back to the customer *by that name string* (follow-up status keys in
`lib/followupStatus.ts`, unit→customer resolution in `lib/dashboard.ts`,
purchaser matching in `exportPurchasers`). A rename that touches only
`customers` does not just leave stale text on screen — it silently orphans those
records from the customer they belong to.

## Decisions taken

1. **Propagation is total.** The corrected name is written to every related row
   across all eleven tables. The old name disappears from the app.
2. **Ambiguous rows are skipped, never guessed.** Where a row can only be matched
   by name and that name is shared by another customer, the row is left
   unchanged and reported to the operator.
3. **Preview before apply.** Save runs a dry run first and shows the blast radius;
   the operator confirms before anything is written.
4. **The work runs in one Postgres RPC**, not client-side, so the whole rename is
   a single transaction and the preview shares its code path with the apply.

## Current state

`customers.full_name` is a **stored generated column**:

```sql
full_name text generated always as (
  trim(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))
) stored
```

Every screen that reads a `customers` row therefore updates itself the moment
`first_name` / `last_name` change — no application code needs to touch
`full_name`. All eleven target tables already grant `UPDATE` to `authenticated`
under `is_internal_user()`, so no RLS change is required.

Snapshot rows carrying a customer name today:

| table | rows |
|---|---|
| `service_tickets` | 390 |
| `orders` | 257 |
| `units` | 204 |
| `fulfillment_log` | 157 |
| `returns` | 50 |
| `replacement_queue` | 44 |
| `refund_approvals` | 12 |
| `part_shipments` | 6 |
| `shipping_damage_claims` | 4 |
| `order_cancellations` | 2 |

## Matching ladder

A row belongs to the customer being renamed if, in priority order:

1. its `customer_id` equals the customer's id; else
2. its `customer_email` equals the customer's email (lowercased, trimmed), and
   the customer has an email on file; else
3. its `customer_name` matches the old `full_name` case-insensitively after
   trimming — **only when the old name is unambiguous** (see below).

The steps are exclusive, not cumulative. A row whose `customer_id` is set to a
*different* customer is never reached by steps 2 or 3, even if its email or name
matches — an explicit FK to someone else outranks a weaker key pointing here.
Likewise a row with an email that belongs to another customer is not matched by
name.

Per-table keys:

| table | pk | `customer_id` | `customer_email` | name fallback |
|---|---|---|---|---|
| `orders` | `id` | yes | yes | unlinked rows only |
| `service_tickets` | `id` | yes | yes | unlinked rows only |
| `units` | `serial` | yes | no | unlinked rows only |
| `part_shipments` | `id` | yes | no | unlinked rows only |
| `returns` | `id` | no | yes | rows with no email |
| `refund_approvals` | `id` | no | yes | rows with no email |
| `replacement_queue` | `id` | no | yes | rows with no email |
| `order_cancellations` | `id` | no | yes | rows with no email |
| `shipping_damage_claims` | `id` | no | yes | rows with no email |
| `fulfillment_log` | `id` | no | no | name only |

`fulfillment_log` is the only table with no key other than the name, so it is
the table most exposed to the ambiguity rule.

### Ambiguity

The old name is **ambiguous** when another `customers` row has the same
`lower(trim(full_name))`. Four such pairs exist today (Patrick Cusick, Pedrum
Amin, Rongbing Sun, Dhruv Talwar).

When the old name is ambiguous, step 3 of the ladder is suppressed entirely.
Rows that would have matched by name are collected into a `skipped` list and
returned to the UI with enough detail to identify them (unit serial, order ref,
ticket subject). Steps 1 and 2 still run — an FK or email link is unambiguous
regardless of how many people share a name.

### Blank names

When the old name is blank the name branch has nothing to match, so it is
skipped and no ambiguity check is needed. Steps 1 and 2 still propagate, which
means naming a previously nameless customer backfills their existing tickets,
orders and units. This is the main path for clearing the 55 nameless customers
the Journey tab currently chases with name-collection emails.

A rename **to** a blank name is rejected. Emptying both fields would erase the
join key that steps 1–3 depend on and cannot be undone by the same UI.

## The RPC

```sql
public.rename_customer(
  p_customer_id uuid,
  p_first_name  text,
  p_last_name   text,
  p_dry_run     boolean default false
) returns jsonb
```

`SECURITY INVOKER`, so the caller's own `is_internal_user()` RLS governs every
write — the function grants no privilege the operator lacks.

Behaviour:

1. Load the customer; raise if not found.
2. Compute `old_name` from the current `full_name` and `new_name` from the
   trimmed arguments. Raise if `new_name` is empty.
3. Determine `ambiguous` by counting other customers sharing `old_name`
   (skipped when `old_name` is blank).
4. Walk a **static per-table config** — `(table, pk column, has customer_id, has
   customer_email)` — building each table's target predicate once from the
   ladder above. Dry run counts the matched rows; a real run updates them. The
   single predicate builder is what guarantees the preview and the apply cannot
   diverge.
5. On a real run, update `customers.first_name` / `last_name` last, so a failure
   in any cascade aborts the rename rather than leaving the customer renamed
   with stale copies behind.

Return shape:

```json
{
  "old_name": "Dhruv Talwar",
  "new_name": "Dhruv Talwer",
  "ambiguous": true,
  "updated": { "service_tickets": 8, "orders": 4, "units": 3, "fulfillment_log": 2 },
  "skipped": [
    { "table": "units", "id": "LILA-0142", "label": "shipped 2026-03-11" }
  ]
}
```

`updated` omits tables with a zero count. `skipped` is empty unless `ambiguous`
is true.

## Client layer

`app/src/lib/customers.ts` gains two thin wrappers over the one RPC, differing
only in `p_dry_run`:

```ts
export type CustomerRenameResult = {
  old_name: string;
  new_name: string;
  ambiguous: boolean;
  updated: Record<string, number>;
  skipped: Array<{ table: string; id: string; label: string }>;
};

export async function previewCustomerRename(
  customerId: string, firstName: string, lastName: string,
): Promise<CustomerRenameResult>;

export async function renameCustomer(
  customerId: string, firstName: string, lastName: string,
): Promise<CustomerRenameResult>;
```

`renameCustomer` calls `logAction('customer_renamed', customerId, '<old> → <new>
(N records)', { entityType: 'customer', entityId: customerId })` on success,
matching how `updateCustomerContact` logs today. `previewCustomerRename` logs
nothing.

Components keep calling `lib/` only — no component imports `supabase` directly.

## UI

New file `app/src/modules/Customers/NameSection.tsx`, imported by
`modules/Customers/index.tsx` and rendered immediately above the existing
`ContactSection` in `CustomerDetailPanel`. It goes in its own file rather than
into `index.tsx` because that file is already 1070 lines and this feature brings
its own dialog state.

Flow:

1. Collapsed: shows First name / Last name with an "Edit name" button, matching
   `ContactSection`'s collapsed/editing pattern.
2. Editing: two text inputs. Save is disabled until a field changes.
3. Save calls `previewCustomerRename` and opens a confirm dialog listing the
   per-table counts and, when `ambiguous`, the skipped rows with an explanation
   that another customer shares this name.
4. Confirming calls `renameCustomer`, then `onChanged()` to refresh the list.
5. Cancel at either step discards the draft.

Errors from either call render in the section, reusing `styles.toastError`.

The panel title, the directory row, and every other screen reading the customer
update themselves through the generated `full_name` column over the existing
realtime subscription. No other component changes.

## Testing

Vitest, alongside the existing `lib/customers.test.ts` and module tests:

- `previewCustomerRename` / `renameCustomer` pass `p_dry_run` correctly and
  surface RPC errors as thrown `Error`s.
- `renameCustomer` logs `customer_renamed`; `previewCustomerRename` logs nothing.
- `NameSection` disables Save until a field changes, shows the confirm dialog
  with counts from the preview, applies only on confirm, and writes nothing on
  cancel.
- The skipped-rows warning renders when `ambiguous` is true.

The SQL is validated against the live DB (`LILA-Pro-Inventory`,
`txeftbbzeflequvrmjjr`) — Vitest cannot exercise plpgsql:

- A dry run returns counts and leaves every table byte-identical.
- Renaming a customer with an FK link updates the FK-matched and email-matched
  rows.
- Renaming one of the four duplicate-name pairs leaves the other person's rows
  untouched and reports them under `skipped`.
- Naming a nameless customer backfills their FK- and email-linked rows.
- A rename to two blank fields is rejected.

## Deployment

The RPC ships as a migration under `supabase/migrations/`. Migrations in this
repo are gated behind the manual workflow rather than applied on push, so the
migration must be run before the UI works. The frontend deploys to lila.vip on
push to `main` as usual.

## Out of scope

- Merging two customer records into one. That is the neighbouring problem when
  the duplicate-name pairs turn out to be the same person, but it is a different
  feature with different semantics and its own spec.
- Editing names anywhere other than the customer directory panel.
- Writing the corrected name back to HubSpot, Shopify or Klaviyo. makelila is
  the system of record; outbound sync is a separate decision.
