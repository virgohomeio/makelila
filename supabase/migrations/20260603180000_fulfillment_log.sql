-- fulfillment_log: verbatim mirror of the "LILA customer fulfillment.xlsx"
-- Google-Drive workbook (manually maintained by the ops team, also updated by
-- other services). Each row = one shipped/delivered machine as recorded in the
-- sheet. Imported on-demand via scripts/import-fulfillment-sheet.mjs.
--
-- This table is an ARCHIVE/MIRROR, not operator-curated data, so the importer
-- is allowed to REFRESH on conflict (source_tab, source_row) — a documented
-- exception to the usual insert-only rule (see CLAUDE.md "System of record").
-- The full original row is preserved in `raw` so nothing is ever lost, even if
-- the column mapping drifts.
--
-- Tabs imported: Canada Shipping, US Shipping, Replacement, Personal Delivery.
-- Columns are the UNION across those tabs; tab-specific columns are null
-- elsewhere (e.g. starter_* is US-only, replacement_batch is Canada-only).

create table if not exists public.fulfillment_log (
  id uuid primary key default gen_random_uuid(),
  source_tab text not null,                 -- 'Canada Shipping' | 'US Shipping' | 'Replacement' | 'Personal Delivery'
  source_row int not null,                  -- 1-based spreadsheet row number (idempotency key)

  -- Dates (Excel serials in the sheet → real dates; non-date cells kept in raw)
  shipping_date date,
  order_date date,
  ticket_date date,                         -- Replacement tab
  delivery_window text,                     -- Personal Delivery: free-text "Feb 4, 2026 at 3pm"

  -- Customer / contact
  customer_name text,
  address text,
  phone text,
  email text,

  -- Unit
  batch text,
  color text,
  serial_number text,
  tracking_number text,                     -- kept as text (sheet has some in sci-notation)
  carrier text,
  price numeric(10,2),
  update_status text,                       -- "Update" column, e.g. "Received (02/04/2026)"

  -- Tab-specific
  replacement_batch text,                   -- Canada Shipping
  starter_ordered date,                     -- US Shipping
  amazon_tracking_id text,                  -- US Shipping
  starter_delivery text,                    -- US Shipping (free-text delivery status)
  notes text,

  raw jsonb not null,                       -- full original cell array, for fidelity
  imported_at timestamptz not null default now(),

  unique (source_tab, source_row)
);

create index if not exists idx_fulfillment_log_serial   on public.fulfillment_log (serial_number);
create index if not exists idx_fulfillment_log_customer on public.fulfillment_log (customer_name);
create index if not exists idx_fulfillment_log_email    on public.fulfillment_log (email);
create index if not exists idx_fulfillment_log_tab      on public.fulfillment_log (source_tab);

alter table public.fulfillment_log enable row level security;

drop policy if exists "fulfillment_log_select" on public.fulfillment_log;
create policy "fulfillment_log_select" on public.fulfillment_log
  for select to authenticated using (true);

drop policy if exists "fulfillment_log_insert" on public.fulfillment_log;
create policy "fulfillment_log_insert" on public.fulfillment_log
  for insert to authenticated with check (true);

drop policy if exists "fulfillment_log_update" on public.fulfillment_log;
create policy "fulfillment_log_update" on public.fulfillment_log
  for update to authenticated using (true) with check (true);
