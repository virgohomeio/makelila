-- Add expected_arrival_date to batches (null = already arrived)
ALTER TABLE batches ADD COLUMN IF NOT EXISTS expected_arrival_date date;

-- Production projection snapshots (one row per batch per cron run)
CREATE TABLE IF NOT EXISTS production_projection_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of timestamptz NOT NULL DEFAULT now(),
  batch_id uuid NOT NULL REFERENCES batches(id),
  ready_count int NOT NULL,
  reserved_count int NOT NULL,
  weekly_velocity numeric(10,2) NOT NULL,
  projected_stockout_date date,
  inbound_units int NOT NULL DEFAULT 0,
  inbound_arrival_date date,
  replacement_queue_size int NOT NULL DEFAULT 0,
  risk_level text NOT NULL CHECK (risk_level IN ('green','amber','red')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE production_projection_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "finance_select" ON production_projection_snapshots
  FOR SELECT USING (is_finance(auth.uid()));

-- Add to realtime publication idempotently
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE production_projection_snapshots;
EXCEPTION WHEN others THEN NULL; END $$;
