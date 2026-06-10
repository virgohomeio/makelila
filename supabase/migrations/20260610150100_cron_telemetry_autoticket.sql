-- Feature J6: pg_cron jobs for telemetry state sync + auto-ticket creation.
-- Follows the pattern from 20260527220000 and 20260512130000.

-- ============================================================ sync-telemetry-state every 15 min

do $$
begin
  if exists (select 1 from cron.job where jobname = 'sync-telemetry-state-15min') then
    perform cron.unschedule('sync-telemetry-state-15min');
  end if;
end $$;

select cron.schedule(
  'sync-telemetry-state-15min',
  '*/15 * * * *',
  $$ select public.invoke_edge_function('sync-telemetry-state'); $$
);

-- ============================================================ telemetry_ticket_autocreate every 30 min

do $$
begin
  if exists (select 1 from cron.job where jobname = 'telemetry-ticket-autocreate') then
    perform cron.unschedule('telemetry-ticket-autocreate');
  end if;
end $$;

select cron.schedule(
  'telemetry-ticket-autocreate',
  '*/30 * * * *',
  $$
    do $$
    declare
      cfg              record;
      rec              record;
      new_ticket_id    uuid;
      cust_name        text;
      cust_email       text;
      hold_duration    text;
    begin
      -- Load feature flag (singleton row). If missing, default to enabled+shadow.
      select * into cfg from public.telemetry_autoticket_config where id = 1;
      if not found then
        return;
      end if;
      -- Bail out if the whole feature is disabled.
      if not cfg.enabled then
        return;
      end if;

      -- Iterate over all units with a qualifying telemetry state.
      -- Excluded states:
      --   OK, NEW_FOOD  → never trigger (healthy states)
      --   NOT_MIXING    → DISABLED; 75% false positive rate documented in backlog #70
      for rec in
        select
          uts.unit_serial,
          uts.classified_state,
          uts.state_held_since,
          uts.last_seen_at,
          u.customer_id,
          c.telemetry_autoticket_suppress
        from public.unit_telemetry_state uts
        join public.units u
          on u.serial = uts.unit_serial
        left join public.customers c
          on c.id = u.customer_id
        where
          -- Only actionable non-OK states (NOT_MIXING permanently excluded)
          uts.classified_state not in ('OK', 'NEW_FOOD', 'NOT_MIXING')
          -- Skip stale telemetry (last_seen_at > 1h ago)
          and uts.is_stale = false
          -- Must have a linked customer
          and u.customer_id is not null
          -- Hold threshold exceeded (per-state durations):
          --   DIAGNOSE:    6 hours
          --   NO_BME_DATA: 24 hours
          --   DRY_SOIL:    48 hours
          --   SOAKED_SOIL: 48 hours
          --   OPEN_LID:    4 hours
          and case uts.classified_state
                when 'DIAGNOSE'    then uts.state_held_since <= now() - interval '6 hours'
                when 'NO_BME_DATA' then uts.state_held_since <= now() - interval '24 hours'
                when 'DRY_SOIL'    then uts.state_held_since <= now() - interval '48 hours'
                when 'SOAKED_SOIL' then uts.state_held_since <= now() - interval '48 hours'
                when 'OPEN_LID'    then uts.state_held_since <= now() - interval '4 hours'
                else false
              end
      loop
        -- Skip if customer has opted out of auto-tickets.
        if coalesce(rec.telemetry_autoticket_suppress, false) then
          if cfg.shadow_mode then
            insert into public.telemetry_autoticket_shadow
              (unit_serial, customer_id, classified_state, state_held_since, skipped_reason)
            values
              (rec.unit_serial, rec.customer_id, rec.classified_state,
               rec.state_held_since, 'suppress_flag');
          end if;
          continue;
        end if;

        -- Dedup: skip if an open telemetry_auto ticket already exists for this unit.
        if exists (
          select 1 from public.service_tickets
          where unit_serial = rec.unit_serial
            and source = 'telemetry_auto'
            and status not in ('resolved', 'closed')
        ) then
          if cfg.shadow_mode then
            insert into public.telemetry_autoticket_shadow
              (unit_serial, customer_id, classified_state, state_held_since, skipped_reason)
            values
              (rec.unit_serial, rec.customer_id, rec.classified_state,
               rec.state_held_since, 'existing_open_ticket');
          end if;
          continue;
        end if;

        -- Build human-readable hold duration for the ticket description.
        hold_duration := extract(epoch from (now() - rec.state_held_since))::int
                         / 3600 || 'h';

        -- Lookup customer name/email for the ticket row.
        select
          trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')),
          email
        into cust_name, cust_email
        from public.customers
        where id = rec.customer_id;

        if cfg.shadow_mode then
          -- Shadow mode: record what WOULD have been created, don't touch service_tickets.
          insert into public.telemetry_autoticket_shadow
            (unit_serial, customer_id, classified_state, state_held_since)
          values
            (rec.unit_serial, rec.customer_id, rec.classified_state, rec.state_held_since);
        else
          -- Live mode: create a real service ticket.
          insert into public.service_tickets
            (source, kind, category, status, priority,
             subject, description,
             customer_id, customer_name, customer_email,
             unit_serial)
          values
            ('telemetry_auto', 'ticket', 'support', 'waiting_on_us', 'normal',
             'Telemetry alert: unit held ' || rec.classified_state || ' for ' || hold_duration,
             'Auto-created by telemetry monitor. Unit ' || rec.unit_serial
               || ' has been in state ' || rec.classified_state
               || ' since ' || to_char(rec.state_held_since at time zone 'UTC', 'YYYY-MM-DD HH24:MI UTC')
               || ' (' || hold_duration || ').',
             rec.customer_id,
             nullif(trim(coalesce(cust_name, '')), ''),
             cust_email,
             rec.unit_serial)
          returning id into new_ticket_id;

          -- Audit trail. user_id = null for system-initiated events.
          insert into public.activity_log
            (user_id, type, entity, detail, entity_type, entity_id, unit_serial)
          values
            (null, 'telemetry_auto_ticket_created',
             rec.unit_serial,
             'state=' || rec.classified_state || ' held=' || hold_duration,
             'ticket',
             new_ticket_id::text,
             rec.unit_serial);
        end if;

      end loop;
    end $$;
  $$
);
