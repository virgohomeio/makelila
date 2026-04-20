-- Apply 2026-04-20 inventory-status.md update #2 to the units table.
--
-- Net new data vs the earlier snapshot migration:
--   - Six new P100 US shipments (Apr 15-16 2026)
--   - Two P100 serials queued / label-printed (status='reserved')
--   - Fifteen returned units (8 via MaxxUs return pickups, 7 via Canada
--     Fulfillment return pickups, plus Joan Teichroeb's earlier two units
--     after she ended up on her 3rd replacement). Return logic: unused →
--     'ready' (can go straight back on shelf); used with defect/damage →
--     'rework' (needs triage). Customer_name keeps the last possessor with
--     a "(returned)" suffix so ops can trace the unit's history without a
--     dedicated return-log table.

update public.units u set
  batch         = v.batch,
  status        = v.status,
  customer_name = nullif(v.customer_name, ''),
  location      = nullif(v.location, ''),
  carrier       = nullif(v.carrier, ''),
  defect_reason = nullif(v.defect_reason, ''),
  notes         = v.notes
from (values
  -- -------------------- P100 US shipments (Apr 15-16 2026) --------------------
  ('LL01-00000000323', 'P100', 'shipped',  'Antonio Cernuto',           '', 'UPS', '',                 'P100 US shipment 2026-04-15'),
  ('LL01-00000000289', 'P100', 'shipped',  'Rick Stauffer',             '', 'UPS', '',                 'P100 US shipment 2026-04-15'),
  ('LL01-00000000347', 'P100', 'shipped',  'Dale Bober',                '', 'UPS', '',                 'P100 US shipment 2026-04-16 (RTN-0032 other pending)'),
  ('LL01-00000000346', 'P100', 'shipped',  'Jacob Wenger',              '', 'UPS', '',                 'P100 US shipment 2026-04-16'),
  ('LL01-00000000345', 'P100', 'shipped',  'Cole Perkins',              '', 'UPS', '',                 'P100 US shipment 2026-04-16'),
  ('LL01-00000000329', 'P100', 'shipped',  'Tara Dupper',               '', 'UPS', '',                 'P100 US shipment 2026-04-16 (Sarah Harris also listed at 329 in md — treated as md typo)'),

  -- P100 US queued — serial assigned, label printed, not yet shipped
  ('LL01-00000000253', 'P100', 'reserved', 'Louis DiPalma',             '', 'UPS', '',                 'P100 US queued for 2026-04-22'),
  ('LL01-00000000267', 'P100', 'reserved', 'Kristen Pimentel',          '', 'UPS', '',                 'P100 US queued'),

  -- -------------------- Returned P50 originals (MaxxUs pickups, no replacement yet) --------------------
  ('LL01-00000000009', 'P50',  'rework',   'Jenny Pho (returned)',      'Toronto warehouse', '', 'Product Defect', 'Returned via MaxxUs pickup 2025-10-16. P50 VIP original, no replacement shipped.'),
  ('LL01-00000000012', 'P50',  'rework',   'Ellery Bunn (returned)',    'Toronto warehouse', '', 'Product Defect', 'Returned via MaxxUs pickup 2025-10-23 (P50 VIP original, then got P150 110 which also returned).'),
  ('LL01-00000000110', 'P150', 'rework',   'Ellery Bunn (returned)',    'Toronto warehouse', '', 'Product Defect', 'Returned via MaxxUs pickup 2026-01-06. Ellery''s P150 replacement that also came back.'),

  -- -------------------- Returned units via Canada Fulfillment pickups (Jan-Apr 2026) --------------------
  ('LL01-00000000019', 'P50',  'ready',    'Matthew Lypkie (returned)', 'Toronto warehouse', '', '',                'Returned unused via Canpar 2026-01-26 (RTN-0005 refunded). Fit for restock.'),
  ('LL01-00000000043', 'P50',  'rework',   'Sharai Mustatia (returned)','Toronto warehouse', '', 'Shipping Damage', 'Returned used via Canpar 2026-02-04 (RTN-0024 refunded). Needs inspection.'),
  ('LL01-00000000021', 'P50',  'rework',   'Don Saldana (returned)',    'Toronto warehouse', '', 'Software Issue',  'Returned used via Canpar 2026-02-17 (RTN-0026). Firmware fix required.'),
  ('LL01-00000000023', 'P50',  'rework',   'Shelley M Small (returned)','Toronto warehouse', '', 'Shipping Damage', 'Returned damaged via Canpar 2026-03-16 (RTN-0027).'),
  ('LL01-00000000082', 'P150', 'rework',   'Michael Haywood (returned)','Toronto warehouse', '', '',                'Returned via Canpar 2026-03-27. Condition pending triage.'),

  -- -------------------- Joan Teichroeb earlier units returned (now on 3rd replacement 109) --------------------
  ('LL01-00000000071', 'P150', 'rework',   'Joan Teichroeb (returned)', 'Toronto warehouse', '', 'Shipping Damage', 'Returned 2026-03-17. Joan then received P50N 239 as replacement.'),
  ('LL01-00000000239', 'P50N', 'rework',   'Joan Teichroeb (returned)', 'Toronto warehouse', '', '',                'Returned 2026-04-07. Joan then received P150 109 as 3rd replacement.')
) as v(serial, batch, status, customer_name, location, carrier, defect_reason, notes)
where u.serial = v.serial;

-- Stamp shipped_at for the new P100 shipments. Reserved (queued) rows have
-- no shipped_at yet — they'll get one when actually shipped.
update public.units
   set shipped_at = '2026-04-15 00:00:00+00'::timestamptz
 where serial in ('LL01-00000000323','LL01-00000000289');

update public.units
   set shipped_at = '2026-04-16 00:00:00+00'::timestamptz
 where serial in ('LL01-00000000347','LL01-00000000346','LL01-00000000345','LL01-00000000329');
