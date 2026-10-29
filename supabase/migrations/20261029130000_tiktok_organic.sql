-- TikTok organic sync: OAuth token store + daily cron → social_metrics
-- (channel = 'tiktok'). Pulls follower/video counts + trailing-28d engagement
-- via the TikTok Display API. OAuth is captured once by tiktok-connect /
-- tiktok-callback; access tokens last 24h so sync-tiktok-organic refreshes on
-- every run. Secrets: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET.

create table if not exists public.tiktok_oauth (
  id int primary key default 1,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  open_id text,
  scope text,
  updated_at timestamptz default now(),
  constraint tiktok_oauth_singleton check (id = 1)
);
-- RLS on, no policies: only the service role (edge functions) can touch tokens.
alter table public.tiktok_oauth enable row level security;

select cron.schedule(
  'sync-tiktok-organic-daily',
  '50 7 * * *',
  $$select public.invoke_edge_function('sync-tiktok-organic', '{}'::jsonb)$$
);
