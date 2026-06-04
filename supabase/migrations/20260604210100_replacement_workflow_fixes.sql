-- Quality fixes for 20260604210000_replacement_workflow:
--   1. Make orders_kind_idx a partial index (replacement rows only).
--   2. Add advisory lock to next_replacement_order_ref() to prevent
--      concurrent callers from reading the same MAX and returning duplicate refs.

drop index if exists public.orders_kind_idx;
create index if not exists orders_kind_idx on public.orders(kind)
  where kind = 'replacement';

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
