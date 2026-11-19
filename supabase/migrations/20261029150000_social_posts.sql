-- Per-post organic social metrics across platforms, for the Social tab's
-- cross-platform post comparison (same posted_date = same content, since the
-- team posts together). Populated by the sync-*-organic edge functions
-- (facebook/instagram via sync-social-organic, youtube, tiktok; linkedin later).
create table if not exists public.social_posts (
  platform text not null,
  post_id text not null,
  posted_at timestamptz,
  posted_date date,
  caption text,
  permalink text,
  media_type text,
  views bigint,
  likes bigint,
  comments bigint,
  shares bigint,
  reach bigint,
  engagement bigint,
  raw jsonb,
  synced_at timestamptz default now(),
  primary key (platform, post_id)
);
create index if not exists social_posts_date_idx on public.social_posts (posted_date desc);
alter table public.social_posts enable row level security;
create policy internal_only on public.social_posts for all using (is_internal_user());
