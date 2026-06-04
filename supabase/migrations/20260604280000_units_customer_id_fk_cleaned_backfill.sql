-- Backlog #67 follow-up: extend the units.customer_id backfill to also
-- match cleaned customer_name values (stripping parenthetical suffixes
-- like "(test)", "(original)", "(returned)"). Catches another 14 units
-- that have a real customer row under the un-suffixed name. The
-- units.customer_name itself is left unchanged — only the comparison
-- value is cleaned.

with u as (
  select serial,
         trim(regexp_replace(customer_name, '\s*\([^)]*\)\s*', ' ', 'g')) as cleaned,
         array_length(regexp_split_to_array(
           trim(regexp_replace(customer_name, '\s*\([^)]*\)\s*', ' ', 'g')),
           '\s+'
         ), 1) as token_count
  from public.units
  where customer_name is not null
    and is_team_test = false
    and customer_id is null
),
candidates as (
  select u.serial, c.id as customer_id, 1 as priority
  from u
  join public.customers c on lower(c.full_name) = lower(u.cleaned)
  union all
  select u.serial, c.id as customer_id, 2 as priority
  from u
  join public.customers c
    on lower(c.last_name)  = lower(split_part(u.cleaned, ' ', u.token_count))
   and lower(c.first_name) like lower(split_part(u.cleaned, ' ', 1)) || '%'
  where u.token_count >= 2
    and not exists (
      select 1 from public.customers c2 where lower(c2.full_name) = lower(u.cleaned)
    )
),
ranked as (
  select serial, customer_id,
         count(*) over (partition by serial) as match_count,
         row_number() over (partition by serial order by priority, customer_id) as rn
  from candidates
)
update public.units u
   set customer_id = r.customer_id
  from ranked r
 where u.serial = r.serial
   and r.rn = 1
   and r.match_count = 1;
