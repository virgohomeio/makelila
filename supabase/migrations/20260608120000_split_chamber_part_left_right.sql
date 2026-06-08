-- Backlog #87 — Split the single "Composter Chamber" replacement part into
-- separate left- and right-side rows.
--
-- The Lila Pro has two physically distinct, non-interchangeable chambers (the
-- same split telemetry uses for chamber_motor_left / chamber_motor_right, see
-- backlog #70). Tracking them as one `LILA-CHAMBER` part can't represent a
-- side-specific defect or fulfil it correctly, and the #82 stock projection
-- would mis-net per-side demand.
--
-- The legacy P-CHAMBER row has on_hand = 0 and no part_shipments referencing
-- it, so it is removed. Historical replacement-order line_items keep their
-- denormalized snapshot (they reference the SKU string, not parts.id) and are
-- unaffected.
--
-- Idempotent: inserts use ON CONFLICT DO NOTHING; the delete is guarded on
-- on_hand = 0 so a re-run never drops a row that has since gained stock.

insert into public.parts
  (id, sku, name, category, kind, supplier, cost_per_unit_usd, on_hand, reorder_point, location, notes)
values
  ('P-CHAMBER-L', 'LILA-CHAMBER-L', 'Composter Chamber (Left)',  'replacement', 'chamber',
   'Dongguan LC Technology', null, 0, 5, 'Toronto warehouse',
   'Left-side replacement composter chamber. Split from LILA-CHAMBER (#87).'),
  ('P-CHAMBER-R', 'LILA-CHAMBER-R', 'Composter Chamber (Right)', 'replacement', 'chamber',
   'Dongguan LC Technology', null, 0, 5, 'Toronto warehouse',
   'Right-side replacement composter chamber. Split from LILA-CHAMBER (#87).')
on conflict (id) do nothing;

delete from public.parts where id = 'P-CHAMBER' and on_hand = 0;
