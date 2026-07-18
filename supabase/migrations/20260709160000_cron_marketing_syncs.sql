-- Auto-refresh every marketing analytics sync on a schedule so operators never
-- have to click the per-tab "Sync" buttons. Uses the existing cron → edge
-- function bridge (public.invoke_edge_function, which attaches X-Cron-Secret).
--
-- These sources aggregate daily and are rate-limited, so we refresh on a cadence
-- (not literal real-time). Minutes are staggered to avoid a thundering herd.
--
-- cron.schedule upserts by job name, so re-running this migration is safe.

-- Meta Ads (campaign + ad level) — intraday numbers move, refresh every 3h.
select cron.schedule(
  'sync-facebook-ads-3h',
  '5 */3 * * *',
  $q$select public.invoke_edge_function('sync-facebook-ads', '{}'::jsonb)$q$
);

-- Meta purchase demographics (age×gender×country×day) — heavier, once a day.
select cron.schedule(
  'sync-fb-demographics-daily',
  '20 8 * * *',
  $q$select public.invoke_edge_function('sync-fb-demographics', '{}'::jsonb)$q$
);

-- Link customers → Klaviyo profile ids (prerequisite for the events pull).
-- Runs at :05, ahead of the :15 events pull.
select cron.schedule(
  'klaviyo-link-profiles-3h',
  '5 */3 * * *',
  $q$select public.invoke_edge_function('sync-klaviyo-profile-ids', '{}'::jsonb)$q$
);

-- Klaviyo email events — feed the customer journey, refresh every 3h.
select cron.schedule(
  'klaviyo-pull-events-3h',
  '15 */3 * * *',
  $q$select public.invoke_edge_function('klaviyo-pull-events', '{}'::jsonb)$q$
);

-- Klaviyo email campaign performance (Email tab) — daily is plenty.
select cron.schedule(
  'sync-klaviyo-campaigns-daily',
  '55 7 * * *',
  $q$select public.invoke_edge_function('sync-klaviyo-campaigns', '{}'::jsonb)$q$
);

-- GA4 (Shopify/website analytics) — intraday available, refresh every 6h.
select cron.schedule(
  'sync-ga4-6h',
  '25 */6 * * *',
  $q$select public.invoke_edge_function('sync-ga4', '{}'::jsonb)$q$
);

-- Organic social (FB/IG/YouTube/LinkedIn/TikTok) — daily stats, once a day.
select cron.schedule(
  'sync-social-organic-daily',
  '35 7 * * *',
  $q$select public.invoke_edge_function('sync-social-organic', '{}'::jsonb)$q$
);

-- Search Console — data lags ~2 days, once a day is plenty.
select cron.schedule(
  'sync-search-console-daily',
  '45 7 * * *',
  $q$select public.invoke_edge_function('sync-search-console', '{}'::jsonb)$q$
);
