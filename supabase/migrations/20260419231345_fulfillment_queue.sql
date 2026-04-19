-- fulfillment_queue: one row per approved order; 5-step state machine + fulfilled terminal.
create table if not exists public.fulfillment_queue (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  step smallint not null default 1 check (step between 1 and 6),

  assigned_serial text references public.shelf_slots(serial) on delete set null,

  test_report_url text,
  test_confirmed_at timestamptz,
  test_confirmed_by uuid references auth.users(id),

  carrier text check (carrier in ('UPS','FedEx','Purolator','Canada Post')),
  tracking_num text,
  label_pdf_path text,
  label_confirmed_at timestamptz,
  label_confirmed_by uuid references auth.users(id),

  dock_printed  boolean not null default false,
  dock_affixed  boolean not null default false,
  dock_docked   boolean not null default false,
  dock_notified boolean not null default false,
  dock_confirmed_at timestamptz,
  dock_confirmed_by uuid references auth.users(id),

  starter_tracking_num text,
  email_sent_at timestamptz,
  email_sent_by uuid references auth.users(id),

  fulfilled_at timestamptz,
  fulfilled_by uuid references auth.users(id),

  due_date date,
  created_at timestamptz not null default now()
);

create index if not exists idx_fulfillment_queue_due on public.fulfillment_queue (due_date asc);
create index if not exists idx_fulfillment_queue_step on public.fulfillment_queue (step);

alter table public.fulfillment_queue enable row level security;

create policy "fulfillment_queue_select"
  on public.fulfillment_queue for select
  to authenticated using (true);

create policy "fulfillment_queue_insert"
  on public.fulfillment_queue for insert
  to authenticated with check (true);

create policy "fulfillment_queue_update"
  on public.fulfillment_queue for update
  to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.fulfillment_queue;

-- Auto-enqueue trigger: when orders.status flips to 'approved', insert a queue row.
create or replace function public.auto_enqueue_approved_order()
returns trigger language plpgsql as $$
begin
  if new.status = 'approved' and (old.status is null or old.status <> 'approved') then
    insert into public.fulfillment_queue (order_id, due_date)
    values (new.id, (now() + interval '7 days')::date)
    on conflict (order_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists auto_enqueue_on_approve on public.orders;
create trigger auto_enqueue_on_approve
  after update of status on public.orders
  for each row execute function public.auto_enqueue_approved_order();
