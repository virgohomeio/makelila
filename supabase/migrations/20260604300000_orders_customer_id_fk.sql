-- Backlog #68 — orders.customer_id FK (mirror of #67 on the orders side).
--
-- Today customer_profitability view (#58) joins orders↔customers via fuzzy
-- email/name match. Same false-positive risk that #67 fixed for units.
-- Add the canonical FK, backfill (100% match rate in dry run: 75 by email
-- + 6 by name = 81/81), and a BEFORE trigger so all writers
-- (sync-shopify-orders, createReplacementOrder) get the FK for free.

alter table public.orders
  add column if not exists customer_id uuid references public.customers(id) on delete set null;

create index if not exists orders_customer_id_idx
  on public.orders(customer_id) where customer_id is not null;

-- Email-first resolver. Tries exact email match, then falls back to the
-- existing name cascade in resolve_customer_id_from_name() (added in
-- migration 20260604290000).
create or replace function public.resolve_customer_id(p_email text, p_name text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_email is not null and p_email <> '' then
    select id into v_id from public.customers
     where email is not null and lower(email) = lower(p_email)
     limit 1;
    if v_id is not null then return v_id; end if;
  end if;
  return public.resolve_customer_id_from_name(p_name);
end $$;

revoke all on function public.resolve_customer_id(text, text) from anon, public;
grant execute on function public.resolve_customer_id(text, text) to authenticated;

-- Backfill — 81/81 expected
update public.orders
   set customer_id = public.resolve_customer_id(customer_email, customer_name)
 where customer_id is null;

-- Auto-resolve trigger — same shape as units_auto_customer_id
create or replace function public.orders_set_customer_id_from_email_or_name()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.customer_id is null then
    new.customer_id := public.resolve_customer_id(new.customer_email, new.customer_name);
  end if;
  return new;
end $$;

drop trigger if exists orders_auto_customer_id on public.orders;
create trigger orders_auto_customer_id
before insert or update of customer_email, customer_name, customer_id on public.orders
for each row execute function public.orders_set_customer_id_from_email_or_name();
