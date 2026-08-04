-- Add motor_jammed to dataset_labels label check constraint.
-- Requested 2026-07-31 so operators can tag telemetry windows where a
-- chamber motor is jammed (paired with chamber_motor_left/right current).

alter table public.dataset_labels
  drop constraint if exists dataset_labels_label_check;

alter table public.dataset_labels
  add constraint dataset_labels_label_check
  check (label in (
    'smelly', 'no_smell', 'dry', 'wet',
    'mixing', 'not_mixing', 'motor_jammed',
    'moldy_composter', 'moldy_chamber',
    'other'
  ));
