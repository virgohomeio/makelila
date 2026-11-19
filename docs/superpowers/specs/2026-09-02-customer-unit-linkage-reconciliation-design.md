# Customer↔unit linkage: reconcile the Directory to Stock — design

**Date:** 2026-09-02
**Modules:** Customers (Directory tab), Stock (LILA Units + Unlinked units tabs), `lib/customers.ts`, `lib/stock.ts`
**Status:** designed, not built.

## Problem

The Customer Directory and the Stock tab disagree about which machine belongs to
which customer, because they read two different columns and only one of them is
maintained.

**Stock** (`Stock/UnitTable.tsx:146`, `Stock/UnitsTab.tsx:50`) renders
`units.customer_name` — free text, edited inline, no status filter. It never
reads `customer_id`.

**Directory** (`Customers/index.tsx:104-124`) filters to `status = 'shipped'`
and resolves through a three-step chain: `units.customer_id` → lowercase
name match → `customers.serials`.

Measured against the live DB (`txeftbbzeflequvrmjjr`) on 2026-09-02, of **175
shipped units**:

- **158** are FK-linked, **17** carry a name with no FK, **0** are nameless.
- The name-fallback step **never fires**. 16 of those 17 match no `customers`
  row at all; the 17th (`LL01-…039`, Kevin Cheng) is suppressed because the `??`
  chain short-circuits — Kevin Cheng already has an FK entry, so his real unit
  is silently dropped and he is shown holding `LL01-…341` instead.
- **9 FKs point at the wrong customer**, all with
  `backfill_source = 'fulfillment-20260621'`.

### Why Stock is the more current record

`units.customer_id` was set once by the June 2026 backfill and has never been
maintained — there is no `stock_link_customer` entry in `activity_log` at all.
`units.customer_name` and `units.status` are actively maintained by Junaid, who
is the dominant Stock editor (29 `stock_status` + 29 `stock_edit` entries,
through 2026-09-01; Huayi 11, Reina 1, Raymond 1).

Every status transition Junaid made *after* the `customers.serials` cache was
synced on 2026-06-05 is a unit the Directory still shows as held:

| Unit | Transition | Directory still shows under |
|---|---|---|
| …302 | shipped → ready, 06-29 | Ron Russell |
| …285 | shipped → ready, 08-13 | Lisa Clarke |
| …145 | shipped → scrap, 09-01 | Amanda McCordic |

Worst case: `LL01-…258` has an explicit `unit_reassigned` entry (2026-07-22,
*"Reassigned to Béatrice (IP-UOF-258); removed from prior mis-recorded owner"*)
and the cache still shows it under Oluseyi Adeniran — the exact owner Junaid
corrected two months ago.

### Why the literal fix is wrong

"Copy `customer_name` onto `customer_id`" would regress data that is currently
correct. The 18 shipped units where the two tabs disagree are not one problem:

| Bucket | Count | Serials | Correct action |
|---|---|---|---|
| Stock right, FK wrong | 5 | …291, …300, …301, …310, …316 | Repoint FK |
| FK right, Stock loose | 7 | …005, …022, …049, …144, …147, …203, …236 | **No change** |
| Same person, `(test)` suffix | 2 | …253, …298 | No FK change |
| Genuinely contested | 4 | …254, …274, …278, …341 | Triage |

Bucket 2 is household naming — `Mary Oskamp` vs `Mary & Marilynne Oskamp`,
`Chunli Wu` vs `Annie Chunli Wu`. The FK is right and **the Directory is the
better record**. Bucket 1 is distinguishable from bucket 2 by evidence: in all
5, the Stock-named person is a real customer *with their own orders*.

## Design

### 1. Name matcher — `app/src/lib/customerNameMatch.ts` (new)

Pure functions, no Supabase import, unit-testable in isolation.

`customers.full_name` is a **generated column**:

```
TRIM(BOTH FROM ((COALESCE(first_name,'') || ' ') || COALESCE(last_name,'')))
```

and in practice `first_name` holds the entire string with `last_name` null. So
first/last component matching does not work — normalise the whole string on
**both** sides:

- strip parentheticals — `Louis DiPalma (test)`, `Yun Feng Zhang (William)`,
  and the record literally named
  `Rongbin Sun (2 units, only delivering 1 white) (Kevin will be the receiver)`
- strip leading honorifics — `Mr. Phil Parkinson`, `Ms. Yuanbo Luo`
- strip trailing sequence digits — `Camp Jubilee 2`
- collapse internal whitespace, casefold, trim

Exports:

```ts
export function normalizeCustomerName(raw: string): string;
export type MatchConfidence = 'exact' | 'normalized' | 'ambiguous' | 'none';
export function matchUnitToCustomer(
  unitName: string,
  customers: Pick<Customer, 'id' | 'full_name'>[],
): { customerId: string | null; confidence: MatchConfidence; candidates: string[] };
```

Only `exact` and `normalized` may auto-apply. `ambiguous` (more than one
normalised hit) and `none` must fall through to human triage — never guess.

### 2. Reconciliation migration

`supabase/migrations/20260902130000_reconcile_unit_customer_links.sql`. Applies
only high-confidence changes:

**5 repoints** — bucket 1 above, FK moved to the Stock-named customer.

**9 new links** for previously unlinked units:

| Serial(s) | Unit name | Resolves to | Via |
|---|---|---|---|
| …039 | Kevin Cheng | Kevin Cheng | exact |
| …006, …024 | Rongbin Sun | `Rongbin Sun (2 units…)` | parenthetical strip |
| …031 | Yun Feng Zhang | `Yun Feng Zhang (William)` | parenthetical strip |
| …060 | Phil Parkinson | `Mr. Phil Parkinson` | honorific strip |
| …137 | Yuanbo Luo | `Ms. Yuanbo Luo` | honorific strip |
| …311, …324, …313 | Camp Jubilee 1/2/3 | David Duckworth (`duckworth@campjubilee.ca`) | institutional grouping |

The `Rongbin Sun (2 units…)` annotation independently corroborates that both
…006 and …024 belong to that record.

**…341** → `is_team_test = true`, `customer_id = null`. It is Junaid's office
machine (`customer_name` set to `Junaid Siddiqui - Office Machine` on
2026-09-01), not a customer shipment.

**No change** to buckets 2 and 3 — those FKs are already correct.

Every write calls `logAction()` per the repo convention. Each `UPDATE` is
guarded on the value the audit recorded — e.g. the 5 repoints match on the
current (wrong) `customer_id` and the 9 links match on `customer_id IS NULL` —
so if an operator corrects a row between now and the migration running, that
row is skipped rather than clobbered.

**Expected result:** correctly attributed shipped units **149 → 163 of 175**.
The remaining 12 become explicitly queued rather than silently wrong.

### 3. Directory read path

In `Customers/index.tsx`:

- **Drop `c.serials` from the resolution chain entirely.** It is the step that
  resurrects corrections Junaid already made.
- **Merge the FK and name maps instead of `??`-ing them.** The current
  `serialsByCustomerId.get(c.id) ?? serialsByCustomerName.get(…)` means any
  customer with at least one FK-linked unit has their name-matched units
  silently dropped — that is the latent bug that hides Kevin Cheng's real unit
  today, and it would keep hiding a second machine from any multi-unit customer
  whose units are only partly linked. Union the two sets and de-duplicate by
  serial.
- Keep the `status = 'shipped'` filter. Stock's status breadth is deliberately
  *not* mirrored — the Directory answers "what does this customer currently
  hold", and `rework`/`scrap`/`ready`/`team-test` all mean the unit is back
  with us.
- Fix `index.tsx:927` so the detail panel applies the same shipped filter as
  the list row. Today they disagree, so opening a customer shows returned units
  the row deliberately hid.

`customers.serials` remains read by `lib/lovelyVerification.ts` (an
`.overlaps()` query) and `JourneyTab.tsx`. Both stay exposed to staleness and
are **out of scope here** — noted so the next person doesn't assume the cache
is fully retired.

### 4. Stop the re-drift

The Stock editor writes `customer_name` and never sets `customer_id`
(`Stock/UnitTable.tsx:243`), which is how the divergence opened in the first
place. `linkUnitToCustomer()` exists at `lib/stock.ts:267` and is called only
from the Unlinked units tab.

On unit save: run the matcher; set `customer_id` when confidence is `exact` or
`normalized`; otherwise leave it null so the unit surfaces in Unlinked units.
Without this the same divergence rebuilds within months.

### 5. Triage surface

`Stock/OrphanUnitsTab.tsx` ("Unlinked units", backlog #69) already lists
`customer_name != null && customer_id == null && !is_team_test` with a customer
picker. Add a **suggested match** column driven by the matcher, showing its best
candidate and confidence, so the 11 residual units arrive pre-populated instead
of as a blank picker.

Residual after the migration: …036 Bryan Ho (Dan Tran), …075 Caroline & Mike
McMaurice, …033 David Foster, …038 Kelley Gonsalves, …119 Olivia Amaro, …146
Salvatore DeCillis & Julia, …073 Tony Rinello, …030 Tony Wang, plus contested
…254, …274, …278.

## Testing

- **Matcher unit tests** (`lib/customerNameMatch.test.ts`), one case per bucket
  above, including the adversarial ones. `Rongbin Sun` resolves *uniquely* to
  the annotated record — the two bare `Rongbing Sun` rows are spelled
  differently and do not collide with it — so the genuine ambiguity case is a
  unit named `Rongbing Sun`, which ties across two identical records and must
  return `ambiguous` rather than guess. `Mary Oskamp` must not match
  `Mary & Marilynne Oskamp` (that link is already correct and must survive
  reconciliation untouched).
- **Migration assertion** — before/after counts of correctly-attributed shipped
  units, failing loudly if the after-count is not 163.
- **Directory tests** — a customer whose only serial came from `c.serials` now
  renders empty rather than a phantom; list row and detail panel agree.
- `npm test` and `npx tsc -b` both green before push. A type error in a test
  file fails the Pages deploy, so `tsc --noEmit` alone is not sufficient.

## Out of scope, flagged

- Three near-duplicate `Rongbin/Rongbing Sun` customer records need merging.
  Deletes only stick if the survivor absorbs `hubspot_id`/`email`, and five
  child tables CASCADE — that is its own task.
- `…253` and `…298` (`Louis DiPalma (test)`, `Brent Neave (test)`) are both
  `is_team_test = false` and probably should not be. Junaid's call, not a
  migration's.
- The 5 contested serials have service tickets naming two different people at
  different dates, consistent with units genuinely changing hands. Nothing in
  the schema records ownership history; `unit_reassigned` exists as an
  `activity_log` type with exactly one row. A real fix is a units-ownership
  history table.
