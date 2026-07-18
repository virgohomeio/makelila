-- Extend fb_demographics to also carry leads (not just purchases) and the
-- campaign name, so the Marketing → Demographics page can break leads/purchases
-- down by age/gender/location for each product set (Sharpei Waitlist, LILA Mini,
-- LILA Pro). Mini is now included here (its own set); the Journey Report's
-- age/gender match still filters Mini out on the client.

alter table public.fb_demographics
  add column if not exists campaign_name text,
  add column if not exists leads         integer;
