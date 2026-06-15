-- Customer invoices / refund receipts attachment store.
-- Lets operators attach QB-generated PDFs to customer profiles.
-- In future, QB→Shopify auto-sync will populate this directly.
--
-- Storage bucket: customer-invoices (private, signed URLs only)
-- Table: customer_invoices

-- ============================================================ table

create table if not exists public.customer_invoices (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid references public.customers(id) on delete set null,
  invoice_number  text not null,
  document_type   text not null default 'invoice'
                  check (document_type in ('invoice', 'refund_receipt')),
  file_name       text not null,
  storage_path    text not null unique,
  invoice_date    date,
  total_cad       numeric(10,2),
  bill_to_name    text,       -- extracted from PDF; used for unassigned-invoice matching
  notes           text,
  uploaded_by     text,
  created_at      timestamptz not null default now()
);

alter table public.customer_invoices enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'customer_invoices'
      and policyname = 'internal_only'
  ) then
    execute $p$
      create policy internal_only on public.customer_invoices
        using (public.is_internal_user())
        with check (public.is_internal_user())
    $p$;
  end if;
end $$;

create index if not exists idx_customer_invoices_customer
  on public.customer_invoices (customer_id);

create index if not exists idx_customer_invoices_number
  on public.customer_invoices (invoice_number);

-- Unassigned invoices (customer_id IS NULL) for operator review
create index if not exists idx_customer_invoices_unassigned
  on public.customer_invoices (created_at desc)
  where customer_id is null;

-- ============================================================ storage bucket

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'customer-invoices',
  'customer-invoices',
  false,
  10485760,  -- 10 MB per file
  array['application/pdf']
)
on conflict (id) do nothing;

-- Storage RLS: internal users only

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename  = 'objects'
      and policyname = 'customer_invoices_read'
  ) then
    execute $p$
      create policy customer_invoices_read on storage.objects
        for select using (
          bucket_id = 'customer-invoices'
          and public.is_internal_user()
        )
    $p$;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename  = 'objects'
      and policyname = 'customer_invoices_insert'
  ) then
    execute $p$
      create policy customer_invoices_insert on storage.objects
        for insert with check (
          bucket_id = 'customer-invoices'
          and public.is_internal_user()
        )
    $p$;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename  = 'objects'
      and policyname = 'customer_invoices_delete'
  ) then
    execute $p$
      create policy customer_invoices_delete on storage.objects
        for delete using (
          bucket_id = 'customer-invoices'
          and public.is_internal_user()
        )
    $p$;
  end if;
end $$;
