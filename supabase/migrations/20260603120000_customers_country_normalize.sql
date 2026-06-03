-- Walkthrough #42: normalize customers.country to ISO-2 codes.
-- Existing data had 4 conventions: 'Canada' (145), 'United States' (73),
-- 'US' (2), null (80). The Customers tab filter chips check for 'CA'/'US'
-- two-letter codes, so 'Canada' / 'United States' rows were being hidden.
-- sync-hubspot-customers now normalizes on write going forward.
update public.customers
   set country = case lower(trim(country))
                   when 'canada'         then 'CA'
                   when 'united states'  then 'US'
                   when 'usa'            then 'US'
                   when 'u.s.a.'         then 'US'
                   when 'u.s.'           then 'US'
                   when 'ca'             then 'CA'
                   when 'us'             then 'US'
                   else country
                 end
 where country is not null;
