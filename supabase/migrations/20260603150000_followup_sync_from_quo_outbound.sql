-- Backfill customers.fu1_status / fu2_status from Reina's recent Quo
-- outbound messaging. Walkthrough #40 follow-up: previously 79 followups
-- were overdue because the UI only counted manual button clicks, but Reina
-- has been doing the work via Quo SMS without flipping the makelila chip.
-- This catches up the audit trail.
--
-- Rules:
--   FU1 → 'messaged' if a Quo outbound message was sent at or after
--   (onboard_date + 7 days) AND fu1_status is currently null.
--   FU2 → 'messaged' if a Quo outbound message was sent at or after
--   (onboard_date + 30 days) AND fu1_status is already set AND fu2_status
--   is currently null.
--
-- The same Quo touch can backfill BOTH FU1 and FU2 for a customer whose
-- single recent message arrived ≥30 days post-onboard — that's intentional;
-- one outreach covers both check-ins. Reina can manually downgrade any
-- she disagrees with via the FU buttons in the Customers detail panel.
--
-- Append a tag to fu_notes so we know which entries were backfilled from
-- Quo vs operator-recorded via the UI buttons.

with last_quo_outbound as (
  select st.customer_id, max(tm.sent_at) as last_out_at
    from ticket_messages tm
    join service_tickets st on st.id = tm.ticket_id
   where tm.direction = 'outbound'
     and tm.gmail_message_id like 'quo:%'
     and st.customer_id is not null
   group by st.customer_id
)
update public.customers c
   set fu1_status = 'messaged',
       fu_notes = concat_ws(
         e'\n',
         c.fu_notes,
         '[Makelila ' || to_char(now(), 'YYYY-MM-DD') ||
         '] FU1 backfilled from Quo outbound on ' ||
         to_char(lq.last_out_at, 'YYYY-MM-DD') || '.'
       )
  from last_quo_outbound lq
 where lq.customer_id = c.id
   and c.fu1_status is null
   and c.onboard_date is not null
   and lq.last_out_at >= (c.onboard_date::timestamptz + interval '7 days');

with last_quo_outbound as (
  select st.customer_id, max(tm.sent_at) as last_out_at
    from ticket_messages tm
    join service_tickets st on st.id = tm.ticket_id
   where tm.direction = 'outbound'
     and tm.gmail_message_id like 'quo:%'
     and st.customer_id is not null
   group by st.customer_id
)
update public.customers c
   set fu2_status = 'messaged',
       fu_notes = concat_ws(
         e'\n',
         c.fu_notes,
         '[Makelila ' || to_char(now(), 'YYYY-MM-DD') ||
         '] FU2 backfilled from Quo outbound on ' ||
         to_char(lq.last_out_at, 'YYYY-MM-DD') || '.'
       )
  from last_quo_outbound lq
 where lq.customer_id = c.id
   and c.fu1_status is not null
   and c.fu2_status is null
   and c.onboard_date is not null
   and lq.last_out_at >= (c.onboard_date::timestamptz + interval '30 days');
