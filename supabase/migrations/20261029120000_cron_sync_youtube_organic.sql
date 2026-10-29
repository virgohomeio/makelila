-- Daily organic YouTube sync → social_metrics (channel = 'youtube').
-- Pulls subscriber/view/video counts + trailing-28d engagement via the YouTube
-- Data API v3 (API key, public data). Mirrors the other sync-* cron jobs.
-- Secrets (Edge Function): YOUTUBE_API_KEY, optional YOUTUBE_CHANNEL_ID /
-- YOUTUBE_HANDLE (defaults to @vcycene).
select cron.schedule(
  'sync-youtube-organic-daily',
  '40 7 * * *',
  $$select public.invoke_edge_function('sync-youtube-organic', '{}'::jsonb)$$
);
