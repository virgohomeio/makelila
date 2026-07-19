-- supabase/migrations/20260718120000_product_issue_references.sql
--
-- Adds multi-reference support (GitHub/Notion/doc links) to product issues,
-- replacing the single unused product_issues.link column — verified 0 of 51
-- existing rows have it set, so no data loss.
-- Spec: docs/superpowers/specs/2026-07-18-issue-reference-links-design.md

alter table public.product_issues drop column link;

create table public.product_issue_references (
  id         uuid primary key default gen_random_uuid(),
  issue_id   uuid not null references public.product_issues(id) on delete cascade,
  url        text not null,
  kind       text not null default 'other' check (kind in ('github','notion','doc','other')),
  created_at timestamptz not null default now()
);

alter table public.product_issue_references enable row level security;

create policy "internal users can read product_issue_references"
  on public.product_issue_references for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_internal = true
    )
  );

-- No insert/update policy: all writes go through the product-issue-chat
-- edge function's service-role client. Same pattern as product_issues.

alter publication supabase_realtime add table public.product_issue_references;
