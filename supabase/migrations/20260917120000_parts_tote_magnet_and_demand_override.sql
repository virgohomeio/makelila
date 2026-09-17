-- Parts & Consumables: Tote Bags + Magnets, and a manual Demand override.
--
-- 1. Two new consumables, counted by hand at 32 each (2026-09-17).
--    Supplier, cost, reorder point and location are unknown for now and are editable
--    in Stock › Parts.
--
-- 2. parts.demand_override. The Demand column is derived from un-shipped
--    replacement orders (replacementDemandBySku), which can't see demand the
--    orders don't encode. When an operator types a number it wins everywhere
--    Demand is read (Stock › Parts, Service › Replacement supply panel);
--    clearing it (null) falls back to the derived count.

alter table public.parts
  add column if not exists demand_override int
    check (demand_override is null or demand_override >= 0);

insert into public.parts
  (id, sku, name, category, kind, supplier, cost_per_unit_usd, on_hand, reorder_point, location, notes)
values
  ('C-TOTE',   'LILA-TOTE',   'Tote Bag', 'consumable', 'tote',   null, null, 32, 0, null, null),
  ('C-MAGNET', 'LILA-MAGNET', 'Magnet',   'consumable', 'magnet', null, null, 32, 0, null, null)
on conflict do nothing;
