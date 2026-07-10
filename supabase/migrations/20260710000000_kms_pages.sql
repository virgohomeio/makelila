-- supabase/migrations/20260710000000_kms_pages.sql

create table public.kms_pages (
  id                   uuid        primary key default gen_random_uuid(),
  notion_page_id       text        not null unique,
  section              text        not null,        -- wiki section label, e.g. 'Engineering'
  label                text        not null,        -- page display label, e.g. 'LILA Pro PRD'
  notion_url           text,
  -- populated by sync-notion-kms-metadata
  title                text,
  last_edited_by_name  text,
  last_edited_time     timestamptz,
  synced_at            timestamptz
);

alter table public.kms_pages enable row level security;

create policy "internal users can read kms_pages"
  on public.kms_pages for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_internal = true
    )
  );

-- Initial registry: one real row is seeded here.
-- To add more pages: open the Notion page → Share → Copy link.
-- The URL looks like https://www.notion.so/Title-{32-char-id-without-dashes}
-- Strip dashes from the ID before inserting (e.g. c9f63b89... not c9f6-3b89-...).
-- Share each page with the 'makeLILA KMS Sync' integration, then add rows via
-- Supabase Dashboard → SQL Editor → INSERT INTO public.kms_pages ...

insert into public.kms_pages (notion_page_id, section, label, notion_url)
values
  ('c9f63b8915b14a5f976b1716b6d153f9', 'Company', 'VCycene Workspace Root', 'https://www.notion.so/VCycene-c9f63b8915b14a5f976b1716b6d153f9')
on conflict (notion_page_id) do nothing;
