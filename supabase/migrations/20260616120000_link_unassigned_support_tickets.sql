-- Assign step for customer-grouped support tickets: link customer-less support
-- tickets to a customer record where there's an unambiguous match, so they fold
-- into the right per-customer profile instead of the Unassigned bucket. Only
-- fills NULL customer_id and only when exactly one customer matches. The
-- remainder (mostly Quo conversations from phone numbers not in `customers` —
-- backlog #82) stay unassigned. Updating customer_id also fires
-- set_ticket_unit_serial(), back-filling unit_serial for these.

-- 1) Unique full-name match (ops_manual tickets).
update public.service_tickets t
   set customer_id = m.cid
  from (
    select u.id, min(c.id::text)::uuid as cid
      from public.service_tickets u
      join public.customers c on lower(c.full_name) = lower(u.customer_name)
     where u.category = 'support'
       and u.customer_id is null
       and u.customer_name is not null
     group by u.id
    having count(*) = 1
  ) m
 where t.id = m.id;

-- 2) Unique phone match, last 10 digits (Quo tickets).
update public.service_tickets t
   set customer_id = m.cid
  from (
    select u.id, min(c.id::text)::uuid as cid
      from public.service_tickets u
      join public.customers c
        on right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 10)
         = right(regexp_replace(coalesce(u.customer_phone, ''), '\D', '', 'g'), 10)
     where u.category = 'support'
       and u.customer_id is null
       and length(right(regexp_replace(coalesce(u.customer_phone, ''), '\D', '', 'g'), 10)) = 10
     group by u.id
    having count(distinct c.id) = 1
  ) m
 where t.id = m.id;
