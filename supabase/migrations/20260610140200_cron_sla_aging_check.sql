-- J5: pg_cron job — SLA aging check every 15 minutes
-- Transitions ok→warning→breached, bumps priority once per breach,
-- inserts activity_log row, and fires an edge-function notification.

-- ============================================================ Idempotent unschedule
do $$
begin
  if exists (select 1 from cron.job where jobname = 'sla_aging_check') then
    perform cron.unschedule('sla_aging_check');
  end if;
end $$;

-- ============================================================ Priority bump helper
-- Maps current ticket priority one notch up; P1 stays at P1.
create or replace function public.sla_bump_priority(current_priority text) returns text
  language sql immutable as $$
  select case current_priority
    when 'low'    then 'normal'
    when 'normal' then 'high'
    when 'high'   then 'urgent'
    else current_priority  -- 'urgent' stays urgent
  end
$$;

-- ============================================================ Cron body
select cron.schedule(
  'sla_aging_check',
  '*/15 * * * *',
  $$
    -- ---- 1. Transition ok → warning (within 15 min of first_response_due_at) ----
    update public.service_tickets
       set sla_status = 'warning'
     where sla_policy_id is not null
       and status not in ('resolved', 'closed')
       and sla_status = 'ok'
       and first_responded_at is null
       and now() >= first_response_due_at - interval '15 minutes'
       and now() < first_response_due_at;

    -- ---- 2. Transition * → breached on first_response deadline ----
    with newly_breached as (
      update public.service_tickets
         set sla_status = 'breached',
             priority   = public.sla_bump_priority(priority)
       where sla_policy_id is not null
         and status not in ('resolved', 'closed')
         and sla_status <> 'breached'
         and first_responded_at is null
         and now() > first_response_due_at
      returning id, ticket_number, priority, sla_policy_id
    )
    insert into public.activity_log (entity_type, entity_id, action, detail, created_at)
    select
      'ticket',
      nb.id,
      'sla_first_response_breached',
      'SLA first-response deadline breached; priority bumped to ' || nb.priority,
      now()
    from newly_breached nb;

    -- ---- 3. Transition ok/warning → breached on resolution deadline ----
    --    Only fires if first_responded_at is set (first response already met)
    --    but resolution window has elapsed.
    with resolution_breached as (
      update public.service_tickets
         set sla_status = 'breached',
             priority   = public.sla_bump_priority(priority)
       where sla_policy_id is not null
         and status not in ('resolved', 'closed')
         and sla_status <> 'breached'
         and first_responded_at is not null
         and now() > resolution_due_at
      returning id, ticket_number, priority
    )
    insert into public.activity_log (entity_type, entity_id, action, detail, created_at)
    select
      'ticket',
      rb.id,
      'sla_resolution_breached',
      'SLA resolution deadline breached; priority bumped to ' || rb.priority,
      now()
    from resolution_breached rb;

    -- ---- 4. Fire edge-function notification for all currently-breached open tickets ----
    --    invoke_edge_function is a no-op if the edge function doesn't exist yet;
    --    the cron job must not fail on a missing function. We do a single bulk
    --    call with the list of breached ticket IDs rather than one call per ticket.
    perform public.invoke_edge_function(
      'sla-breach-notify',
      (
        select jsonb_build_object(
          'ticket_ids', jsonb_agg(id),
          'run_at', now()
        )
        from public.service_tickets
        where sla_status = 'breached'
          and status not in ('resolved', 'closed')
      )
    );
  $$
);
