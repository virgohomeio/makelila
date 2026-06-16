-- Lead attribution fields for Pedrum's CAC-by-channel and CampaignsTab views.
-- first_touch_* is written once at customer creation and never overwritten.
-- last_touch_* is updated by updateLastTouch() on subsequent marketing interactions.
ALTER TABLE customers
  ADD COLUMN first_touch_source      text NULL,
  ADD COLUMN first_touch_campaign_id text NULL,
  ADD COLUMN first_touch_at          timestamptz NULL,
  ADD COLUMN last_touch_source       text NULL,
  ADD COLUMN last_touch_campaign_id  text NULL,
  ADD COLUMN last_touch_at           timestamptz NULL;

CREATE INDEX idx_customers_first_touch_campaign
  ON customers(first_touch_campaign_id)
  WHERE first_touch_campaign_id IS NOT NULL;

CREATE INDEX idx_customers_last_touch_campaign
  ON customers(last_touch_campaign_id)
  WHERE last_touch_campaign_id IS NOT NULL;
