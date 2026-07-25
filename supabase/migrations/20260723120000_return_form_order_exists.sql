-- The public /return form runs as the anon role, which has no SELECT on
-- public.orders (RLS is authenticated + is_internal_user only). To let the
-- form confirm an order number WITHOUT exposing order rows/PII to the public,
-- this SECURITY DEFINER function returns ONLY a boolean existence check.
-- Auto-prefixes '#'. Callable by anon (and authenticated). See ReturnForm.tsx.
create or replace function public.return_form_order_exists(p_order_ref text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.orders o
    where o.order_ref = case
      when btrim(p_order_ref) like '#%' then btrim(p_order_ref)
      else '#' || btrim(p_order_ref)
    end
  );
$$;

revoke all on function public.return_form_order_exists(text) from public;
grant execute on function public.return_form_order_exists(text) to anon, authenticated;

comment on function public.return_form_order_exists(text) is
  'Existence-only order lookup for the public /return form (anon role). Returns true if an order with the given ref exists (auto-prefixes #). Boolean only, no PII. See app ReturnForm.tsx.';
