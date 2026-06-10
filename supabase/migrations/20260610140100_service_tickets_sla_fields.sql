-- J5: Add SLA columns to service_tickets + triggers

-- ============================================================ Columns
alter table public.service_tickets
  add column if not exists sla_policy_id        uuid references public.sla_policies(id),
  add column if not exists first_response_due_at timestamptz,
  add column if not exists resolution_due_at     timestamptz,
  add column if not exists first_responded_at    timestamptz,
  add column if not exists sla_resolved_at       timestamptz,
  add column if not exists sla_status            text default null
    check (sla_status in ('ok', 'warning', 'breached', 'met'));

create index if not exists idx_tickets_sla_status on public.service_tickets (sla_status)
  where sla_status in ('warning', 'breached');

create index if not exists idx_tickets_sla_due on public.service_tickets (resolution_due_at)
  where sla_policy_id is not null;

-- ============================================================ INSERT trigger: attach policy + compute deadlines
-- Maps the ticket's priority onto the SLA policy priority dimension.
-- service_tickets.priority is 'low'|'normal'|'high'|'urgent';
-- sla_policies.priority is 'p1'|'p2'|'p3'.
-- Mapping: urgent→p1, high→p2, normal/low→p3.
create or replace function public.tickets_attach_sla() returns trigger language plpgsql as $$
declare
  policy record;
  sla_prio text;
begin
  -- Only wire up SLA for actual support/repair/diagnosis tickets (not onboarding)
  -- and only when there is an active policy.
  if new.category not in ('support', 'repair', 'diagnosis_call') then
    return new;
  end if;

  sla_prio := case new.priority
    when 'urgent' then 'p1'
    when 'high'   then 'p2'
    else               'p3'
  end;

  select * into policy
    from public.sla_policies
    where priority = sla_prio
      and is_active = true
    limit 1;

  if not found then return new; end if;

  new.sla_policy_id        := policy.id;
  new.first_response_due_at := now() + (policy.first_response_minutes || ' minutes')::interval;
  new.resolution_due_at     := now() + (policy.resolution_minutes     || ' minutes')::interval;
  new.sla_status            := 'ok';

  return new;
end $$;

drop trigger if exists tickets_attach_sla_ins on public.service_tickets;
create trigger tickets_attach_sla_ins
  before insert on public.service_tickets
  for each row execute function public.tickets_attach_sla();

-- ============================================================ UPDATE trigger: stamp first_responded_at + resolved SLA
-- We treat any UPDATE where updated_at advances and the ticket has been
-- worked (status is no longer 'new') as evidence the team has responded.
-- This is intentionally permissive — the precise semantics of "first response"
-- vary by channel; operators can override first_responded_at directly.
create or replace function public.tickets_sla_update_stamp() returns trigger language plpgsql as $$
begin
  -- Stamp first_responded_at on first meaningful action after ticket creation.
  if new.sla_policy_id is not null
     and new.first_responded_at is null
     and old.status is distinct from new.status
     and new.status not in ('new', 'waiting_on_us')
  then
    new.first_responded_at := now();
  end if;

  -- On resolution / closure, stamp sla_resolved_at and evaluate sla_status.
  if new.status in ('resolved', 'closed')
     and old.status not in ('resolved', 'closed')
     and new.sla_policy_id is not null
  then
    new.sla_resolved_at := now();
    -- 'met' only if both deadlines were honoured (or a deadline wasn't set).
    if (new.first_response_due_at is null or now() <= new.first_response_due_at or new.first_responded_at <= new.first_response_due_at)
       and (new.resolution_due_at is null or now() <= new.resolution_due_at)
    then
      new.sla_status := 'met';
    else
      new.sla_status := 'breached';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists tickets_sla_update_stamp on public.service_tickets;
create trigger tickets_sla_update_stamp
  before update on public.service_tickets
  for each row execute function public.tickets_sla_update_stamp();
