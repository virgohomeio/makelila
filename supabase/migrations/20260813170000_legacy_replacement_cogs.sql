-- Backlog #58 V5 follow-up — cost the pre-#55 replacement orders.
--
-- "Exp. warranty" on Customers → Profitability sums cogs + shipping across every
-- non-cancelled replacement order. 18 replacement orders predate the #55
-- replacement flow and carry no cost at all, so 14 customers who HAVE had a
-- warranty replacement still show $0.00 expected warranty — the tab reports them
-- as costless, which is the opposite of the truth.
--
-- Those legacy rows also predate structured line_items. A well-formed row from
-- the #55 flow looks like:
--     {"qty":1,"kind":"unit_pending","batch":"P100X","cost_usd":314}
-- whereas the legacy rows carry only free text:
--     {"kind":"part","description":"both side latch"}
--     {"kind":"unit_pending","batch":"P100X"}
-- There is no cost to recompute from, so this is an inferred backfill, priced
-- from public.parts and the batch cost. Every row is stamped
-- cogs_basis = 'replacement_legacy_estimate' so it is greppable and correctable
-- rather than indistinguishable from measured cost.
--
-- Whole-unit replacements are priced at $314 USD, which is both
-- batches.unit_cost_usd for P100 (the actual invoiced landed cost) and the
-- cost_usd the #55 flow already books for a P100X unit replacement.
--
-- Part prices come from public.parts.cost_per_unit_usd:
--     Side Latch (L/R)        $10.00 each
--     Composter Chamber (L/R) $90.00 each
--     Filtration Module       $50.00
--     Replacement Top Lid     $24.00
--
-- The description → price mapping is spelled out per order rather than derived
-- by fuzzy matching, because the text is ambiguous in ways a LIKE cannot resolve
-- ("side latch (? side)" is one latch of unknown handedness; "both side latch"
-- is two; "Side latch + compost chambers" is one latch and two chambers). Each
-- line below is a judgement call an operator can audit and override.
--
-- R-0001 is deliberately NOT costed: its line_items array is empty, so there is
-- nothing to price and any number would be invented. It stays NULL and keeps
-- showing as uncosted.
--
-- SHIPPING is out of scope here. All 41 uncosted replacement orders also have no
-- freight, and unlike COGS there is no defensible way to infer it — the fix is a
-- Freightcom shipment linked to the replacement order, which flows in
-- automatically via the trigger from 20260812110000.

update public.orders o
set cogs_usd   = v.cost,
    cogs_basis = 'replacement_legacy_estimate'
from (values
  -- whole-unit replacements
  ('R-0011', 314.00),  -- "P100 X"                             → 1 unit
  ('R-0015', 314.00),  -- unit_pending, batch P100X
  ('R-0017', 314.00),  -- unit_pending, batch P100X
  ('R-0020', 314.00),  -- unit_pending, batch P100X
  ('R-0021', 314.00),  -- unit_pending, batch P100X
  ('R-0022', 314.00),  -- unit_pending, batch P100
  ('R-0023', 314.00),  -- unit_pending, batch P100X
  ('R-0025', 314.00),  -- unit_pending, batch P100
  ('R-0026', 314.00),  -- unit_pending, batch P100X
  -- part replacements
  ('R-0002',  20.00),  -- "both side latch"                    → 2 × latch
  ('R-0005',  60.00),  -- "side latch (?) and filter cup"      → 1 × latch + 1 × filtration module
  ('R-0007',  90.00),  -- "broken compost chamber (right side)"→ 1 × chamber
  ('R-0008',  10.00),  -- "side latch (? side)"                → 1 × latch
  ('R-0010', 180.00),  -- "both compost chambers cracked"      → 2 × chamber
  ('R-0013',  90.00),  -- "left side chamber"                  → 1 × chamber
  ('R-0027',  24.00),  -- "Replacement top lid"                → 1 × top lid
  ('R-0031', 190.00)   -- "Side latch + compost chambers"      → 1 × latch + 2 × chamber
) as v(order_ref, cost)
where o.order_ref = v.order_ref
  and o.kind = 'replacement'
  and o.cogs_usd is null;   -- never overwrite a real cost

comment on column public.orders.cogs_basis is
  'How cogs_usd was derived: batch_actual = invoiced batches.unit_cost_usd of '
  'the linked unit; schedule = roadmap projection by order date; '
  'replacement_line_items = summed from line_items cost (the #55 flow); '
  'replacement_legacy_estimate = inferred from free-text line_items on a '
  'pre-#55 replacement, priced from public.parts / batch cost (see '
  '20260813170000); manual = operator-entered. NULL alongside a NULL cogs_usd '
  'means uncosted.';
