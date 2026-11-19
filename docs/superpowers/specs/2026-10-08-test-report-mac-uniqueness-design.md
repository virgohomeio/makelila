# Stock: ESP32 MAC capture + duplicate detection on test-report upload — design

**Date:** 2026-10-08
**Module:** Stock (LILA Units tab) — test-report uploader, unit table, QC modal
**Status:** built on branch feat/test-report-mac-uniqueness; migration not yet applied.

## Problem

Every electrical test report the ESP32 test script writes carries the board's
MAC right under the serial:

```
**Serial Number:** LL01-00000000332
**MAC ID:** 98:a3:16:a6:97:b0
```

The uploader (`app/src/lib/testReports.ts:19` `parseTestReport`) reads only the
serial and the pass/fail summary. The MAC is thrown away, and `units` has no
column for it. So nothing can tell when the same ESP32 shows up under two
different serials — a mislabelled machine, a report renamed to the wrong
serial, or one board tested twice as two units. Each of those silently writes a
pass/fail to a unit it does not belong to.

We want the MAC captured on every upload, stored on the unit, and any MAC that
appears on more than one unit made visible: at upload time and afterwards in
the Stock table, until someone corrects it.

## Decisions already taken

- **Duplicates do not block pairing.** The file still updates its unit's
  electrical result and MAC; the clash is surfaced as a warning and as a
  visible flag on the units involved.
- **Forward only.** Reports uploaded before this ships are not re-read. Their
  units keep a null MAC until someone re-uploads the report or types the MAC
  into the QC modal. No backfill button, no edge function.
- **The flag is derived, not stored.** The only new column is
  `units.mac_address`. "Duplicate" means another unit holds the same MAC, and
  is computed from the loaded units list. Fixing the MAC on either unit clears
  the flag on both. There is nothing to dismiss and nothing that can go stale.
- **Scrapped and lost units still count as owners.** A board salvaged from a
  scrapped unit shows as a duplicate until the operator clears the MAC on the
  scrapped unit in its QC modal. That is one click and keeps the rule simple.

## Data

One migration, `supabase/migrations/20261008120000_units_mac_address.sql`:

```sql
-- ESP32 MAC parsed from the uploaded electrical test report (or typed in the
-- QC modal). Normalised lowercase "xx:xx:xx:xx:xx:xx". Deliberately NOT unique:
-- a board salvaged from one unit may legitimately reappear in another, and
-- duplicate detection is derived in the app from the loaded units list.
alter table public.units
  add column if not exists mac_address text;

create index if not exists idx_units_mac_address
  on public.units (mac_address)
  where mac_address is not null;
```

`app/src/lib/stock.ts`:

- `Unit` (`stock.ts:86`) gains `mac_address: string | null;` next to the
  test-report fields.
- `updateUnitFields` (`stock.ts:304`) adds `'mac_address'` to its `Pick<>` so
  the QC modal can save it through the existing path, with the existing
  `stock_edit` activity log entry.
- New pure helper, exported and unit-tested:

  ```ts
  /** serial → other serials holding the same mac_address. Units with no MAC
   *  are never in the map. Empty map when every MAC is unique. */
  export function findMacDuplicates(units: Pick<Unit, 'serial' | 'mac_address'>[]): Map<string, string[]>
  ```

## Parsing (`app/src/lib/testReports.ts`)

- New pure helper `normalizeMac(raw: string | null | undefined): string | null`.
  Accepts six hex octets separated by `:` or `-` in any case, optional
  surrounding whitespace, and returns lowercase colon form. Anything else
  (five octets, non-hex, empty) returns null.
- `ParsedTestReport` (`testReports.ts:7`) gains `mac: string | null`.
- `parseTestReport` reads the first line matching
  `MAC (ID|Address)?:` with optional `**` bold markers around the label — the
  same tolerance the `Serial Number:` match already has — and passes the
  captured value through `normalizeMac`. Missing or garbled → `null`, never an
  error. The per-test and summary parsing is untouched.

## Upload flow (`uploadTestReports`, `testReports.ts:59`)

Signature becomes

```ts
uploadTestReports(files: File[], validSerials: Set<string>, macOwners: Map<string, string>)
```

`macOwners` is `mac_address → serial` for every loaded unit that has a MAC,
built in `UnitsTab.tsx:21` next to `validSerials` with the same `useMemo`
pattern. No extra database round trip.

Per file, after the serial is found valid:

1. `mac = parsed.mac`.
2. Clash check, in this order, only when `mac` is non-null:
   - `owner = macOwners.get(mac)`; a clash if `owner` exists and
     `owner !== serial`.
   - Otherwise `owner = seenThisDrop.get(mac)` (a local `Map` filled as files
     pair); a clash if it exists and is a different serial.
   Same serial re-uploaded with the same MAC is not a clash. Same serial with a
   new MAC is a board swap and simply overwrites.
3. The `units` update gains `mac_address: mac` only when the report carries a
   MAC. A report without one leaves the column untouched, so a MAC typed into
   the QC modal is never wiped by an older-script report (the repo's
   "inputs never clobber operator-curated data" default).
4. `seenThisDrop.set(mac, serial)` after a successful write.
5. Activity log:
   - the existing `unit_test_report` entry's detail becomes
     `"<result> mac=<mac>"` (or just `<result>` when there is no MAC);
   - on a clash, an extra
     `logAction('unit_mac_duplicate', serial, 'mac=<mac> also on <owner>', { entityType: 'unit', unitSerial: serial })`.

`UploadOutcome` (`testReports.ts:48`) gains

```ts
mac?: string | null;     // normalised MAC from the report, null when absent
macClash?: string;       // the other serial that already holds this MAC
```

`status` stays `'paired'` on a clash. Unmatched and error outcomes are
unchanged.

## Uploader results panel (`app/src/modules/Stock/TestReportUploader.tsx`)

- Prop `macOwners: Map<string, string>` added beside `validSerials`.
- The paired summary line is unchanged.
- A new warning list (new `styles.reportWarnings`, amber, same shape as
  `reportProblems`) renders one line per paired outcome with `macClash`:
  `⚠ LL01-00000000099 → MAC 98:a3:16:a6:97:b0 is already on LL01-00000000005`.
- Paired outcomes whose `mac` is null get a quieter line in the same list:
  `LL01-00000000099 → no MAC ID in report`.

## Stock table (`app/src/modules/Stock/UnitTable.tsx`)

- `UnitsTab` computes `macDupes = findMacDuplicates(units)` in a `useMemo` and
  passes it to `UnitTable` as a prop; `macOwners` goes to the uploader.
- In the QC cell (`UnitTable.tsx:72` column), when `macDupes.has(u.serial)`,
  render a small red pill `DUP MAC` after the existing electrical/mechanical
  pills. Its `title` lists the other serials. New `styles.qcDupMac` class
  reusing the FAIL colours from `QC_CHECK_META.fail`.
- The Notes column logic (`UnitTable.tsx:89`) is untouched.
- Search in `UnitsTab.tsx:49` also matches `u.mac_address`, so typing a MAC
  shows every unit holding it.

## QC modal (`QcEditorModal`, `UnitTable.tsx:435`)

- New field "MAC address" directly under "Firmware version"
  (`UnitTable.tsx:483`), same `modalInput` styling, placeholder
  `e.g. 98:a3:16:a6:97:b0`.
- On save the value goes through `normalizeMac`; an invalid non-empty value
  blocks the save with the existing `onError` path
  (`MAC must be six hex pairs, e.g. 98:a3:16:a6:97:b0`). Empty clears the
  column.
- When the unit is in `macDupes`, helper text under the field reads
  `Also on LL01-00000000005` (comma-joined when several).
- `QcEditorModal` receives `otherSerials: string[]` from the table row.

## Error handling

- Parsing never throws on a bad or missing MAC.
- A failed `units` update is reported per file exactly as today (`status:
  'error'`); the clash check happens before the write and does not change the
  error path.
- The QC modal's own validation is the only place a MAC is rejected, and only
  for a value the operator typed.

## Testing

All pure logic is unit-tested with Vitest. Run with the Supabase env vars
passed inline (see the project memory on vitest env vars).

- `app/src/lib/__tests__/testReports.test.ts`
  - `normalizeMac`: colon form, dash form, uppercase → lowercase, surrounding
    whitespace, five octets → null, non-hex → null, empty → null.
  - `parseTestReport`: bold `**MAC ID:**`, plain `MAC ID:`, `MAC Address:`,
    missing → `mac: null`; existing serial/summary assertions still pass with
    the sample that already includes a MAC line.
  - `uploadTestReports` with `./supabase` and `./activityLog` mocked (pattern
    from `app/src/lib/customers.search.test.ts`):
    - MAC on a different serial in `macOwners` → `paired`, `macClash` set,
      `mac_address` still written, `unit_mac_duplicate` logged;
    - two files in one drop with the same MAC and different serials → second
      one clashes with the first;
    - same serial, same MAC as in `macOwners` → no clash;
    - report without MAC → `mac: null`, no clash, and `mac_address` absent
      from the update patch.
- `app/src/lib/stock.test.ts` (existing file): `findMacDuplicates` — unique
  MACs → empty map; two sharing → both present with each other; three sharing
  → each lists the other two; null MACs ignored.
- Component behaviour (pill, warning list, modal field) is covered by a
  `UnitTable` render test only if a cheap existing harness fits; otherwise it is
  verified by hand against the dev server with a two-file drop.

## Out of scope

- Backfilling MACs from reports already in the `test-reports` bucket.
- A database unique constraint or trigger on `mac_address`.
- Any Build-module or Parts-module tracking of ESP32 boards.
- Showing the MAC as its own table column (it is searchable and in the modal).

## Files touched

- `supabase/migrations/20261008120000_units_mac_address.sql` (new)
- `app/src/lib/stock.ts` — `Unit.mac_address`, `updateUnitFields` pick,
  `findMacDuplicates`
- `app/src/lib/stock.test.ts` — `findMacDuplicates` cases
- `app/src/lib/testReports.ts` — `normalizeMac`, `ParsedTestReport.mac`,
  `parseTestReport`, `uploadTestReports`, `UploadOutcome`
- `app/src/lib/__tests__/testReports.test.ts`
- `app/src/modules/Stock/UnitsTab.tsx` — `macOwners`, `macDupes`, search
- `app/src/modules/Stock/TestReportUploader.tsx` — prop + warning list
- `app/src/modules/Stock/UnitTable.tsx` — pill, modal field, `otherSerials`
- `app/src/modules/Stock/Stock.module.css` — `reportWarnings`, `qcDupMac`,
  modal helper text
