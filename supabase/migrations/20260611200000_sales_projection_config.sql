-- finance_config: key-value store for Finance module settings
CREATE TABLE IF NOT EXISTS finance_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_key text NOT NULL UNIQUE,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id)
);
ALTER TABLE finance_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "finance_select" ON finance_config
  FOR SELECT USING (is_finance(auth.uid()));
CREATE POLICY "finance_update" ON finance_config
  FOR UPDATE USING (is_finance(auth.uid()));

-- Seed default seasonality (all months = 1.0)
INSERT INTO finance_config (config_key, value) VALUES
  ('seasonality', '{"1":1.0,"2":1.0,"3":1.0,"4":1.0,"5":1.0,"6":1.0,"7":1.0,"8":1.0,"9":1.0,"10":1.0,"11":1.0,"12":1.0}'),
  ('revenue_okr_quarterly_cad', '{"amount":0,"label":"Q revenue target (CAD)"}')
ON CONFLICT (config_key) DO NOTHING;

-- sales_projection_snapshots
CREATE TABLE IF NOT EXISTS sales_projection_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of timestamptz NOT NULL DEFAULT now(),
  horizon_days int NOT NULL CHECK (horizon_days IN (30, 60, 90)),
  model text NOT NULL DEFAULT 'rolling_average',
  projected_revenue_cad numeric(14,2) NOT NULL,
  projected_revenue_usd numeric(14,2) NOT NULL,
  lower_bound_cad numeric(14,2) NOT NULL,
  upper_bound_cad numeric(14,2) NOT NULL,
  breakdown jsonb NOT NULL DEFAULT '[]',
  inputs jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sales_projection_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "finance_select" ON sales_projection_snapshots
  FOR SELECT USING (is_finance(auth.uid()));

-- Add to realtime publication
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE finance_config;
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE sales_projection_snapshots;
EXCEPTION WHEN others THEN NULL; END $$;
