-- Running checklist of action items per support ticket. Mirrors ticket_notes
-- (internal-only, realtime, timestamped) but each item can be checked off.
CREATE TABLE IF NOT EXISTS public.ticket_action_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    uuid NOT NULL REFERENCES public.service_tickets(id) ON DELETE CASCADE,
  body         text NOT NULL,
  done         boolean NOT NULL DEFAULT false,
  done_at      timestamptz,
  done_by      text,
  author_id    uuid,
  author_email text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_ticket_action_items_ticket ON public.ticket_action_items(ticket_id);

ALTER TABLE public.ticket_action_items ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ticket_action_items TO authenticated;

CREATE POLICY action_items_select ON public.ticket_action_items FOR SELECT USING (is_internal_user());
CREATE POLICY action_items_insert ON public.ticket_action_items FOR INSERT WITH CHECK (is_internal_user());
CREATE POLICY action_items_update ON public.ticket_action_items FOR UPDATE USING (is_internal_user()) WITH CHECK (is_internal_user());
CREATE POLICY action_items_delete ON public.ticket_action_items FOR DELETE USING (is_internal_user());

ALTER PUBLICATION supabase_realtime ADD TABLE public.ticket_action_items;
