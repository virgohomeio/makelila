# Rural / remote addresses get a manual check before Sales can confirm

Date: 2026-09-24 · Module: Sales (`OrderReview`) · Owner: Huayi

## Problem

Sales already knows when an order is going somewhere rural or remote. Two
independent signals say so:

- `orders.area_type === 'rural'` — from the Canada Post FSA rule (`^[A-Z]0`),
  the operator-maintained remote-prefix list, the verify-address model, or an
  operator's own override.
- `orders.address_verdict === 'remote'` — the dwelling verdict, from the USPS
  record type `R` (rural route / highway contract) or an RR / general-delivery
  / concession / sideroad match on the street line.

Neither one asks anybody for anything. The rail paints a grey "Rural" tag, the
pre-confirm summary paints an amber Area row reading "rural or remote — the
carrier adds an extended-area surcharge and transit runs longer", and then the
order confirms exactly like a downtown Toronto house. The information is on
screen and the decision is not gated by it, which is the same failure mode the
pre-confirm panel was built to fix for postal codes and freight rates: a claim
nobody has to answer is a claim nobody reads.

A rural delivery is the one that most needs a person. The carrier may not
deliver to the address at all, the surcharge can be triple the quoted base
rate, and a pallet-sized composter on a rural route often needs an arrangement
(terminal pickup, a delivery appointment, a tail-lift) agreed with the customer
before the label is bought.

## Approach

A fourth confirm criterion, gated on an explicit operator acknowledgement.
This mirrors `sales_confirmed_fit` — the existing precedent for "a classifier
found something; a human has to sign off before this ships" — rather than
inventing a second mechanism.

Rejected alternatives:

- **Auto-flip `status` to `'flagged'`.** Literal, and needs no migration, but
  `flagged` is a human disposition today (the Flag button demands a typed
  reason). Writing it from a classifier makes the Flagged tab a mix of
  automation and judgement, and silently pulls rural orders out of the Pending
  queue nobody asked it to shrink.
- **Reuse the `sales_confirmed_fit` checkbox.** Zero migration, but one boolean
  would then mean two unrelated checks, and its label is about whether the unit
  fits the building, not about whether the carrier will drive the road.

## Design

### Trigger

```ts
needsRuralManualCheck(order) =
  order.kind === 'sale' && (order.area_type === 'rural' || order.address_verdict === 'remote')
```

Either signal is enough — they are independent, and each one alone is a reason
to look. Non-sale orders are exempt for the same reason the pre-ship criterion
exempts them: replacements are born approved in Fulfillment and never reach
this screen, but `canConfirm()` runs for every rail row and has to answer
honestly rather than block one.

A `'remote'` dwelling also trips the existing fit gate (everything but `house`
does), so such an order carries two checkboxes. That is correct, not
redundant — one asks whether the unit fits where it is going, the other
whether the carrier will take it there.

### Gate

`evaluateReadiness()` gains a fourth criterion, `rural`, with `reason4`. The
criteria count becomes per-order — `criteriaCount(order)` returns 4 when the
check is required and 3 when it is not — because a fixed `CRITERIA_COUNT` of 4
would tell every urban order it had a criterion it does not have. Every count
rendered anywhere still derives from that one function, which is why the
constant existed.

The blocker strip renders the fourth row only when it applies, with a
`Fix in Address →` jump like the other address blocker.

### Acknowledgement

Two new columns on `orders`:

- `rural_check_confirmed_at timestamptz` — when the check was signed off.
- `rural_check_confirmed_by uuid` — who, matching `dispositioned_by`'s shape.

Written by `setRuralCheckConfirmed(id, value)` in `lib/orders.ts` from a
checkbox in the Address card, directly under the existing fit checkbox.
`logAction('rural_check_confirmed' | 'rural_check_cleared', …)` on both
directions, so the audit trail carries who cleared it even though the card only
shows the date.

### Degradation before the migration runs

Migrations in this repo ship behind a manual workflow, so a push does not apply
them. `select('*')` against an un-migrated database returns rows without these
keys, so the fields are declared optional (`?:`) — the `reconciled_at`
precedent — and `undefined` is a distinct third state from `null`:

| state | meaning | blocks confirm |
| --- | --- | --- |
| `undefined` | the migration has not been applied | no — renders as a warning that passes |
| `null` | applied; nobody has checked this order | yes |
| a timestamp | an operator signed it off | no |

A rural order must not become unconfirmable because a migration is pending, so
the un-migrated state passes the criterion and says why. The checkbox is hidden
in that state rather than offering a write that would fail.

## Testing

`ReadinessChecklist.test.tsx` (new), table-driven over the criterion:

- urban / suburban / unclassified + `house` → not required, still 3 criteria.
- `area_type: 'rural'` → required, blocks, strip names it, Confirm disabled.
- `address_verdict: 'remote'` with a null `area_type` → required (the second
  signal alone is enough).
- rural + `rural_check_confirmed_at` set → passes, 4 of 4 met.
- rural with the key absent → passes, and the reason says the migration is
  pending.
- `kind: 'replacement'` + rural → not required.

`AddressCard.test.tsx` gains: the checkbox appears for a rural order, calls
`setRuralCheckConfirmed`, and is absent both for an urban order and for a rural
one on an un-migrated database.

Existing `Detail.test.tsx` counts stay at 3 — its fixture is suburban.
