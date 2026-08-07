# Refreshing the Shipping dashboard from a Freightcom export

Use this whenever the Shipping dashboard goes stale. It is the only way to update
it while the Freightcom API key remains a sandbox key — see
[docs/freightcom-live-credentials.md](../docs/freightcom-live-credentials.md).

## 1. Get the export

In the Freightcom **customer portal** (the web UI you book through, not the API),
open the shipments / tracking grid — the one whose Status column reads
"In Transit", "Delivered", "Ready for Shipping". Set the date range you want and
use its **Export / Download CSV** control.

Grab a **billing or invoice export** too if the portal offers one. The tracking
grid carries no cost column, which is why the shipments loaded from it show no
cost. The importer reads a cost column when one is present, so a billing export
is what fills the Rate (CAD) column.

## 2. Dry-run it first

```bash
node scripts/import-freightcom-tracking.mjs ~/Downloads/export.csv --dry-run
```

This writes nothing. Check that:

- the shipment count looks right,
- **Columns matched** lists `shipment_id`, `status`, `ship_to`, `ship_from` at
  minimum (the script refuses to run if any are missing),
- the printed first row looks like a real shipment.

If a column was not recognised, the script names it and exits. Add that export's
spelling to `FIELD_ALIASES` in [lib/freightcom-csv.mjs](lib/freightcom-csv.mjs) —
matching is by header name, not position, so a reordered grid is fine but a novel
header name needs one line added.

## 3. Import

```bash
SUPABASE_URL=https://txeftbbzeflequvrmjjr.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service role key> \
node scripts/import-freightcom-tracking.mjs ~/Downloads/export.csv
```

Then reload the Shipping dashboard.

## What it will and won't do

**Safe to re-run.** Keyed on `freightcom_shipment_id`. Existing shipments are
updated in place, new ones inserted.

**It cannot erase your data.** Empty cells are dropped before writing rather than
sent as nulls, so a sparse export never blanks a populated column — an
operator-entered tracking number, a carrier, a label URL and a rate all survive a
re-import that omits them. `raw_payload` is merged, not replaced, so the
provenance keys the dashboard derives **Customer** and **Direction** from are
preserved. This is verified end-to-end, not assumed.

**Status moves forward.** A shipment that reads "Delivered" in a newer export
updates from `in_transit` to `delivered`, and `freightcom_status` is set so the
dashboard's filter chips work. Labels the parser doesn't recognise are kept
verbatim and surface under the **Other** chip rather than being guessed at.

**It does not invent costs.** If the export has no cost column, Rate (CAD) is
left exactly as it was.

## Notes

- Inserts go by `POST`, updates by `PATCH`. That split is deliberate: PostgREST's
  upsert is an `INSERT ... ON CONFLICT`, and Postgres validates the proposed row
  first, so `carrier`/`service` (NOT NULL, no default) would have to be sent on
  every update — letting a sparse export overwrite a real carrier with an empty
  string. `PATCH` touches only the columns supplied.
- `match_shipment_serials()` and `match_shipment_orders()` run afterwards, so
  imported shipments link to their units and orders exactly as an API sync would.
- Parsing is covered by 32 tests in `app/src/lib/freightcomCsv.test.ts`
  (`cd app && npm test`).
