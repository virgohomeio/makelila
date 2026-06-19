-- Shipping module tables: shipments (booked Freightcom shipments)
-- and claims (internal claim tracker, no external API).

-- ============================================================ shipments

create table if not exists public.shipments (
  id                      uuid primary key default gen_random_uuid(),
  order_id                uuid references public.orders(id) not null,
  freightcom_shipment_id  text not null unique,
  carrier                 text not null,
  service                 text not null,
  rate_cad                numeric(10,2),
  transit_days            int,
  label_url               text,
  primary_tracking_number text,
  status                  text not null default 'booked'
                          check (status in (
                            'booked','in_transit','delivered',
                            'exception','missing','cancelled'
                          )),
  booked_at               timestamptz not null default now(),
  booked_by               uuid references auth.users(id)
);

alter table public.shipments enable row level security;

create policy "internal only" on public.shipments
  using (public.is_internal_user())
  with check (public.is_internal_user());

create index if not exists shipments_order_id_idx on public.shipments(order_id);

-- ============================================================ claims

create table if not exists public.claims (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid references public.orders(id) not null,
  shipment_id  uuid references public.shipments(id),
  reason       text not null
               check (reason in ('damage','lost','late','other')),
  amount_cad   numeric(10,2),
  status       text not null default 'open'
               check (status in ('open','submitted','resolved','denied')),
  notes        text,
  filed_at     timestamptz not null default now(),
  filed_by     uuid references auth.users(id),
  resolved_at  timestamptz
);

alter table public.claims enable row level security;

create policy "internal only" on public.claims
  using (public.is_internal_user())
  with check (public.is_internal_user());

create index if not exists claims_order_id_idx on public.claims(order_id);
create index if not exists claims_shipment_id_idx on public.claims(shipment_id);
