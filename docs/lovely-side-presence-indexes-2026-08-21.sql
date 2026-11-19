-- ============================================================
-- FOR the lilalovely Supabase project (arfdopgbvlfmhmcfghhl).
-- NOT a makelila migration — do not put this in supabase/migrations/.
--
-- STATUS: APPLIED 2026-08-21 by ry0rr1v1@gmail.com via Supabase MCP.
-- All three indexes built valid; the lookup below went 11,717ms -> 2.1ms.
-- Kept here as the source-of-truth record for the beta-lovely repo.
--
-- Why
-- ---
-- The three presence tables are indexed only on their primary key,
-- (created_at, serial_number). Every lookup of "when did THIS serial last
-- report" filters on serial_number and orders by created_at, so Postgres has
-- to scan the whole index backward:
--
--   explain analyze
--   select created_at from bme_sensors
--   where serial_number = 'LL01-00000099999'
--   order by created_at desc limit 1;
--
--   Index Only Scan Backward using bme_sensors_pkey
--     (actual time=11706.113..11706.768 rows=0)
--   Execution Time: 11717.866 ms
--
-- 11.7s is past the PostgREST statement timeout, so the makelila Activity tab
-- (lib/dashboard.ts fetchTelemetryPresence) got an error instead of presence
-- data and every unit rendered as down. Worst case is exactly the dead serials
-- — no rows to stop the scan early — which are the ones that reach that query.
--
-- These indexes make the same lookup an instant single-row fetch. The client
-- was also changed to bound its query by created_at so it stays fast without
-- them; this restores the exact last-seen date for long-dead units.
--
-- CONCURRENTLY so the ingest path is never blocked. Each statement must run on
-- its own — CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so
-- run them ONE AT A TIME, not as a single multi-statement paste.
-- Expect a few minutes each: ~3M rows in bme_sensors, ~2.4M in events,
-- ~1.4M in temperature_sensors as of 2026-08-12.
-- ============================================================

create index concurrently if not exists bme_sensors_serial_recent_idx
  on public.bme_sensors (serial_number, created_at desc);

create index concurrently if not exists events_serial_recent_idx
  on public.events (serial_number, created_at desc);

create index concurrently if not exists temperature_sensors_serial_recent_idx
  on public.temperature_sensors (serial_number, created_at desc);

-- Verify: should report "Index Only Scan using <table>_serial_recent_idx"
-- with an execution time in single-digit milliseconds.
--
--   explain analyze
--   select created_at from bme_sensors
--   where serial_number = 'LL01-00000099999'
--   order by created_at desc limit 1;
--
-- If any index build fails partway it leaves an INVALID index behind; drop it
-- (drop index concurrently <name>) before retrying.
