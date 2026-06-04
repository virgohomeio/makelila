-- Backlog #67 — canonical units → customers link.
-- Today units.customer_name is a free-text column populated at fulfillment
-- time. The corresponding customers.full_name often differs (joint accounts
-- like "Amila & Rob Smith" vs unit name "Amila Smith"; Shopify-imported vs
-- HubSpot-imported representation). Every cross-module lookup that wants
-- "the customer record for this unit" has to do fuzzy resolution.
--
-- This migration adds the FK column + backfills it for the ~65% of units
-- that resolve to exactly one customer via:
--   1. Exact case-insensitive full_name match, or
--   2. last_name match + first_name starts-with the first token of the
--      unit's name (joint-account handling)
--
-- Units with no match or with ambiguous (>1 candidate) matches are left
-- NULL. The legacy free-text customer_name column stays in place as a
-- denormalized display cache; the JS-side customerForSerial() helper now
-- prefers customer_id and falls back to name resolution.

alter table public.units
  add column if not exists customer_id uuid references public.customers(id) on delete set null;

create index if not exists units_customer_id_idx
  on public.units(customer_id) where customer_id is not null;

-- One-shot backfill using a cascade. Only writes rows where exactly ONE
-- candidate customer matches, to avoid silently linking to the wrong row.
with name_parts as (
  select serial,
         trim(customer_name) as name,
         array_length(regexp_split_to_array(trim(customer_name), '\s+'), 1) as token_count
  from public.units
  where customer_name is not null
    and is_team_test = false
    and customer_id is null
),
candidates as (
  -- Exact full_name match
  select np.serial, c.id as customer_id, 1 as priority
  from name_parts np
  join public.customers c on lower(c.full_name) = lower(np.name)
  union all
  -- Token cascade (only for names with 2+ tokens; skip if exact already matched)
  select np.serial, c.id as customer_id, 2 as priority
  from name_parts np
  join public.customers c
    on lower(c.last_name)  = lower(split_part(np.name, ' ', np.token_count))
   and lower(c.first_name) like lower(split_part(np.name, ' ', 1)) || '%'
  where np.token_count >= 2
    and not exists (
      select 1 from public.customers c2
      where lower(c2.full_name) = lower(np.name)
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
