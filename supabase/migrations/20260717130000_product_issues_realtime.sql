-- supabase/migrations/20260717130000_product_issues_realtime.sql
--
-- Final review finding: 20260717120000_product_issues.sql created
-- public.product_issues but never added it to the supabase_realtime
-- publication. Repo convention (18 existing migrations, e.g.
-- 20260417023607_activity_log.sql:30) is that every table a frontend hook
-- subscribes to via postgres_changes must be explicitly added here —
-- supabase_realtime is not "all tables" by default. Without this,
-- useProductIssues()'s INSERT subscription (app/src/lib/products.ts)
-- subscribes successfully but silently never receives events, breaking the
-- "live updates, no refresh needed" behavior the Products dashboard and
-- issue-intake chat are built around.

alter publication supabase_realtime add table public.product_issues;
