-- Facebook campaign performance snapshots.
-- One row per campaign per sync run. Upsert on (campaign_id, date_start).
CREATE TABLE fb_campaigns (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    text        NOT NULL,
  campaign_name  text        NOT NULL,
  status         text        NOT NULL,
  objective      text        NULL,
  date_start     date        NOT NULL,
  date_stop      date        NOT NULL,
  spend_cad      numeric(12,2) NULL,
  impressions    int         NULL,
  clicks         int         NULL,
  leads          int         NULL,
  cpl_cad        numeric(10,2) GENERATED ALWAYS AS (
    CASE WHEN COALESCE(leads,0) > 0 THEN spend_cad / leads ELSE NULL END
  ) STORED,
  synced_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_fb_campaigns_upsert
  ON fb_campaigns(campaign_id, date_start);

CREATE INDEX idx_fb_campaigns_date
  ON fb_campaigns(date_start DESC);
