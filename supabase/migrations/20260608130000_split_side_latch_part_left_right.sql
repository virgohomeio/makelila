-- Split the single "Side Latch" replacement part into separate left- and
-- right-side rows (same rationale as the chamber split in
-- 20260608120000_split_chamber_part_left_right.sql, backlog #87).
--
-- The Lila Pro has a left and a right side latch; they are not interchangeable
-- as replacement parts, so a side-specific breakage needs the matching side.
-- Tracking them as one LILA-LATCH-SIDE row can't represent or fulfil that
-- correctly, and the #82 stock projection would mis-net per-side demand.
--
-- The legacy P-LATCH-SIDE row has on_hand = 0 and no part_shipments referencing
-- it, so it is removed. Historical replacement-order line_items keep their
-- denormalized SKU snapshot and are unaffected.
--
-- Idempotent: inserts use ON CONFLICT DO NOTHING; the delete is guarded on
-- on_hand = 0 so a re-run never drops a row that has since gained stock.

insert into public.parts
  (id, sku, name, category, kind, supplier, cost_per_unit_usd, on_hand, reorder_point, location, notes)
values
  ('P-LATCH-SIDE-L', 'LILA-LATCH-SIDE-L', 'Side Latch (Left)',  'replacement', 'side-latch',
   null, null, 0, 5, 'Toronto warehouse',
   'Left side latch — common breakage point. Split from LILA-LATCH-SIDE (#87).'),
  ('P-LATCH-SIDE-R', 'LILA-LATCH-SIDE-R', 'Side Latch (Right)', 'replacement', 'side-latch',
   null, null, 0, 5, 'Toronto warehouse',
   'Right side latch — common breakage point. Split from LILA-LATCH-SIDE (#87).')
on conflict (id) do nothing;

delete from public.parts where id = 'P-LATCH-SIDE' and on_hand = 0;
