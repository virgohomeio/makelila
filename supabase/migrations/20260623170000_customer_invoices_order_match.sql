-- Upload module: invoice → sales-order linkage + auto-match state.
--
-- customer_invoices already carries customer_id (+ bill_to_name, noted in the
-- original migration as "used for unassigned-invoice matching"). The Upload
-- module's bulk auto-matcher (match-invoice edge function) reads the Shopify
-- order number out of the PDF body (e.g. "Shopify order# 1192"), resolves it to
-- an order, and links both the order and its customer. These columns persist
-- that link + how confident the match was so the Upload review queue can
-- surface anything that needs a manual assignment.

alter table public.customer_invoices
  add column if not exists order_id uuid references public.orders(id) on delete set null,
  -- The parsed Shopify order ref (e.g. "#1192"), kept even when order_id can't
  -- be resolved so the review queue can still show what was on the invoice.
  add column if not exists order_ref text,
  add column if not exists match_status text not null default 'unassigned'
    check (match_status in ('matched', 'needs_review', 'unassigned')),
  -- How the match was made: 'order_number' | 'email' | 'name' | 'manual' | null.
  add column if not exists match_method text;

create index if not exists idx_customer_invoices_order
  on public.customer_invoices (order_id);

-- Review queue: anything not confidently matched, newest first.
create index if not exists idx_customer_invoices_review
  on public.customer_invoices (created_at desc)
  where match_status in ('needs_review', 'unassigned');
