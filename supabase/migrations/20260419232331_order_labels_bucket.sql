-- order-labels: private bucket for shipping label PDFs uploaded during Step 3.
-- Path convention: <order_id>/label-<timestamp>.pdf
insert into storage.buckets (id, name, public)
values ('order-labels', 'order-labels', false)
on conflict (id) do nothing;

-- Authenticated users can read any label.
create policy "order_labels_select"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'order-labels');

-- Authenticated users can upload labels.
create policy "order_labels_insert"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'order-labels');

-- Authenticated users can replace labels.
create policy "order_labels_update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'order-labels')
  with check (bucket_id = 'order-labels');
