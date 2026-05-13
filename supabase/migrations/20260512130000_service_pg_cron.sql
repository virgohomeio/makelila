-- pg_cron + pg_net wiring for periodic syncs and template auto-fires.
-- Requires pg_cron and pg_net extensions enabled on the project (already
-- enabled for existing email auto-fire flows in this project).

-- ============================================================ Extension check
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ============================================================ Helper: call edge function
create or replace function public.invoke_edge_function(fn_name text, body jsonb default '{}'::jsonb)
returns void language plpgsql security definer as $$
declare
  base_url text := coalesce(
    current_setting('app.supabase_url', true),
    'https://txeftbbzeflequvrmjjr.supabase.co'
  );
  anon_key text := coalesce(
    current_setting('app.supabase_anon_key', true),
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4ZWZ0YmJ6ZWZsZXF1dnJtampyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNzk3NjcsImV4cCI6MjA5MTg1NTc2N30.sWmDCODRuhutbHuXcoVIVRvVvVyZADpNysFkerOXNPw'
  );
begin
  perform net.http_post(
    url := base_url || '/functions/v1/' || fn_name,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || anon_key
    ),
    body := body
  );
end $$;

-- ============================================================ Cron: Calendly hourly
do $$
begin
  if exists (select 1 from cron.job where jobname = 'sync-calendly-hourly') then
    perform cron.unschedule('sync-calendly-hourly');
  end if;
end $$;
select cron.schedule(
  'sync-calendly-hourly',
  '15 * * * *',                                       -- every hour at :15
  $$ select public.invoke_edge_function('sync-calendly-events'); $$
);

-- ============================================================ Cron: HubSpot hourly
do $$
begin
  if exists (select 1 from cron.job where jobname = 'sync-hubspot-tickets-hourly') then
    perform cron.unschedule('sync-hubspot-tickets-hourly');
  end if;
end $$;
select cron.schedule(
  'sync-hubspot-tickets-hourly',
  '30 * * * *',                                       -- every hour at :30 (stagger)
  $$ select public.invoke_edge_function('sync-hubspot-tickets'); $$
);

-- ============================================================ Cron: auto-close
-- 7 days after resolved → closed. Runs daily at 03:00 UTC.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'service-tickets-auto-close') then
    perform cron.unschedule('service-tickets-auto-close');
  end if;
end $$;
select cron.schedule(
  'service-tickets-auto-close',
  '0 3 * * *',
  $$
    update public.service_tickets
       set status = 'closed',
           closed_at = now()
     where status = 'resolved'
       and resolved_at < now() - interval '7 days'
  $$
);

-- ============================================================ Template auto-fire trigger
-- Fires send-template-email for the transitions documented in the spec:
--   * INSERT category='onboarding' source='calendly' → onboarding_calendly_confirmation
--   * INSERT category='repair' → repair_acknowledged
--   * INSERT category='onboarding' source!='calendly' → no auto (created by ops)
--   * UPDATE status to 'triaging' on category='support' → support_received
--
-- Variables collected from the ticket row + customer_lifecycle if linked.
create or replace function public.tickets_fire_templates() returns trigger language plpgsql security definer as $$
declare
  tmpl text;
  vars jsonb := '{}'::jsonb;
  lifecycle record;
begin
  -- Pick the template
  if tg_op = 'INSERT' then
    if new.category = 'onboarding' and new.source = 'calendly' then
      tmpl := 'onboarding_calendly_confirmation';
    elsif new.category = 'repair' then
      tmpl := 'repair_acknowledged';
    end if;
  elsif tg_op = 'UPDATE' then
    if new.category = 'support' and old.status is distinct from new.status and new.status = 'triaging' then
      tmpl := 'support_received';
    end if;
  end if;
  if tmpl is null then return new; end if;
  if new.customer_email is null then return new; end if;

  -- Build variables
  select * into lifecycle from public.customer_lifecycle where unit_serial = new.unit_serial limit 1;
  vars := jsonb_build_object(
    'customer_first_name', coalesce(split_part(new.customer_name, ' ', 1), 'there'),
    'unit_serial',         coalesce(new.unit_serial, ''),
    'ticket_number',       new.ticket_number,
    'subject',             new.subject,
    'event_start_local',   to_char(new.calendly_event_start at time zone 'America/Vancouver', 'FMDay, FMMonth FMDD at HH12:MI AM'),
    'event_timezone',      'America/Vancouver',
    'event_url',           coalesce(new.calendly_event_uri, ''),
    'host_name',           coalesce(new.calendly_host_email, '')
  );

  perform public.invoke_edge_function(
    'send-template-email',
    jsonb_build_object(
      'template_key', tmpl,
      'to',           new.customer_email,
      'to_name',      new.customer_name,
      'variables',    vars
    )
  );
  return new;
end $$;

drop trigger if exists tickets_template_autofire_ins on public.service_tickets;
create trigger tickets_template_autofire_ins
  after insert on public.service_tickets
  for each row execute function public.tickets_fire_templates();

drop trigger if exists tickets_template_autofire_upd on public.service_tickets;
create trigger tickets_template_autofire_upd
  after update on public.service_tickets
  for each row execute function public.tickets_fire_templates();

-- ============================================================ Onboarding-welcome on lifecycle insert
create or replace function public.lifecycle_fire_welcome() returns trigger language plpgsql security definer as $$
declare
  cust record;
begin
  if new.customer_id is null then return new; end if;
  select * into cust from public.customers where id = new.customer_id;
  if cust.email is null then return new; end if;
  perform public.invoke_edge_function(
    'send-template-email',
    jsonb_build_object(
      'template_key', 'onboarding_welcome',
      'to',           cust.email,
      'to_name',      trim(coalesce(cust.first_name, '') || ' ' || coalesce(cust.last_name, '')),
      'variables',    jsonb_build_object(
        'customer_first_name', coalesce(cust.first_name, 'there'),
        'unit_serial',         coalesce(new.unit_serial, '')
      )
    )
  );
  return new;
end $$;

drop trigger if exists lifecycle_fire_welcome on public.customer_lifecycle;
create trigger lifecycle_fire_welcome
  after insert on public.customer_lifecycle
  for each row execute function public.lifecycle_fire_welcome();
