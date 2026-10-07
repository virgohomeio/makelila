-- Per-ad website purchases per day, so the Journey Report can attribute a
-- single-sale day to the one creative that converted that day (the clean-day
-- match already used for age/gender). Populated by sync-facebook-ads on its
-- next run (clean-replace of fb_ads); null until then.
alter table public.fb_ads add column if not exists purchases integer;
