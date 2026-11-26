-- supabase/migrations/20261126120000_ship_sla_starter_checkbox_priority_email.sql
--
-- Ready-to-ship simplification (operator request 2026-11-26).
--
-- 1. Ship SLA: a confirmed order is due the NEXT day — the pickup must be
--    booked by end of confirm day + 1, and picked up by confirm day + 2
--    (app/src/lib/shipDeadlines.ts). Was now() + 7 days. Only the interval
--    changes; the body is otherwise what prod runs today. Day is taken in
--    Toronto time so an evening confirm is not counted as tomorrow (UTC).
--
-- 2. Starter soil: a checkbox ("ordered on Amazon") replaces the Amazon
--    tracking-number field. starter_ordered_at satisfies the step-3 gate on
--    its own; starter_tracking_num is kept for old rows and the shipment email.
--
-- 3. sale_confirmed email: the subject names a priority order's marketplace —
--    "PRIORITY Walmart order confirmed — #1300 · Jane Doe". The app always
--    supplies {{sale_kind}} ("Sale" for an ordinary order).

create or replace function public.auto_enqueue_approved_order()
returns trigger
language plpgsql
as $function$
begin
  if new.status = 'approved' and (old.status is null or old.status <> 'approved') then
    insert into public.fulfillment_queue (order_id, due_date)
    values (new.id, ((now() at time zone 'America/Toronto')::date + 1))
    on conflict (order_id) do nothing;
  end if;
  return new;
end;
$function$;

alter table public.fulfillment_queue
  add column if not exists starter_ordered_at timestamptz,
  add column if not exists starter_ordered_by uuid;

comment on column public.fulfillment_queue.starter_ordered_at is
  'When an operator ticked "Starter soil ordered" at step 3. Settles the starter gate without a tracking number.';

update public.email_templates
   set subject   = '{{sale_kind}} confirmed — {{order_ref}} · {{customer_name}}',
       body      = E'Hi {{recipient_first_name}},\n\n{{confirmed_by}} just confirmed this order in Sales. It is now in the fulfillment queue.\n\nType: {{sale_kind}}\nChannel: {{channel}}\nOrder: {{order_ref}}\nCustomer: {{customer_name}}\nTotal: {{amount}}\n\nBook the pickup by: {{schedule_by}}\nPicked up by: {{pickup_by}}\n\nOpen the queue: {{queue_url}}\nOpen the order: {{order_url}}\n\n— makeLILA',
       variables = array['recipient_first_name','sale_kind','channel','order_ref','customer_name','amount','confirmed_by','schedule_by','pickup_by','queue_url','order_url']::text[]
 where key = 'sale_confirmed';
