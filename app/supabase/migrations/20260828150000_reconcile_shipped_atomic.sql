-- Two fixes for recording a shipment that happened outside the queue.
--
-- Reported from the Reconcile screen on #1015 (Tamara Martin, unit
-- LL01-00000000141): "Order was approved but the queue row could not be
-- closed: violates foreign key constraint fulfillment_queue_assigned_serial_fkey".
--
-- 1. assigned_serial pointed at shelf_slots(serial), not units(serial).
--
--    shelf_slots is a *location* table — a slot is freed when the machine
--    leaves the building. So the constraint reads "the queue may only name a
--    machine currently sitting on a shelf", which is true at step 1 and false
--    for every historical row. 89 of the 176 shipped units have no shelf row,
--    so roughly half the reconcile queue could not be recorded at all.
--
--    It also meant ON DELETE SET NULL was pointed at a table whose rows are
--    routinely deleted and reorganised: clearing a slot would silently wipe the
--    serial off a *completed* shipment record. Repointing to units(serial),
--    the identity table, fixes both. No existing row breaks — all 100 shelf
--    serials and all 59 queue serials already exist in units.
--
-- 2. Approving the order and closing its queue row were two client-side
--    writes. When the second failed, #1015 was left approved with a step-1
--    queue row: the order vanished from Sales and appeared in Fulfillment as
--    live work nobody had done. Both writes now happen inside one function, so
--    they are one transaction and a failure leaves nothing behind.

alter table public.fulfillment_queue
  drop constraint if exists fulfillment_queue_assigned_serial_fkey;

alter table public.fulfillment_queue
  add constraint fulfillment_queue_assigned_serial_fkey
  foreign key (assigned_serial) references public.units(serial) on delete set null;

create or replace function public.reconcile_order_shipped(
  p_order_id uuid,
  p_serial   text,
  p_by       text,
  p_note     text default null
) returns void
language plpgsql
as $$
declare
  v_unit    record;
  v_order   record;
  v_ship_ts timestamptz;
  v_queue_id uuid;
begin
  select serial, shipped_at, carrier, tracking_num, status
    into v_unit
    from public.units where serial = p_serial;
  if not found then
    raise exception 'Unit % is not on file.', p_serial;
  end if;

  select id, order_ref, placed_at, created_at
    into v_order
    from public.orders where id = p_order_id;
  if not found then
    raise exception 'Order % is not on file.', p_order_id;
  end if;

  -- The unit's own ship date wins. fq_sync_unit writes units.shipped_at =
  -- coalesce(label_confirmed_at, fulfilled_at, now()), so handing back the
  -- value already there makes that trigger a no-op on the column: this records
  -- an order's fulfilment, it does not re-date a machine.
  v_ship_ts := coalesce(v_unit.shipped_at, v_order.placed_at, v_order.created_at);

  update public.orders set
    status            = 'approved',
    shipped_at        = v_ship_ts,
    dispositioned_at  = now(),
    reconciled_at     = now(),
    reconciled_by     = p_by,
    reconcile_outcome = 'shipped',
    reconcile_note    = coalesce(p_note, 'Shipped outside the queue as ' || p_serial)
  where id = p_order_id;

  -- Created by auto_enqueue_on_approve, in this same transaction.
  select id into v_queue_id from public.fulfillment_queue where order_id = p_order_id;
  if v_queue_id is null then
    raise exception 'Order % was approved but no fulfillment queue row exists for it.', v_order.order_ref;
  end if;

  -- email_sent_at is deliberately left null: step 5 is what mails the
  -- customer, and these customers received the machine months ago.
  update public.fulfillment_queue set
    step                  = 6,
    assigned_serial       = p_serial,
    carrier               = coalesce(carrier, v_unit.carrier),
    tracking_num          = coalesce(tracking_num, v_unit.tracking_num),
    label_confirmed_at    = v_ship_ts,
    fulfilled_at          = v_ship_ts,
    reconciled_at         = now(),
    reconciliation_source = 'sales_reconcile'
  where id = v_queue_id;
end $$;

comment on function public.reconcile_order_shipped(uuid, text, text, text) is
  'Records that an order shipped outside the fulfillment queue: approves it and '
  'closes its queue row at step 6 in one transaction. Sends no email.';

grant execute on function public.reconcile_order_shipped(uuid, text, text, text) to authenticated;
