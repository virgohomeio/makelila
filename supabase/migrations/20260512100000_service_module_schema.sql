-- Service module schema: customer lifecycle + unified service tickets +
-- attachments. Three intake sources (Calendly poll, public form, HubSpot
-- sync) + one internal source (Fulfillment QC flag) write into
-- service_tickets, distinguished by category enum.
--
-- customer_lifecycle is one row per shipped unit (NOT per customer): a
-- customer with two units gets two lifecycle rows. Clean for per-unit
-- warranty + onboarding tracking. Auto-created by trigger when
-- units.status transitions to 'shipped'.

-- ============================================================ customer_lifecycle
-- units.serial is the natural key (text, format LL01-NNNNNNNNNNN). Lifecycle
-- joins to units via serial; one row per shipped unit.
create table if not exists public.customer_lifecycle (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  unit_serial text not null references public.units(serial) on delete cascade unique,
  shipped_at timestamptz not null,
  onboarding_status text not null default 'not_scheduled'
    check (onboarding_status in ('not_scheduled','scheduled','completed','no_show','skipped')),
  onboarding_completed_at timestamptz,
  warranty_months int not null default 12,
  warranty_expires_at timestamptz,           -- computed by trigger: shipped_at + warranty_months months
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_lifecycle_customer on public.customer_lifecycle (customer_id);
create index if not exists idx_lifecycle_warranty on public.customer_lifecycle (warranty_expires_at);

alter table public.customer_lifecycle enable row level security;
create policy "lifecycle_select" on public.customer_lifecycle for select to authenticated using (true);
create policy "lifecycle_insert" on public.customer_lifecycle for insert to authenticated with check (true);
create policy "lifecycle_update" on public.customer_lifecycle for update to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.customer_lifecycle;

create or replace function public.touch_lifecycle_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists lifecycle_touch on public.customer_lifecycle;
create trigger lifecycle_touch before update on public.customer_lifecycle
  for each row execute function public.touch_lifecycle_updated_at();

-- Compute warranty_expires_at = shipped_at + warranty_months months on insert/update
create or replace function public.compute_warranty_expires() returns trigger language plpgsql as $$
begin
  new.warranty_expires_at := new.shipped_at + (new.warranty_months || ' months')::interval;
  return new;
end $$;
drop trigger if exists lifecycle_compute_warranty on public.customer_lifecycle;
create trigger lifecycle_compute_warranty before insert or update on public.customer_lifecycle
  for each row execute function public.compute_warranty_expires();

-- ============================================================ service_tickets
create table if not exists public.service_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_number text unique,                 -- filled by trigger: ST-YYYY-NNNN
  category text not null check (category in ('onboarding','support','repair')),
  source text not null check (source in ('calendly','customer_form','hubspot','fulfillment_flag','ops_manual')),
  status text not null default 'new'
    check (status in ('new','triaging','in_progress','waiting_customer','resolved','closed','escalated')),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),

  customer_id uuid references public.customers(id) on delete set null,
  customer_name text,
  customer_email text,
  customer_phone text,

  -- units.serial is the natural key; FK is loose (on delete set null) so
  -- units can be archived without losing the ticket history.
  unit_serial text references public.units(serial) on delete set null,
  order_ref text,

  subject text not null,
  description text,
  internal_notes text,

  defect_category text,                      -- repair: Door/Auger/Heater/Sensor/Wiring/Other
  parts_needed text,
  calendly_event_uri text unique,            -- onboarding dedupe
  calendly_event_start timestamptz,
  calendly_host_email text,
  hubspot_ticket_id text unique,             -- hubspot dedupe
  fulfillment_queue_id uuid references public.fulfillment_queue(id) on delete set null,

  owner_email text,
  resolved_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_tickets_cat_status on public.service_tickets (category, status);
create index if not exists idx_tickets_customer on public.service_tickets (customer_id);
create index if not exists idx_tickets_unit on public.service_tickets (unit_serial);
create index if not exists idx_tickets_created on public.service_tickets (created_at desc);

alter table public.service_tickets enable row level security;
create policy "tickets_select" on public.service_tickets for select to authenticated using (true);
create policy "tickets_insert_auth" on public.service_tickets for insert to authenticated with check (true);
create policy "tickets_insert_anon" on public.service_tickets for insert to anon
  with check (source = 'customer_form');
create policy "tickets_update" on public.service_tickets for update to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.service_tickets;

create or replace function public.touch_tickets_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists tickets_touch on public.service_tickets;
create trigger tickets_touch before update on public.service_tickets
  for each row execute function public.touch_tickets_updated_at();

-- Ticket number generator: ST-YYYY-NNNN, per-year sequence using an
-- advisory lock to serialize the count. Cheaper than maintaining a
-- per-year sequence object.
create or replace function public.assign_ticket_number() returns trigger language plpgsql as $$
declare
  yr int := extract(year from now())::int;
  n int;
begin
  if new.ticket_number is not null then return new; end if;
  perform pg_advisory_xact_lock(hashtext('service_ticket_number_' || yr));
  select coalesce(max(substring(ticket_number from '\d+$')::int), 0) + 1
    into n
    from public.service_tickets
    where ticket_number like 'ST-' || yr || '-%';
  new.ticket_number := 'ST-' || yr || '-' || lpad(n::text, 4, '0');
  return new;
end $$;
drop trigger if exists tickets_assign_number on public.service_tickets;
create trigger tickets_assign_number before insert on public.service_tickets
  for each row execute function public.assign_ticket_number();

-- Auto-stamp resolved_at / closed_at when status transitions
create or replace function public.tickets_stamp_terminal() returns trigger language plpgsql as $$
begin
  if new.status = 'resolved' and (old.status is distinct from 'resolved') then
    new.resolved_at := coalesce(new.resolved_at, now());
  end if;
  if new.status = 'closed' and (old.status is distinct from 'closed') then
    new.closed_at := coalesce(new.closed_at, now());
  end if;
  return new;
end $$;
drop trigger if exists tickets_stamp on public.service_tickets;
create trigger tickets_stamp before update on public.service_tickets
  for each row execute function public.tickets_stamp_terminal();

-- ============================================================ attachments
create table if not exists public.service_ticket_attachments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.service_tickets(id) on delete cascade,
  file_path text not null,                   -- path within ticket-attachments bucket
  file_name text not null,                   -- original filename
  mime_type text not null,
  size_bytes bigint not null,
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid references auth.users(id) on delete set null
);
create index if not exists idx_attachments_ticket on public.service_ticket_attachments (ticket_id);

alter table public.service_ticket_attachments enable row level security;
create policy "attachments_select" on public.service_ticket_attachments for select to authenticated using (true);
create policy "attachments_insert_auth" on public.service_ticket_attachments for insert to authenticated with check (true);
create policy "attachments_insert_anon" on public.service_ticket_attachments for insert to anon
  with check (
    exists (select 1 from public.service_tickets t
            where t.id = ticket_id and t.source = 'customer_form')
  );

alter publication supabase_realtime add table public.service_ticket_attachments;

-- ============================================================ lifecycle auto-create
-- When a unit transitions to status='shipped', create the lifecycle row.
-- shipped_at is taken from units.shipped_at if set, else now(). Customer
-- linkage is best-effort: units.customer_order_ref → orders.order_ref →
-- orders.customer_email → customers.email.
create or replace function public.create_lifecycle_row() returns trigger language plpgsql as $$
declare
  cust_id uuid;
  ship_ts timestamptz;
begin
  ship_ts := coalesce(new.shipped_at, now());
  if new.customer_order_ref is not null then
    select c.id into cust_id
      from public.orders o
      join public.customers c on lower(c.email) = lower(o.customer_email)
      where o.order_ref = new.customer_order_ref
      limit 1;
  end if;
  insert into public.customer_lifecycle (customer_id, unit_serial, shipped_at, warranty_months)
  values (cust_id, new.serial, ship_ts, 12)
  on conflict (unit_serial) do nothing;
  return new;
end $$;

drop trigger if exists units_create_lifecycle_on_ship on public.units;
create trigger units_create_lifecycle_on_ship
  after update of status on public.units
  for each row
  when (old.status is distinct from new.status and new.status = 'shipped')
  execute function public.create_lifecycle_row();

-- Back-fill lifecycle rows for already-shipped units
insert into public.customer_lifecycle (customer_id, unit_serial, shipped_at, warranty_months)
select
  (
    select c.id
      from public.orders o
      join public.customers c on lower(c.email) = lower(o.customer_email)
      where o.order_ref = u.customer_order_ref
      limit 1
  ),
  u.serial,
  coalesce(u.shipped_at, u.status_updated_at, now()),
  12
from public.units u
where u.status = 'shipped'
  and not exists (select 1 from public.customer_lifecycle cl where cl.unit_serial = u.serial);
