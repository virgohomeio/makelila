-- Finance module: QBO daily journals + OAuth credential store.
-- See docs/session-notes/huayi.md §Feature 5.
--
-- Creates two tables:
--   qbo_daily_journals  — one row per (date, currency, payment_channel),
--                         aggregated by the qbo-daily-summary edge function
--                         and posted to QBO as journal entries.
--   qbo_oauth           — single-row credential store for the QBO OAuth
--                         tokens; only the service-role edge function
--                         reads/writes this.
--
-- RLS pattern:
--   qbo_daily_journals: is_finance() may SELECT and UPDATE; INSERT/DELETE
--     are service-role-only (no permissive policy → RLS blocks client).
--   qbo_oauth: no client-side policies at all; service-role bypasses RLS.
--
-- Both tables are added to the supabase_realtime publication idempotently.

-- ─────────────────────────────────────────────────────────────
-- 1. qbo_daily_journals
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.qbo_daily_journals (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  date            date        NOT NULL,
  currency        text        NOT NULL CHECK (currency IN ('CAD', 'USD')),
  payment_channel text        NOT NULL,
  gross_sales     numeric(12,2) NOT NULL,
  discounts       numeric(12,2) NOT NULL DEFAULT 0,
  refunds         numeric(12,2) NOT NULL DEFAULT 0,
  tax_collected   numeric(12,2) NOT NULL DEFAULT 0,
  shipping        numeric(12,2) NOT NULL DEFAULT 0,
  fees            numeric(12,2) NOT NULL DEFAULT 0,
  net_deposit     numeric(12,2) NOT NULL,
  qbo_journal_id  text,
  posted_at       timestamptz,
  error           text,
  created_at      timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS qbo_daily_journals_date_currency_channel_idx
  ON public.qbo_daily_journals (date, currency, payment_channel);

ALTER TABLE public.qbo_daily_journals ENABLE ROW LEVEL SECURITY;

-- Finance users may read all journal rows
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'qbo_daily_journals'
      AND policyname = 'qbo_daily_journals_finance_select'
  ) THEN
    CREATE POLICY qbo_daily_journals_finance_select
      ON public.qbo_daily_journals
      FOR SELECT
      TO authenticated
      USING (is_finance(auth.uid()));
  END IF;
END $$;

-- Finance users may update existing rows (e.g. manual correction, re-post)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'qbo_daily_journals'
      AND policyname = 'qbo_daily_journals_finance_update'
  ) THEN
    CREATE POLICY qbo_daily_journals_finance_update
      ON public.qbo_daily_journals
      FOR UPDATE
      TO authenticated
      USING (is_finance(auth.uid()))
      WITH CHECK (is_finance(auth.uid()));
  END IF;
END $$;

-- INSERT and DELETE: no permissive policy → RLS blocks authenticated users.
-- The cron edge function uses the service_role key which bypasses RLS entirely.

-- ─────────────────────────────────────────────────────────────
-- 2. qbo_oauth
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.qbo_oauth (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  qbo_realm_id              text        NOT NULL,
  qbo_access_token          text        NOT NULL,
  qbo_refresh_token         text        NOT NULL,
  access_token_expires_at   timestamptz NOT NULL,
  refresh_token_expires_at  timestamptz NOT NULL,
  updated_at                timestamptz DEFAULT now()
);

ALTER TABLE public.qbo_oauth ENABLE ROW LEVEL SECURITY;

-- No client-side SELECT or write policies.
-- Only the service-role edge function accesses this table; it bypasses RLS.

-- ─────────────────────────────────────────────────────────────
-- 3. Realtime publication (idempotent)
-- ─────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname   = 'supabase_realtime'
      AND tablename = 'qbo_daily_journals'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.qbo_daily_journals;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname   = 'supabase_realtime'
      AND tablename = 'qbo_oauth'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.qbo_oauth;
  END IF;
END $$;
