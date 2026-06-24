-- Organic social metrics, one row per (channel, day). Feeds the Marketing →
-- Social tab. Each platform's sync edge function upserts its own channel rows;
-- the table is channel-agnostic so Facebook/Instagram/YouTube/LinkedIn/TikTok
-- all share one shape. raw jsonb keeps the full provider payload for forensics.

create table if not exists public.social_metrics (
  id          uuid primary key default gen_random_uuid(),
  channel     text not null check (channel in ('facebook','instagram','youtube','linkedin','tiktok')),
  as_of       date not null,
  followers   integer,
  reach       integer,
  impressions integer,
  engagement  integer,
  posts       integer,
  views       integer,
  raw         jsonb,
  synced_at   timestamptz not null default now(),
  unique (channel, as_of)
);

create index if not exists idx_social_metrics_channel on public.social_metrics (channel, as_of desc);

alter table public.social_metrics enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='social_metrics' and policyname='internal_only'
  ) then
    execute $p$
      create policy internal_only on public.social_metrics
        using (public.is_internal_user())
        with check (public.is_internal_user())
    $p$;
  end if;
end $$;
