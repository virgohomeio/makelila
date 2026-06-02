-- Service Inbox: separate auto-imported conversations from operator-confirmed tickets.
-- See docs/superpowers/specs/2026-05-29-service-inbox-design.md.

-- 1. Schema additions.
alter table public.service_tickets
  add column if not exists kind text not null default 'ticket'
    check (kind in ('conversation', 'ticket')),
  add column if not exists inbox_disposition text
    check (inbox_disposition in ('promoted', 'sales', 'follow_up', 'dismissed'));

-- 2. Dedupe existing Quo rows BEFORE adding the unique index. Keep the
--    oldest row per conversation_id; delete the rest. Sandra Sweet
--    (+18479179141) currently has 43 rows for 1 conversation; this collapses
--    her to 1. Messages are linked to ticket_id — they survive because we
--    keep the oldest ticket (which received the first insert of the message
--    set). Newer duplicate tickets had their messages upserted by
--    gmail_message_id (`quo:<id>`), so deleting the duplicate ticket rows
--    does not orphan message rows — they were always associated with the
--    one canonical ticket.
delete from public.service_tickets t
  using (
    select quo_conversation_id, min(created_at) as keep_created_at
      from public.service_tickets
      where source = 'quo' and quo_conversation_id is not null
      group by quo_conversation_id
      having count(*) > 1
  ) k
  where t.source = 'quo'
    and t.quo_conversation_id = k.quo_conversation_id
    and t.created_at > k.keep_created_at;

-- 3. Add the unique index now that dupes are gone.
create unique index if not exists service_tickets_quo_conv_uniq
  on public.service_tickets (quo_conversation_id)
  where source = 'quo' and quo_conversation_id is not null;

-- 4. Add an index for the Inbox tab's primary query.
create index if not exists service_tickets_kind_idx
  on public.service_tickets (kind, last_message_at desc nulls last);

-- 5. Bulk-demote all auto-imported Quo + Gmail rows to inbox conversations.
--    HubSpot / Calendly / customer_form / ops_manual rows stay as tickets.
update public.service_tickets
  set kind = 'conversation'
  where source in ('quo', 'gmail');
