# Fulfillment-sheet import

On-demand importer that mirrors the **“LILA customer fulfillment.xlsx”** Google-Drive
workbook into the `public.fulfillment_log` table (Supabase project `LILA-Pro-Inventory`,
ref `txeftbbzeflequvrmjjr`).

- **Source:** uploaded `.xlsx` (kept as Excel because other services update it).
- **Read auth:** the `make-lila-bot@lila-api-393822.iam.gserviceaccount.com` service
  account (shared as Viewer on the sheet). The JSON key lives at `.secrets/lila-bot.json`
  (gitignored). The sheet is read via the Drive API (`alt=media`) and parsed in-process —
  no npm deps, no Sheets API (which can't read `.xlsx` blobs).
- **Tabs imported:** `Canada Shipping`, `US Shipping`, `Replacement`, `Personal Delivery`.
- **Mapping:** explicit per-tab *column-position* maps (the sheet's header labels are
  drifted/unreliable). Excel serial dates → real dates; prices → numeric; the full
  original row is preserved verbatim in the `raw` jsonb column.
- **Idempotency:** upsert on `(source_tab, source_row)` — re-running refreshes in place.
  This is a verbatim **mirror/archive**, so refresh-on-conflict is intentional (a
  documented exception to the usual insert-only rule; see `CLAUDE.md` → System of record).

## Run

```bash
# from app/
SUPABASE_URL=https://txeftbbzeflequvrmjjr.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service_role_key> \
GSA_KEY_PATH=../.secrets/lila-bot.json \
SHEET_ID=11-AwPa-Yh9FW4zTSG1UO5etqBuSW8iOU \
npm run import:fulfillment
```

`--dry-run` parses and reports per-tab counts without writing. If
`SUPABASE_SERVICE_ROLE_KEY` is omitted, the script writes a `scripts/out/fulfillment_log.sql`
file instead of upserting (apply it by hand).

The service-role key is in the Supabase dashboard → **Project Settings → API → `service_role`**
(or `supabase login && supabase projects api-keys --project-ref txeftbbzeflequvrmjjr`).

## Future: make it fully scheduled

To run on a cron like the other syncs, port this into a Supabase Edge Function
(`supabase/functions/import-fulfillment-sheet/`) using the existing JWT→OAuth helper
pattern from `sync-gmail-tickets`, store the SA key as the `GOOGLE_SHEETS_SA_KEY` secret,
and add a `pg_cron` job. The parsing/mapping logic here ports directly to Deno.
