-- Add moldy_composter and moldy_chamber to dataset_labels label check constraint.
-- Requested 2026-06-15 to capture mold-related observations as ML training signal.

alter table public.dataset_labels
  drop constraint if exists dataset_labels_label_check;

alter table public.dataset_labels
  add constraint dataset_labels_label_check
  check (label in (
    'smelly', 'no_smell', 'dry', 'wet',
    'mixing', 'not_mixing',
    'moldy_composter', 'moldy_chamber',
    'other'
  ));
