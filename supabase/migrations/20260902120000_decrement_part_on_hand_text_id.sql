-- Fix decrement_part_on_hand: p_part_id must be TEXT, not uuid.
--
-- public.parts.id is a text primary key holding human-readable codes
-- ('P-LID-V36', 'C-STARTER') — see 20260420340000_parts_module.sql. The
-- original RPC in 20260604220000_decrement_part_on_hand.sql declared
-- `p_part_id uuid`, following the uuid-PK convention the rest of the schema
-- uses, without checking this table.
--
-- Nothing caught it: PostgREST forwards the JSON string and Postgres fails the
-- coercion at call time with
--     invalid input syntax for type uuid: "P-LID-V36"
-- so the RPC has never once succeeded against a real part. createReplacementOrder
-- calls it at step 3, AFTER inserting the order and back-linking the ticket, so
-- every replacement order containing a part line item threw at the decrement and
-- left an orphan order behind with its stock never taken (R-0035, R-0036,
-- R-0061, R-0067, R-0068).
--
-- DROP then CREATE rather than `create or replace`: a replace cannot change a
-- parameter's type, it would add a second overload, and PostgREST could not
-- resolve `{"p_part_id": "...", "p_qty": n}` between the two.

drop function if exists public.decrement_part_on_hand(uuid, int);

create or replace function public.decrement_part_on_hand(p_part_id text, p_qty int)
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

revoke all on function public.decrement_part_on_hand(text, int) from anon, public;
grant execute on function public.decrement_part_on_hand(text, int) to authenticated;
