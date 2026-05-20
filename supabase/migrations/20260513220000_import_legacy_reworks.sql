-- Import existing unit_reworks rows into build_defects with category='legacy_rework'
-- and status='resolved' (treating historical reworks as completed). The
-- unit_reworks table is left in place but deprecated to read-only — no new
-- writes after this point. The flagRework function in app/src/lib/fulfillment.ts
-- will be modified in a later task to write to build_defects instead.

insert into public.build_defects (
  unit_serial,
  category,
  subject,
  description,
  severity,
  status,
  found_by,
  found_by_name,
  resolved_at,
  found_at,
  created_at,
  updated_at
)
select
  ur.serial,
  'legacy_rework',
  coalesce(left(ur.issue, 100), '(no description)'),
  ur.issue,
  'medium',
  'resolved',
  ur.flagged_by,
  ur.flagged_by_name,
  ur.flagged_at,
  ur.flagged_at,
  ur.flagged_at,
  ur.flagged_at
from public.unit_reworks ur
where exists (select 1 from public.units u where u.serial = ur.serial);

comment on table public.unit_reworks is
  'DEPRECATED 2026-05-13: superseded by public.build_defects. Kept for historical reference only. Do not write new rows.';
