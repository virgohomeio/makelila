-- Zero-touch onboarding auto-complete → auto-schedules FU1/FU2.
--
-- Once a customer's booked onboarding call time has passed (by a 1-day grace
-- window that lets operators mark no-shows first), auto-mark the onboarding
-- complete and stamp customers.onboard_date with the CALL date. The existing
-- Follow-Ups calendar then schedules FU1 (call + 14d) and FU2 (call + 28d)
-- automatically — no operator click required.
--
-- Mirrors the pure-SQL cron pattern of service-tickets-auto-close
-- (20260512130000_service_pg_cron.sql). Deliberately does NOT fire the Klaviyo
-- 'First Use' drip — that stays tied to an operator's explicit "Mark complete"
-- click, so marketing automation isn't triggered on an unmarked no-show.
--
-- Behaviour notes:
--   * Only rows in onboarding_status = 'scheduled' are touched; 'no_show',
--     'skipped', 'completed' are never changed — an operator can veto within
--     the grace window.
--   * Anchors to the LATEST onboarding call (max calendly_event_start). A call
--     rescheduled to a future slot is skipped until that slot is >1 day past.
--   * onboard_date is only written when still null (preserves CSV/manual values),
--     matching markOnboardingComplete().
--   * Multi-unit customers (multiple lifecycle rows sharing a customer_id) will
--     each complete off the same call — acceptable; both units onboard together.
--
-- Requires pg_cron (already enabled in this project).

-- ---------------------------------------------------------------- Dry-run
-- Preview which lifecycle rows WOULD auto-complete right now (read-only, safe):
--
--   select cl.id as lifecycle_id, cl.customer_id, cl.unit_serial,
--          max(t.calendly_event_start) as call_start
--     from public.customer_lifecycle cl
--     join public.service_tickets t
--       on t.customer_id = cl.customer_id
--      and t.category = 'onboarding'
--      and t.calendly_event_start is not null
--    where cl.onboarding_status = 'scheduled'
--      and cl.customer_id is not null
--    group by cl.id, cl.customer_id, cl.unit_serial
--   having max(t.calendly_event_start) < now() - interval '1 day';

-- ---------------------------------------------------------------- Function
create or replace function public.onboarding_auto_complete()
returns void language sql security definer as $$
  with due as (
    select cl.id                       as lifecycle_id,
           cl.customer_id              as customer_id,
           max(t.calendly_event_start) as call_start
      from public.customer_lifecycle cl
      join public.service_tickets t
        on t.customer_id = cl.customer_id
       and t.category = 'onboarding'
       and t.calendly_event_start is not null
     where cl.onboarding_status = 'scheduled'
       and cl.customer_id is not null
     group by cl.id, cl.customer_id
    having max(t.calendly_event_start) < now() - interval '1 day'
  ),
  completed as (
    update public.customer_lifecycle cl
       set onboarding_status = 'completed',
           onboarding_completed_at = due.call_start
      from due
     where cl.id = due.lifecycle_id
    returning cl.customer_id as customer_id, due.call_start as call_start
  )
  update public.customers c
     set onboard_date = (completed.call_start)::date
    from completed
   where c.id = completed.customer_id
     and c.onboard_date is null;
$$;

-- ---------------------------------------------------------------- Cron (hourly)
do $$
begin
  if exists (select 1 from cron.job where jobname = 'onboarding-auto-complete') then
    perform cron.unschedule('onboarding-auto-complete');
  end if;
end $$;
select cron.schedule(
  'onboarding-auto-complete',
  '20 * * * *',                                       -- every hour at :20 (staggered)
  $$ select public.onboarding_auto_complete(); $$
);
