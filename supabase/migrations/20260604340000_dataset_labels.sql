-- Backlog #61 V1 — dataset_labels table for ML training pairs.
-- Operators capture customer-confirmed signals (smelly / dry / etc.) by
-- tagging a telemetry window. Each label is paired with the BME sensor
-- data over the same window to become training data for future
-- classifiers (smell-detection in particular — see #61 backlog body).

create table if not exists public.dataset_labels (
  id              uuid primary key default gen_random_uuid(),
  serial_number   text not null,
  started_at      timestamptz not null,
  ended_at        timestamptz not null,
  label           text not null check (label in ('smelly','no_smell','dry','wet','mixing','not_mixing','other')),
  source          text not null default 'operator_inferred' check (source in ('sms','phone','ticket','in_person','operator_inferred')),
  confidence      text not null default 'customer_reported' check (confidence in ('customer_reported','operator_inferred')),
  notes           text,
  linked_ticket_id uuid references public.service_tickets(id) on delete set null,
  labeled_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  check (ended_at >= started_at)
);

create index if not exists dataset_labels_serial_idx
  on public.dataset_labels(serial_number, started_at desc);
create index if not exists dataset_labels_label_idx
  on public.dataset_labels(label);

-- RLS: internal-only. Same gating pattern used elsewhere.
alter table public.dataset_labels enable row level security;

drop policy if exists "dataset_labels_select" on public.dataset_labels;
create policy "dataset_labels_select" on public.dataset_labels
  for select to authenticated using (public.is_internal_user());

drop policy if exists "dataset_labels_insert" on public.dataset_labels;
create policy "dataset_labels_insert" on public.dataset_labels
  for insert to authenticated
  with check (public.is_internal_user() and auth.uid() = labeled_by);

drop policy if exists "dataset_labels_update" on public.dataset_labels;
create policy "dataset_labels_update" on public.dataset_labels
  for update to authenticated using (public.is_internal_user())
  with check (public.is_internal_user());

drop policy if exists "dataset_labels_delete" on public.dataset_labels;
create policy "dataset_labels_delete" on public.dataset_labels
  for delete to authenticated using (public.is_internal_user());
