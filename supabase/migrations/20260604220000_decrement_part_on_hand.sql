-- Atomic parts decrement RPC used by createReplacementOrder.
-- Avoids the TOCTOU race when two replacement orders are created
-- concurrently (both reading the same on_hand value, both writing
-- decremented value, losing one decrement).
--
-- Floors at 0 so a runaway operator can't push the count negative.

create or replace function public.decrement_part_on_hand(p_part_id uuid, p_qty int)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_on_hand int;
begin
  update public.parts
     set on_hand = greatest(0, on_hand - p_qty),
         updated_at = now()
   where id = p_part_id
   returning on_hand into new_on_hand;
  if new_on_hand is null then
    raise exception 'part % not found', p_part_id;
  end if;
  return new_on_hand;
end $$;

revoke all on function public.decrement_part_on_hand(uuid, int) from anon, public;
grant execute on function public.decrement_part_on_hand(uuid, int) to authenticated;
