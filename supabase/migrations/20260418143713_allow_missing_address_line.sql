-- Real Shopify data often lacks a street-level address; record this explicitly
-- as NULL so the UI can prompt operators to collect it via QUO.
alter table public.orders
  alter column address_line drop not null;

-- Clear placeholder values where address_line was seeded equal to city.
update public.orders
   set address_line = null
 where address_line = city;
