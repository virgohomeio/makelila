-- Parts list revision per 2026-04-20 product clarification:
--   - Add Composter Chamber (replacement for broken chambers)
--   - Remove Main Crushing Motor (P-MOTOR) — not stocked as ad-hoc replacement
--   - Remove OEM Shipping Box (C-BOX) — not centrally tracked
--   - Update Compost Starter Kit supplier from "Amazon (FBA)" to "VCycene"
--     (we source the kits ourselves now, not via Amazon FBA)

-- 1. Add Composter Chamber
insert into public.parts
  (id, sku, name, category, kind, supplier, cost_per_unit_usd, on_hand, reorder_point, location, notes)
values
  ('P-CHAMBER', 'LILA-CHAMBER', 'Composter Chamber',
    'replacement', 'chamber', 'Dongguan LC Technology', null,
    0, 5, 'Toronto warehouse',
    'Replacement composter chamber for cracked / damaged units. Ad-hoc inventory.')
on conflict (id) do nothing;

-- 2. Remove Motor + Box. Use DELETE for parts with no shipments;
--    fall back to noting them as deprecated if shipments exist.
delete from public.parts where id in ('P-MOTOR', 'C-BOX')
  and not exists (select 1 from public.part_shipments where part_id = public.parts.id);

-- 3. Update starter-kit supplier
update public.parts
   set supplier = 'VCycene',
       notes    = 'Bundled with every US LILA shipment. Sourced directly by VCycene.'
 where id = 'C-STARTER';
