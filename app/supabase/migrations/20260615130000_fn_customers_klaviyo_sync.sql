-- Returns customers with lifecycle state for Klaviyo profile sync.
-- Uses journey_stage_override as the CJM stage signal; joins returns via
-- customer_email since the returns table has no customer_id FK.
CREATE OR REPLACE FUNCTION get_customers_for_klaviyo_sync()
RETURNS TABLE (
  id                 text,
  email              text,
  name               text,
  phone              text,
  stage              text,
  has_return         boolean,
  klaviyo_profile_id text,
  last_fulfilled_at  timestamptz,
  first_order_at     timestamptz,
  order_count        bigint
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    c.id::text,
    c.email,
    c.full_name AS name,
    c.phone,
    c.journey_stage_override AS stage,
    EXISTS (
      SELECT 1 FROM returns r
      WHERE lower(trim(r.customer_email)) = lower(trim(c.email))
    ) AS has_return,
    c.klaviyo_profile_id,
    MAX(o.shipped_at) AS last_fulfilled_at,
    MIN(o.placed_at)  AS first_order_at,
    COUNT(DISTINCT o.id) AS order_count
  FROM customers c
  LEFT JOIN orders o ON o.customer_id = c.id AND o.kind = 'sale'
  WHERE c.email IS NOT NULL
  GROUP BY c.id, c.email, c.full_name, c.phone, c.journey_stage_override, c.klaviyo_profile_id
$$;
