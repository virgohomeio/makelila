-- Customer shipping invoices + per-customer profitability adjustments.
--
-- 1. customer_shipping_invoices — carrier / freight / customs-broker invoices
--    (UPS duty bills, Freightcom, Goorooship…) filed against ONE customer, the
--    way customer_invoices holds sales invoices. Each row carries:
--      * freight_amount — what WE paid to ship. Added to the customer's
--        Shipping bucket only when counts_in_shipping is true, so an invoice
--        for a shipment the Freightcom sync already costed is not counted twice.
--      * customs_amount — the duty/brokerage total printed on the invoice.
--      * customs_covered_amount — how much of that WE covered for the customer
--        (US customers are billed duty by UPS directly; we reimburse some or
--        all of it). This feeds the new "Customs & duties" cost bucket.
--    Amounts are stored in their native currency (CAD or USD); the app converts
--    through public.fx_rates, same as the profitability view.
--
-- 2. customer_profitability_adjustments — one row per customer, operator-edited
--    from the Profitability tab:
--      * customs_covered_amount — customs covered with no invoice on file.
--      * shipping_override_amount — when set, replaces the computed Shipping
--        bucket outright (null = use the computed figure).
--
-- PDFs/images live in the existing private `customer-invoices` bucket under a
-- `shipping/<customer_id>/` prefix, so the bucket's internal-only storage
-- policies already cover them. The bucket is widened to accept images too,
-- because UPS duty invoices usually arrive as phone photos.
--
-- Idempotent: safe to hand-apply in the SQL editor and to re-run.

-- ============================================================ shipping invoices

create table if not exists public.customer_shipping_invoices (
  id                      uuid primary key default gen_random_uuid(),
  customer_id             uuid not null references public.customers(id) on delete cascade,
  order_ref               text,
  carrier                 text,
  invoice_number          text,
  invoice_date            date,
  currency                text not null default 'CAD' check (currency in ('CAD', 'USD')),
  freight_amount          numeric(10,2) not null default 0 check (freight_amount >= 0),
  counts_in_shipping      boolean not null default true,
  customs_amount          numeric(10,2) not null default 0 check (customs_amount >= 0),
  customs_covered_amount  numeric(10,2) not null default 0 check (customs_covered_amount >= 0),
  file_name               text,
  storage_path            text unique,
  notes                   text,
  uploaded_by             text,
  created_at              timestamptz not null default now()
);

alter table public.customer_shipping_invoices enable row level security;

drop policy if exists internal_only on public.customer_shipping_invoices;
create policy internal_only on public.customer_shipping_invoices
  using (public.is_internal_user())
  with check (public.is_internal_user());

grant select, insert, update, delete on public.customer_shipping_invoices to authenticated;

create index if not exists idx_customer_shipping_invoices_customer
  on public.customer_shipping_invoices (customer_id);

-- ============================================================ adjustments

create table if not exists public.customer_profitability_adjustments (
  customer_id               uuid primary key references public.customers(id) on delete cascade,
  currency                  text not null default 'CAD' check (currency in ('CAD', 'USD')),
  customs_covered_amount    numeric(10,2) not null default 0 check (customs_covered_amount >= 0),
  shipping_override_amount  numeric(10,2) check (shipping_override_amount >= 0),
  note                      text,
  updated_by                text,
  updated_at                timestamptz not null default now()
);

alter table public.customer_profitability_adjustments enable row level security;

drop policy if exists internal_only on public.customer_profitability_adjustments;
create policy internal_only on public.customer_profitability_adjustments
  using (public.is_internal_user())
  with check (public.is_internal_user());

grant select, insert, update, delete on public.customer_profitability_adjustments to authenticated;

-- ============================================================ storage

update storage.buckets
   set allowed_mime_types = array['application/pdf', 'image/png', 'image/jpeg', 'image/heic', 'image/webp']
 where id = 'customer-invoices';
