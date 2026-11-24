-- Operator "work this first" flag on a sales order, surfaced as the PRIORITY
-- tab in Order Review (Sales). Independent of status: a priority order still
-- sits in its real status bucket (Pending / Needs Attention / Confirmed) AND in
-- PRIORITY. Walmart / Best Buy orders are priority automatically — the app
-- derives that from orders.sales_channel, so no column is needed for them. This
-- flag is only for the orders an operator pins by hand. Defaults false, so every
-- existing order reads as "not hand-pinned" with no backfill.
alter table public.orders
  add column if not exists is_priority boolean not null default false;
