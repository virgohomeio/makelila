-- Refunded orders must never enter the fulfillment queue.
--
-- refund_approvals.order_id was null on all 18 live rows: every caller left it
-- unset because a return's original_order_ref is human text ("#1107", "1216",
-- "R-0043", "I don't know, please ask Edward") and the column is a UUID FK.
-- With no link, nothing could tell that an order had been refunded — Sales
-- listed it like any other order, and confirming it fires
-- auto_enqueue_approved_order, which drops it into fulfillment_queue. The queue
-- ships what it is handed, so we could ship a machine to a customer whose money
-- we had already sent back.
--
-- The app now guards both approve and enqueue (lib/refundedOrders.ts), but the
-- trigger below runs inside the database and bypasses the app entirely, so the
-- last line of defence belongs here.

-- ── 1. Backfill the missing FK ──────────────────────────────────────────────
-- Deliberately conservative: only unambiguous matches. Anything left null keeps
-- today's behaviour (a customer-level warning badge, no hard block), which is
-- the right outcome for a link we cannot prove.

-- 1a. By the return's order ref, normalised across the three spellings the
--     importers use ("#1134" / "1134" / "INV-1134"), narrowed by the customer's
--     email when a ref collides across two orders.
with candidate as (
  select ra.id                                                            as refund_id,
         lower(nullif(trim(ra.customer_email), ''))                       as email,
         nullif(regexp_replace(lower(trim(coalesce(r.original_order_ref, ''))),
                               '^#|^inv-', ''), '')                       as raw_ref
  from public.refund_approvals ra
  left join public.returns r on r.id = ra.return_id
  where ra.order_id is null
    and ra.status not in ('denied', 'closed')
),
normalised as (
  -- Only a ref-shaped token counts; free text from the public return form
  -- ("I don't know, please ask Edward") names no order.
  select refund_id, email,
         case when raw_ref ~ '^[a-z]*-?[0-9]+$' then raw_ref end as ref
  from candidate
),
matched as (
  select n.refund_id, o.id as order_id,
         count(*) over (partition by n.refund_id)                            as ref_matches,
         count(*) filter (where lower(o.customer_email) = n.email)
                  over (partition by n.refund_id)                            as email_matches,
         (lower(o.customer_email) = n.email)                                 as email_match
  from normalised n
  join public.orders o
    on n.ref is not null
   and regexp_replace(lower(trim(o.order_ref)), '^#|^inv-', '') = n.ref
)
update public.refund_approvals ra
   set order_id = m.order_id
  from matched m
 where ra.id = m.refund_id
   and ra.order_id is null
   -- One candidate outright, or exactly one once narrowed by email.
   and (m.ref_matches = 1 or (m.email_matches = 1 and m.email_match));

-- 1b. No usable ref — fall back to the customer's single SALE. Sales only: a
--     refund is always against something that was paid for, and one customer's
--     only remaining order is a warranty replacement they are still owed.
--     Pinning her refund to it would block a machine we do owe her.
with sole_sale as (
  select ra.id as refund_id, min(o.id::text)::uuid as order_id, count(*) as n
  from public.refund_approvals ra
  join public.orders o
    on lower(o.customer_email) = lower(nullif(trim(ra.customer_email), ''))
   and o.kind <> 'replacement'
  where ra.order_id is null
    and ra.status not in ('denied', 'closed')
  group by ra.id
)
update public.refund_approvals ra
   set order_id = s.order_id
  from sole_sale s
 where ra.id = s.refund_id
   and ra.order_id is null
   and s.n = 1;

-- ── 2. Keep refunded orders out of the queue ────────────────────────────────
-- The guard lives in the trigger rather than a CHECK because the order can be
-- refunded long after it was approved, and because a hard constraint would
-- reject the legitimate historical rows (an order refunded AFTER it shipped
-- keeps its fulfilled queue row — that is the returns team's record).
--
-- Silently skipping, not raising: confirming an order is an operator action
-- with its own guard and its own error message in the app. A raise here would
-- surface as an opaque database error on an UPDATE that had every right to
-- succeed — the order really is approved, it simply must not ship.
create or replace function public.auto_enqueue_approved_order()
returns trigger
language plpgsql
as $function$
declare
  refunded boolean;
begin
  if new.status = 'approved' and (old.status is null or old.status <> 'approved') then
    select exists (
      select 1 from public.refund_approvals ra
       where ra.order_id = new.id
         and ra.status not in ('denied', 'closed')
    ) into refunded;

    if refunded then
      raise notice 'Order % not enqueued: it has a refund against it', new.order_ref;
      return new;
    end if;

    insert into public.fulfillment_queue (order_id, due_date)
    values (new.id, (now() + interval '7 days')::date)
    on conflict (order_id) do nothing;
  end if;
  return new;
end;
$function$;

-- ── 3. Pull any refunded order that is sitting in the queue unshipped ───────
-- None today, but this migration is also the repair for the state that bug
-- produced, and it must be safe to re-run. Fulfilled rows are never touched:
-- an order refunded after it shipped keeps its shipment record.
delete from public.fulfillment_queue q
 using public.refund_approvals ra
 where ra.order_id = q.order_id
   and ra.status = 'refunded'
   and q.fulfilled_at is null
   and q.step < 6;
