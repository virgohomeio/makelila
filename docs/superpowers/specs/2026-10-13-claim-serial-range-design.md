# Build: claim a range of serials under a batch + PO — design

**Date:** 2026-10-13
**Module:** Build (Stock › Build tab) — claim dialog, PO card; `units` table
**Status:** designed, not built.

## Problem

A unit only exists in makeLILA once its serial is claimed into a batch, and the
only way to do that is Build's "+ Claim serial" dialog
(`app/src/modules/Build/index.tsx:73-91`), one serial at a time. A China test
batch arrives as a block of 90 consecutive serials (511–600, 601–690, 691–780),
so every batch means 90 trips through the dialog before its test reports can be
uploaded — the report uploader skips any serial that is not yet a unit.

Separately, units record only their batch. A purchase order
(`factory_orders`, `supabase/migrations/20260513200000_build_module_schema.sql`)
names its batch, but no unit records which PO it came from. `assignSerial`
(`app/src/lib/build.ts`) already accepts a `po_id` and silently drops it.

We want to create a whole serial range in one action, under one batch, linked to
one PO.

## Decisions already taken

- **Units get a PO link.** New nullable `units.po_id`.
- **Input is a first and last serial.** Every China batch so far has been one
  unbroken range. No paste-a-list mode.
- **Existing serials are never moved or overwritten.** One exception: an existing
  unit in the *same batch* with *no PO yet* gets this PO filled in. Everything
  else is skipped with a reason.
- **App data layer, not a database function.** One read, one insert, one update,
  in `lib/build.ts`, following the repo's mutation pattern and logging through
  `logAction`.

## Data

Migration `supabase/migrations/20261013120000_units_po_id.sql`:

```sql
alter table public.units
  add column if not exists po_id uuid
    references public.factory_orders(id) on delete set null;

create index if not exists idx_units_po_id
  on public.units (po_id)
  where po_id is not null;
```

No RLS change: `units_insert` / `units_update` already allow any internal user
(`20260604200000_rls_internal_only.sql:412-419`).

`Unit` (`app/src/lib/stock.ts`) gains `po_id: string | null`.

## Serial helpers (`app/src/lib/build.ts`)

- `SERIAL_PREFIX = 'LL01-'`, `MAX_CLAIM_RANGE = 500`.
- `formatSerial(n: number): string` → `LL01-` + 11-digit zero-padded number.
- `parseSerialInput(raw: string): number | null` — accepts `691`, `00000000691`,
  `LL01-00000000691`, any case, surrounding whitespace. Returns the positive
  integer, or null for anything else (empty, non-numeric, wrong prefix, more than
  11 digits, zero).

## Range planner (pure, `lib/build.ts`)

```ts
type RangeSkipReason = 'other_batch' | 'same_po' | 'other_po' | 'exists';
type RangePlan = {
  serials: string[];                        // every serial in the range, in order
  create: string[];                         // not yet a unit
  linkPo: string[];                         // same batch, po_id null, a PO was chosen
  skipped: { serial: string; reason: RangeSkipReason; detail?: string }[];
};

function planSerialRange(args: {
  from: number; to: number; batch: string; poId: string | null;
  existing: Pick<Unit, 'serial' | 'batch' | 'po_id'>[];
}): RangePlan
```

Throws `Error` when `from > to` or the range exceeds `MAX_CLAIM_RANGE`.

Per serial in the range:

| Existing unit | Result |
|---|---|
| none | `create` |
| different batch | skipped `other_batch`, detail = that batch |
| same batch, `po_id` null, PO chosen | `linkPo` |
| same batch, `po_id` null, no PO chosen | skipped `exists` |
| same batch, `po_id` = chosen PO | skipped `same_po` |
| same batch, `po_id` = another PO | skipped `other_po` |

The dialog runs this on the already-loaded `units` for a live preview. The
commit re-reads from the database and plans again, so the preview is only a
hint.

## Claim function (`lib/build.ts`)

```ts
type RangeClaimResult = {
  created: string[]; linked: string[];
  skipped: RangePlan['skipped'];
};

async function claimSerialRange(args: {
  from: number; to: number; batch: string; po: { id: string; po_number: string } | null;
}): Promise<RangeClaimResult>
```

1. Read existing units in the range with
   `.from('units').select('serial, batch, po_id').gte('serial', first).lte('serial', last)`.
   Serials are fixed-width zero-padded, so the text range is exact and avoids a
   500-item `in()` list in the URL.
2. `planSerialRange(...)`.
3. If `create` is non-empty: one `upsert(rows, { onConflict: 'serial', ignoreDuplicates: true }).select('serial')`
   with `{ serial, batch, status: 'ca-test', po_id }` per row. Only the returned
   serials count as created; a serial that appeared between read and write is
   moved to skipped `exists`. Insert-only on conflict, per the repo's
   system-of-record rule.
4. If `linkPo` is non-empty: one
   `.update({ po_id }).in('serial', linkPo).eq('batch', batch).is('po_id', null).select('serial')`.
   Only returned serials count as linked.
5. Activity log, in parallel:
   - per created serial: `logAction('serial_assigned', serial, batch, { entityType: 'unit', unitSerial: serial })`
     — identical to the single claim;
   - per linked serial: `logAction('unit_po_linked', serial, po_number, { entityType: 'unit', unitSerial: serial })`;
   - one summary: `logAction('serials_claimed_range', po_number ?? batch, '<first>–<last>: <c> created, <l> linked, <s> skipped')`.
6. Return the result.

A failed insert or update throws; nothing after it runs. The insert is a single
statement, so a range is never half-created.

`assignSerial` gains an optional `po_id` that it now actually writes (only set on
the row when provided).

## Dialog (`app/src/modules/Build/ClaimSerialsModal.tsx`, new)

The inline modal in `Build/index.tsx` moves into its own component, styled with
`Build.module.css` classes instead of inline styles. The Build header button
becomes **"+ Claim serials"**.

Props: `batches`, `orders` (factory orders), `units`, `onClose`.

Fields, top to bottom:

1. **Purchase order** — select: "No PO" plus every non-cancelled PO as
   `<po_number> · <batch>`. Picking a PO sets the batch to the PO's batch and
   disables the batch select. Picking "No PO" re-enables it.
2. **Batch** — select of `batches` (same source as today).
3. **Mode** — two toggle buttons: "One serial" / "Range".
4. One serial: one input (as today; full serial or number). Range: "First" and
   "Last" inputs.
5. **Preview** (range mode, when both ends parse): `N new · L to link · S skipped`.
   With a PO: `PO <po_number>: <after> of <qty_ordered> ordered after this`,
   where `after` = units already on the PO + new + linked. Over quantity shows
   the line in warning colour; it does not block.
6. **Errors** inline: unparseable serial, first after last, over 500, and a PO
   whose batch has no `batches` row (`units.batch` is an FK, so the insert would
   fail): "Batch <id> has no batch record yet. Add it on the LILA Units tab
   first." Any error disables the create button.
7. Buttons: **Create N units** (range) / **Create unit** (single), and Cancel.

After a range claim succeeds, the form is replaced by a result: created count,
linked count, and a skipped list (`serial — reason`), with a Close button.

## PO card count (`app/src/modules/Build/PipelineBoard.tsx:101`)

`unitsMadeCount` becomes
`units.filter(u => u.po_id === o.id || (u.po_id == null && u.batch === o.batch)).length`.
Identical to today while nothing is linked; exact once units carry their PO.

## Testing

Run vitest with the Supabase env vars inline.

- `app/src/lib/build.claimRange.test.ts` (new):
  - `parseSerialInput`: number, full serial, lowercase prefix, whitespace,
    rejects empty / letters / wrong prefix / 12 digits / zero.
  - `formatSerial`: pads to 11 digits.
  - `planSerialRange`: every row of the table above; from > to throws; 501
    serials throws; 500 does not.
  - `claimSerialRange` with `./supabase` and `./activityLog` mocked: insert
    payload carries batch, status `ca-test`, po_id; update filters on batch and
    null po_id; a serial missing from the insert's returned rows becomes skipped
    `exists`; log calls per created / linked serial plus one summary; no insert
    call when nothing is new.
- `app/src/modules/Build/__tests__/ClaimSerialsModal.test.tsx` (new): picking a
  PO locks the batch to the PO's batch; range preview counts against loaded
  units; over-quantity warning; first > last error; submit calls
  `claimSerialRange` with parsed numbers and the PO; single mode calls
  `assignSerial` with the PO id.
- `app/src/modules/Build/__tests__/batchSource.test.tsx`: updated for the
  "+ Claim serials" label; its batch-source assertions stay.

## Out of scope

- Showing a unit's PO in the Stock table or QC modal.
- Linking existing units to a PO outside a claimed range.
- Paste-a-list input.
- Enforcing PO quantity (warning only).

## Files touched

- `supabase/migrations/20261013120000_units_po_id.sql` (new)
- `app/src/lib/stock.ts` — `Unit.po_id`
- `app/src/lib/build.ts` — helpers, `planSerialRange`, `claimSerialRange`, `assignSerial` po_id
- `app/src/lib/build.claimRange.test.ts` (new)
- `app/src/modules/Build/ClaimSerialsModal.tsx` (new)
- `app/src/modules/Build/index.tsx` — use the new modal, button label
- `app/src/modules/Build/Build.module.css` — modal classes
- `app/src/modules/Build/PipelineBoard.tsx` — PO card count
- `app/src/modules/Build/__tests__/ClaimSerialsModal.test.tsx` (new)
- `app/src/modules/Build/__tests__/batchSource.test.tsx` — label
