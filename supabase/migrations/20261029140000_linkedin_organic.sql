-- LinkedIn organic sync: OAuth token store → social_metrics (channel = 'linkedin').
-- Pulls follower count (networkSizes) + trailing-28d reach/impressions/engagement
-- (organizationalEntityShareStatistics) via the Community Management API. OAuth is
-- captured once by linkedin-connect / linkedin-callback; access tokens last ~60
-- days and refresh when a refresh token is present. The daily cron is added once
-- LinkedIn approves the app and the first token is stored.
-- Secrets: LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, LINKEDIN_ORG_ID (optional).

create table if not exists public.linkedin_oauth (
  id int primary key default 1,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  refresh_expires_at timestamptz,
  scope text,
  updated_at timestamptz default now(),
  constraint linkedin_oauth_singleton check (id = 1)
);
-- RLS on, no policies: only the service role (edge functions) can touch tokens.
alter table public.linkedin_oauth enable row level security;
