-- ============================================================
-- DEPLOYED to lilalovely Supabase project (arfdopgbvlfmhmcfghhl)
-- on 2026-06-08 by huayi@virgohome.io via Supabase MCP.
--
-- Snapshot of what's actually live so Ryan can pull this into the
-- beta-lovely repo's migrations/ folder for source-of-truth versioning.
-- This file does NOT auto-apply via lovely's CI; treat it as a reference.
--
-- Companion doc: docs/handoff-ryan-lovely-integration.md
-- Companion spec: docs/integration-lilalovely-2026-06-07.md
-- ============================================================

-- 0. Webhook secret storage (tiny config table, no RLS policies).
--    The actual secret value was inserted manually via the Lovely SQL editor
--    by Huayi and is NOT in this file.
create table if not exists public.app_config (
  key   text primary key,
  value text not null,
  notes text,
  updated_at timestamptz not null default now()
);
alter table public.app_config enable row level security;
-- (no policies on purpose — service_role + SECURITY DEFINER only)

-- 1. pg_net for async HTTP from trigger functions.
create extension if not exists pg_net;

-- 2. Helper: fire_makelila_event
--    Reads the webhook secret from app_config; POSTs to the makelila
--    edge function. SECURITY DEFINER so it bypasses RLS on app_config.
--    Swallows all exceptions — must never block the parent insert/update.
create or replace function public.fire_makelila_event(
  p_user_id    uuid,
  p_event_type text,
  p_serial     text,
  p_email      text,
  p_payload    jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
begin
  select value into v_secret
    from public.app_config
   where key = 'makelila_ingest_secret';
  if v_secret is null then
    raise warning 'fire_makelila_event: app_config row missing';
    return;
  end if;

  perform net.http_post(
    url := 'https://txeftbbzeflequvrmjjr.functions.supabase.co/ingest-lovely-event',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Lovely-Secret', v_secret
    ),
    body := jsonb_build_object(
      'event_type', p_event_type,
      'lovely_user_id', p_user_id,
      'lovely_email', p_email,
      'serial_number', p_serial,
      'occurred_at', now(),
      'payload', coalesce(p_payload, '{}'::jsonb)
    )
  );
exception when others then
  raise warning 'fire_makelila_event(%) failed: %', p_event_type, sqlerrm;
end;
$$;
revoke all on function public.fire_makelila_event(uuid, text, text, text, jsonb) from public;

-- 3. Trigger: on signup (new public.users row).
create or replace function public.on_lovely_user_signup()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  perform public.fire_makelila_event(
    new.id, 'lovely.signup', new.serial_number, new.email,
    jsonb_build_object('first_name', new.first_name, 'last_name', new.last_name)
  );
  return new;
end;
$$;
drop trigger if exists trg_lovely_signup on public.users;
create trigger trg_lovely_signup
  after insert on public.users
  for each row execute function public.on_lovely_user_signup();

-- 4. Trigger: on user update (pairing + onboarding step transitions).
create or replace function public.on_lovely_user_update()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  if (old.serial_number is null and new.serial_number is not null) then
    perform public.fire_makelila_event(
      new.id, 'lovely.serial_paired', new.serial_number, new.email,
      jsonb_build_object('serial_number', new.serial_number)
    );
  end if;
  if (coalesce(old.onboarding_step, '') <> coalesce(new.onboarding_step, '')) then
    perform public.fire_makelila_event(
      new.id, 'lovely.onboarding_step', new.serial_number, new.email,
      jsonb_build_object('from', old.onboarding_step, 'to', new.onboarding_step)
    );
    if (new.onboarding_step = 'tour_done') then
      perform public.fire_makelila_event(
        new.id, 'lovely.onboarding_done', new.serial_number, new.email,
        jsonb_build_object()
      );
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_lovely_user_update on public.users;
create trigger trg_lovely_user_update
  after update on public.users
  for each row execute function public.on_lovely_user_update();

-- 5. Trigger: damage_reports.
create or replace function public.on_lovely_damage_report()
returns trigger language plpgsql security definer
set search_path = public
as $$
declare
  v_email text;
  v_photo_count int;
begin
  select u.email into v_email from public.users u where u.id = new.user_id;
  select count(*) into v_photo_count from public.images i where i.damage_report_id = new.id;
  perform public.fire_makelila_event(
    new.user_id, 'lovely.damage_report', new.serial_number, v_email,
    jsonb_build_object(
      'damage_report_id', new.id,
      'notes_present', new.notes is not null and length(new.notes) > 0,
      'photo_count', v_photo_count
    )
  );
  return new;
end;
$$;
drop trigger if exists trg_lovely_damage_report on public.damage_reports;
create trigger trg_lovely_damage_report
  after insert on public.damage_reports
  for each row execute function public.on_lovely_damage_report();

-- 6. Trigger: ota_acceptances.
create or replace function public.on_lovely_ota_accepted()
returns trigger language plpgsql security definer
set search_path = public
as $$
declare
  v_version text;
  v_email   text;
  v_serial  text;
begin
  select version into v_version from public.ota_updates where id = new.ota_update_id;
  select email, serial_number into v_email, v_serial from public.users where id = new.user_id;
  perform public.fire_makelila_event(
    new.user_id, 'lovely.ota_accepted', v_serial, v_email,
    jsonb_build_object('ota_version', v_version)
  );
  return new;
end;
$$;
drop trigger if exists trg_lovely_ota_accepted on public.ota_acceptances;
create trigger trg_lovely_ota_accepted
  after insert on public.ota_acceptances
  for each row execute function public.on_lovely_ota_accepted();

-- 7. Trigger: push_subscriptions opt-in (insert only).
create or replace function public.on_lovely_push_opt_in()
returns trigger language plpgsql security definer
set search_path = public
as $$
declare
  v_email  text;
  v_serial text;
begin
  select email, serial_number into v_email, v_serial from public.users where id = new.user_id;
  perform public.fire_makelila_event(
    new.user_id, 'lovely.push_opt_in', v_serial, v_email,
    jsonb_build_object()
  );
  return new;
end;
$$;
drop trigger if exists trg_lovely_push_opt_in on public.push_subscriptions;
create trigger trg_lovely_push_opt_in
  after insert on public.push_subscriptions
  for each row execute function public.on_lovely_push_opt_in();

-- ============================================================
-- TODO (V1.1, not yet deployed):
--   - lovely.push_opt_out trigger on push_subscriptions DELETE
--   - lovely.dashboard_open + lovely.batch_complete_seen — client-side
--     POST from beta-lovely's Next.js code (no DB trigger; see handoff)
--   - lovely.dormancy_30d / lovely.dormancy_60d — pg_cron nightly scan
-- ============================================================
