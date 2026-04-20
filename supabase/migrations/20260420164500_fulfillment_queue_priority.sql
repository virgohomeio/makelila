-- Sales team can flag a queue row as priority so it floats to the top of the
-- fulfillment sidebar for faster shipping (e.g. customer paid for expedite,
-- influencer unboxing deadline, etc.). Simple boolean is enough — priority
-- rows are a tiny minority; ordering among them falls back to order_ref.
alter table public.fulfillment_queue
  add column if not exists priority boolean not null default false;

create index if not exists idx_fulfillment_queue_priority
  on public.fulfillment_queue (priority desc, due_date asc);
