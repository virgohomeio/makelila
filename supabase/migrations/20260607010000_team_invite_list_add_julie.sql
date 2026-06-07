-- Add Julie (yueli@virgohome.io) back to the team invite list.
-- She's the finance approver on the refund FSM (see lib/postShipment.ts
-- FINANCE_EMAILS + the "Awaiting Julie" helper in PostShipment/RefundsTab.tsx)
-- but had been off the invite roster since the 2026-06-04 cleanup. Her real
-- email is yueli@virgohome.io — the previous FINANCE_EMAILS entry of
-- julie@virgohome.io was a stale guess that never matched a real account.
-- Companion edit: lib/postShipment.ts FINANCE_EMAILS swaps julie@ → yueli@
-- and modules/Service/TicketDetailPanel.tsx OPS_OWNERS adds yueli@.

insert into public.team_invite_list (email, display_name) values
  ('yueli@virgohome.io', 'Julie')
on conflict (email) do update set display_name = excluded.display_name;
