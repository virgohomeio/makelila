-- Stores the Klaviyo profile ID for each customer once resolved by the
-- klaviyo-track edge function. Used to skip the profile-lookup API call
-- on subsequent Klaviyo Track events.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS klaviyo_profile_id text NULL;
