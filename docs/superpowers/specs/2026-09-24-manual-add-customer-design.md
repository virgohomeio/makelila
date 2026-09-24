# Manually adding a customer record — design

**Date:** 2026-09-24
**Module:** Customers › Directory
**Operator ask:** "I want to be able to manually add a customer record in the Customers module, in Directory, if I need."

## Problem

Every row in `public.customers` today arrives from a sync — HubSpot, Shopify
orders, or a backfill script. There is no way for an operator to type in a
customer who exists in the real world but not yet in any of those systems: a
phone lead, a trade-show contact, a household member who needs their own record,
a warranty claim on a machine sold outside Shopify. The operator's only options
are to wait for a sync that may never carry the person, or to create a stub
somewhere else and let it drift.

## What we're building

An **Add customer** action on the Directory tab that opens a small form and
writes one `customers` row.

### Fields

The form captures exactly what the Directory list and its search read:

| Field | Column | Required |
|---|---|---|
| First name | `first_name` | at least one name field |
| Last name | `last_name` | — |
| Email | `email` | no |
| Phone | `phone` | no |
| Street address | `address_line` | no |
| City | `city` | no |
| Province / State | `region` | no |
| Postal / ZIP | `postal_code` | no |
| Country | `country` | no |

Everything else on the record — colour, follow-up state, journey stage,
purchaser link, household users — stays where it already is, in the customer
panel, and is edited after the record exists. The form is for creating a
record, not for filling one in.

### Rules

1. **A name is required.** At least one of first/last must be non-blank; a row
   whose `full_name` is the empty string is unfindable in a directory sorted and
   searched by name.

2. **`full_name` is never written.** It is `GENERATED ALWAYS AS (trim(coalesce(first_name,'')
   || ' ' || coalesce(last_name,'')))`. The form writes `first_name` /
   `last_name` only, and putting a whole compound name ("James & Jill
   Washington") in the first-name box with last name blank is a legitimate entry
   — the same shape many synced rows already have.

3. **Email is optional but must be plausible and unused.** If given, it is
   lowercased and trimmed, checked against `isPlausibleEmail`, and checked for a
   case-insensitive clash with any existing customer. A clash is refused with a
   message naming the existing customer — email is the key this app matches
   orders, tickets and refund cards on, so two rows sharing it would silently
   merge two people's histories. (There is also a unique index on
   `customers.email`, so the DB would reject it anyway with a far worse message.)

4. **Blank means NULL.** Every optional field is trimmed and stored as NULL when
   empty, so a manually-added row is indistinguishable from a synced one to the
   "no email" / "no address" filters.

5. **`last_synced_at` stays NULL.** The row was not synced. This keeps the
   header's "synced from HubSpot <date>" honest, and lets a future sync fill
   blanks on it the way it fills blanks on any other row (insert-only-on-conflict
   is the repo default; a manual row with an email will be matched, not
   duplicated, by `hubspot_id`/email matching on the next sync).

6. **The write is logged.** `logAction('customer_created', …)` with the new
   customer's id, same as every other mutation in this module.

### Flow

Directory header → **Add customer** (beside Sync from HubSpot) → modal form →
Save → the list refreshes, a toast confirms, and the new customer's panel opens
so the operator can keep filling in the record without hunting for the row they
just made.

Cancel, Escape, or a click on the backdrop closes without writing.

## Architecture

**`lib/customers.ts`**

- `NewCustomerInput` — the nine form fields, all `string`.
- `normalizeNewCustomer(input): NewCustomerRow` — pure. Trims every field,
  lowercases email, maps blanks to `null`, throws on a missing name or an
  implausible email. Unit-tested directly; no Supabase.
- `createCustomer(input): Promise<string>` — normalizes, runs the email-clash
  query, inserts, logs, returns the new id.

Splitting the pure half out is what makes the rules above testable without a
database, and matches how `updateCustomerContact` / `previewCustomerRename`
already separate validation from the write.

**`modules/Customers/AddCustomerForm.tsx`** — a self-contained right-hand
drawer, the same object as the customer panel it opens into rather than a
lookalike centred modal. Owns its own draft state and error string; calls
`createCustomer` and hands the new id up. A rejected save keeps the draft — the
likeliest rejection is a duplicate email, and clearing ten typed fields to
report it is worse than the duplicate.

**`modules/Customers/AddCustomerForm.module.css`** — the form's own furniture
(labels, field pairs, actions, error box). A separate module because
`Customers.module.css` is a single 66KB sheet carrying two design regimes, where
a class name declared twice silently loses to the later block; styles only this
drawer uses have no reason to compete for names in there. The drawer *chrome*
(`.panelBackdrop`, `.panel`, `.panelHeader`, `.panelBody`, `.section`,
`.searchInput`, `.linkBtn`) is still borrowed from `Customers.module.css`.

**`modules/Customers/index.tsx`** — one `showAdd` boolean, the header button, and
an `onCreated` handler that refreshes the list, toasts, and selects the new row.

## Not doing

- **No migration.** `customers_insert` already grants INSERT to any
  authenticated internal user, and every column the form writes exists.
- **No duplicate-name warning.** Two customers legitimately share a name (the
  directory already handles this everywhere), and the email check covers the
  case that actually corrupts data.
- **No HubSpot push.** makeLILA is the system of record; a manually-added
  customer does not need to exist in HubSpot to be usable here, and a one-way
  push would be a new sync direction that the system-of-record doc doesn't
  sanction.

## Testing

- `lib/customers.newCustomer.test.ts` — the pure normalizer: name required,
  compound name in `first_name` survives, blanks become NULL, email lowercased,
  implausible email rejected, `full_name` never in the output.
- `modules/Customers/__tests__/AddCustomerForm.test.tsx` — Save disabled without
  a name, a rejected save shows its message and does not close, a good save
  reports the new id.
