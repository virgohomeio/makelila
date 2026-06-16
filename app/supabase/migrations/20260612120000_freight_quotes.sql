-- Freight quote history. Insert-only — re-quoting appends rows, never overwrites.
-- Exactly one row per order may have selected=true (enforced by partial unique index).
CREATE TABLE freight_quotes (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider      text        NOT NULL CHECK (provider IN ('clickship','freightcom')),
  service_level text        NOT NULL,
  rate_cad      numeric(10,2) NULL,
  rate_usd      numeric(10,2) NULL,
  transit_days  int         NULL,
  quoted_at     timestamptz NOT NULL DEFAULT now(),
  selected      boolean     NOT NULL DEFAULT false,
  raw           jsonb       NOT NULL
);

CREATE INDEX idx_freight_quotes_order
  ON freight_quotes(order_id, quoted_at DESC);

-- Enforces at most one selected=true row per order at the DB level.
CREATE UNIQUE INDEX idx_freight_quotes_one_selected
  ON freight_quotes(order_id)
  WHERE selected = true;
