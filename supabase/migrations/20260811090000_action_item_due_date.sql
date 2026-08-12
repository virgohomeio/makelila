-- Due dates on ticket action items, powering the week-view kanban in Service >
-- Support Tickets.
--
-- `date`, not timestamptz: a due date is a calendar day an operator picks, not
-- an instant. Storing it as a timestamp would drift a day either side depending
-- on the viewer's timezone, which is exactly the bug you don't want on a board
-- whose whole job is "what is due Wednesday".
ALTER TABLE public.ticket_action_items
  ADD COLUMN IF NOT EXISTS due_date date;

-- The board queries open items across every ticket and buckets them by day, so
-- the useful index is (done, due_date) — it serves both the done=false filter
-- and the date ordering.
CREATE INDEX IF NOT EXISTS ix_ticket_action_items_open_due
  ON public.ticket_action_items(done, due_date);
