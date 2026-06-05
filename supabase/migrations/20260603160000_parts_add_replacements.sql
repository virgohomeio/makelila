-- Add three replacement parts to the Replacement Stock list (parts catalog,
-- category='replacement'). on_hand starts at 0 — ops adjusts via the Parts tab.
insert into public.parts
  (id, sku, name, category, kind, supplier, cost_per_unit_usd, on_hand, reorder_point, location, notes)
values
  ('P-FILTER', 'LILA-FILTER', 'Filtration Module',
    'replacement', 'filtration', null, null,
    0, 5, 'Toronto warehouse',
    'Replacement filtration module.'),
  ('P-LATCH-SIDE', 'LILA-LATCH-SIDE', 'Side Latch',
    'replacement', 'side-latch', null, null,
    0, 5, 'Toronto warehouse',
    'Side latch — common breakage point.'),
  ('P-HOPPER', 'LILA-HOPPER', 'Hopper',
    'replacement', 'hopper', null, null,
    0, 5, 'Toronto warehouse',
    'Hopper — can be missed during packaging/shipping; verify it is included before shipping.')
on conflict (id) do nothing;
