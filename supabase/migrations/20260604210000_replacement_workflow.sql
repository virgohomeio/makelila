-- Replacement workflow (spec: docs/superpowers/specs/2026-06-04-service-replacement-design.md)
-- Adds the orders.kind discriminator, links to service_tickets, COGS + actual
-- shipping cost columns, and ship/deliver timestamps. The existing
-- orders.status ('pending'|'approved'|'flagged'|'held') stays for Order
-- Review's pipeline; downstream Fulfillment / Post-Shipment state is implied
-- by shipped_at / delivered_at being non-null.

alter table public.orders
  add column if not exists kind text not null default 'sale',
  add column if not exists linked_ticket_id uuid references public.service_tickets(id) on delete set null,
  add column if not exists cogs_usd numeric(10,2),
  add column if not exists shipping_cost_usd numeric(10,2),
  add column if not exists shipped_at timestamptz,
  add column if not exists delivered_at timestamptz;

-- Note: existing rows pick up kind='sale' automatically because Postgres
-- writes the default value on ADD COLUMN NOT NULL DEFAULT (no separate
-- backfill needed).

alter table public.orders
  drop constraint if exists orders_kind_check;
alter table public.orders
  add constraint orders_kind_check check (kind in ('sale', 'replacement'));

create index if not exists orders_kind_idx on public.orders(kind)
  where kind = 'replacement';
create index if not exists orders_linked_ticket_idx on public.orders(linked_ticket_id)
  where linked_ticket_id is not null;

alter table public.service_tickets
  add column if not exists replacement_order_id uuid references public.orders(id) on delete set null;

create index if not exists service_tickets_replacement_order_idx
  on public.service_tickets(replacement_order_id)
  where replacement_order_id is not null;

-- next_replacement_order_ref(): returns 'R-0001', 'R-0002', ... by reading
-- MAX(NULLIF(regexp_replace(order_ref, '^R-', ''), '')::int) + 1.
create or replace function public.next_replacement_order_ref()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n int;
begin
  -- Serialize concurrent callers so two replacement-order creations can't
  -- both read MAX(order_ref) and return the same ref. Transaction-scoped
  -- lock — released at COMMIT/ROLLBACK.
  perform pg_advisory_xact_lock(hashtext('next_replacement_order_ref'));
  select coalesce(max(nullif(regexp_replace(order_ref, '^R-', ''), '')::int), 0)
    into n
    from public.orders
    where order_ref ~ '^R-\d+$';
  return 'R-' || lpad((n + 1)::text, 4, '0');
end $$;

revoke all on function public.next_replacement_order_ref() from anon, public;
grant execute on function public.next_replacement_order_ref() to authenticated;
