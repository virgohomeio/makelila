-- Journey tab — let operators manually override the auto-inferred CJM
-- stage when the heuristics get it wrong, or when an operator has
-- out-of-band info (e.g. customer mentioned via chat that they're now
-- using the unit, but no DB signal exists yet).
--
-- NULL = use auto-inferred stage (default).
-- Non-null = pin the customer to that stage in the Journey tab UI.
--
-- Valid values match the StageKey union in
-- app/src/modules/Customers/JourneyTab.tsx — we don't bake the check
-- into Postgres so the enum can evolve with the CJM without a migration.

alter table public.customers
  add column if not exists journey_stage_override text,
  add column if not exists journey_stage_override_at timestamptz,
  add column if not exists journey_stage_override_by uuid references public.profiles(id) on delete set null;

comment on column public.customers.journey_stage_override is
  'Operator-set CJM stage that overrides the auto-inferred journey stage in the Journey tab. NULL = use inference. Valid values match the StageKey union in app/src/modules/Customers/JourneyTab.tsx.';
