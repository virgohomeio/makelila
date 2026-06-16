-- Area-type classification per order: is the delivery address in an
-- urban / suburban home/area, or a rural / remote one? Surfaced on the Order
-- Review list + detail so ops can triage pending orders before the sales
-- hand-off. Distinct from address_verdict (dwelling type: house/apt/condo) and
-- from the remote-zone freight flag.
--
-- area_type is auto-guessed from the postal code on Shopify sync and can be
-- overridden by an operator. area_type_source mirrors freight_estimate_source:
-- 'auto' from the heuristic, flips to 'manual' once an operator picks a value,
-- and a re-sync never clobbers a manual override.

alter table public.orders
  add column if not exists area_type text
    check (area_type is null or area_type in ('urban','suburban','rural'));

alter table public.orders
  add column if not exists area_type_source text not null default 'auto';

-- Backfill existing orders from their postal code. We can reproduce the
-- Canada-Post rural rule (2nd char of the FSA is 0) in SQL; remote-prefix
-- rural zones aren't backfilled here (they need the remote_postal_prefixes
-- table) but a re-sync or operator override will correct those. Everything
-- non-rural defaults to 'suburban' for the operator to refine.
update public.orders
  set area_type = case
    when country = 'CA'
         and upper(substring(replace(coalesce(postal_code,''),' ',''), 2, 1)) = '0'
      then 'rural'
    else 'suburban'
  end
  where area_type is null
    and postal_code is not null
    and postal_code <> '';
