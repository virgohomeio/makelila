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

-- Initial registry: add the Notion pages to track.
-- How to find a page ID: open the page in Notion → Share → Copy link.
-- The URL looks like https://www.notion.so/Title-{32-char-id-without-dashes}
-- Strip dashes from the ID before inserting (e.g. c9f63b89... not c9f6-3b89-...).
-- Share each page with the 'makeLILA KMS Sync' integration before syncing.

insert into public.kms_pages (notion_page_id, section, label, notion_url)
values
  -- Replace these IDs with real ones from Notion URLs.
  -- Engineering Hub (find from Notion sidebar → Engineering Hub → each child page URL)
  ('REPLACE_lila_pro_lovely_prd',   'Engineering', 'LILA Pro + Lovely PRD',    'https://www.notion.so/'),
  ('REPLACE_lila_mini_prd',         'Engineering', 'LILA Mini PRD',            'https://www.notion.so/'),
  ('REPLACE_lila_p50n_prd',         'Engineering', 'LILA P50N PRD',            'https://www.notion.so/'),
  ('REPLACE_mrd',                   'Engineering', 'Market Requirements Doc',   'https://www.notion.so/'),
  ('REPLACE_design_process_matrix', 'Engineering', 'Design Process Matrix',     'https://www.notion.so/'),
  -- Operations / top-level
  ('c9f63b8915b14a5f976b1716b6d153f9', 'Company', 'VCycene Workspace Root', 'https://www.notion.so/VCycene-c9f63b8915b14a5f976b1716b6d153f9')
on conflict (notion_page_id) do nothing;
