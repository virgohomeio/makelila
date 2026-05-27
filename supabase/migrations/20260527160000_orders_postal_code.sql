-- Add postal_code to orders so verify-address has a reliable customer ZIP to
-- compare against Google's geocoded postal. Backfilled by the next sync.
alter table public.orders add column if not exists postal_code text;
