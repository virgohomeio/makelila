-- Purchase order a unit was claimed under (Build › "+ Claim serials").
-- Nullable: units claimed before POs were linked, or claimed with "No PO",
-- carry none. ON DELETE SET NULL so removing a PO never removes units.
alter table public.units
  add column if not exists po_id uuid
    references public.factory_orders(id) on delete set null;

create index if not exists idx_units_po_id
  on public.units (po_id)
  where po_id is not null;
