-- Backfill the missing DELETE policy on public.orders.
--
-- 20260604200000_rls_internal_only added SELECT + UPDATE, and
-- 20260608150000_orders_insert_policy backfilled INSERT, but a DELETE policy
-- was never added. With RLS on and no DELETE policy, deletes are SILENTLY
-- denied (0 rows affected, no error) for authenticated operators.
--
-- This bit two flows that delete un-shipped replacement orders:
--   - deleteTicket() cascade (app/src/lib/service.ts) — silently failed to
--     remove a ticket's linked replacement orders (they lingered in Order
--     Review / Service > Replacement).
--   - cancelReplacementOrder() (app/src/lib/orders.ts) — the "Cancel
--     replacement" action reported "cancellation failed".
--
-- Scoped to replacement orders: the app never deletes sale orders (Shopify is
-- the system of record for those), so this keeps the grant as narrow as the
-- actual usage. Mirrors the orders_insert backfill pattern.

drop policy if exists "orders_delete" on public.orders;
create policy "orders_delete" on public.orders
  for delete to authenticated
  using (public.is_internal_user() and kind = 'replacement');
