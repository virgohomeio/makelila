-- Reconcile units.customer_id to the maintained units.customer_name.
--
-- Background: customer_id was populated once by the June 2026 fulfilment
-- backfill (backfill_source = 'fulfillment-20260621') and has never been
-- maintained since — there is not a single 'stock_link_customer' row in
-- activity_log. customer_name, by contrast, is hand-edited in the Stock tab and
-- is current. The Customer Directory reads customer_id, so it has been showing
-- 9 machines against the wrong person and 16 against nobody at all.
--
-- Design: docs/superpowers/specs/2026-09-02-customer-unit-linkage-reconciliation-design.md
--
-- This migration applies ONLY changes backed by corroborating evidence (an
-- order or ticket under the Stock-named customer, or an unambiguous normalised
-- name match). Contested units are deliberately left alone for operator triage
-- in Stock → Unlinked units.
--
-- Every UPDATE is guarded on the value observed during the audit, so a row an
-- operator has already corrected is skipped rather than clobbered.
--
-- No activity_log rows are written: activity_log.user_id is NOT NULL and this
-- migration has no authenticated actor to attribute the change to. Inventing a
-- system user to satisfy the audit trail would make the trail less honest, not
-- more. The migration itself is the record.

begin;

-- ---------------------------------------------------------------------------
-- 1. Repoint the 5 FKs that point at the wrong customer.
--
-- In all five the Stock-named person is a real customer with their own orders,
-- and the current FK target independently holds their own correctly-named unit
-- — the signature of a shifted row in the backfill.
-- ---------------------------------------------------------------------------

update public.units u set customer_id = v.correct_id
from (values
  -- serial,                 wrong (current),                          correct
  ('LL01-00000000291'::text, 'Katrina & RJ Dowd'::text,   '1e07bce7-d812-4ee7-ae80-356b320525ce'::uuid), -- Thilagavathi Venkatachalam
  ('LL01-00000000300',       'Brent Neave',               '05742545-ac2a-4e4b-8a3d-bea87bc60342'),       -- Manjeet Kaur
  ('LL01-00000000301',       'Louis DiPalma',             '5c243538-deac-4a23-b93b-4b6eec6ef20d'),       -- Tammy Saville
  ('LL01-00000000310',       'Joseph Thavundayil',        '7152abe9-8a12-4bba-8239-b04848e9e264'),       -- Amanda Acker
  ('LL01-00000000316',       'Antonio Cernuto',           'f29196f2-2f12-481f-b735-a22c13129d57')        -- Kyle Fong
) as v(serial, wrong_name, correct_id)
where u.serial = v.serial
  and u.customer_id is not null
  -- guard: only move a link that is still pointing where the audit found it
  and exists (
    select 1 from public.customers c
    where c.id = u.customer_id and c.full_name = v.wrong_name
  );

-- ---------------------------------------------------------------------------
-- 2. Link the 9 units that had a customer_name but no FK at all.
--
-- Resolution basis per unit:
--   …039            exact name match
--   …006, …024      parenthetical strip; the record's own annotation reads
--                   "2 units", corroborating that both serials are its
--   …031            parenthetical strip  ("Yun Feng Zhang (William)")
--   …060, …137      honorific strip      ("Mr." / "Ms.")
--   …311/324/313    institutional grouping: Camp Jubilee 1/2/3 are three
--                   machines on one account, whose contact David Duckworth is
--                   already a customer (duckworth@campjubilee.ca). This one is
--                   a judgement call, not a string match — the matcher returns
--                   'none' for "Camp Jubilee 2" by design.
-- ---------------------------------------------------------------------------

update public.units u set customer_id = v.customer_id
from (values
  ('LL01-00000000039'::text, '83e19554-dc03-49a4-bcb7-1de6515ec60e'::uuid), -- Kevin Cheng
  ('LL01-00000000006',       '5eff0871-4302-49d8-92c5-00ab57df788c'),       -- Rongbin Sun
  ('LL01-00000000024',       '5eff0871-4302-49d8-92c5-00ab57df788c'),       -- Rongbin Sun
  ('LL01-00000000031',       '243ae4a4-aa46-43c2-8d2a-b49d4b0dc9a5'),       -- Yun Feng Zhang (William)
  ('LL01-00000000060',       '02dc163a-5eb2-4155-8bbe-ff07e6265daa'),       -- Mr. Phil Parkinson
  ('LL01-00000000137',       '86e3bcb7-5ba5-42aa-884e-a0b5cc393d1c'),       -- Ms. Yuanbo Luo
  ('LL01-00000000311',       'b7276cae-ca81-4773-bc03-5ef4b2a93010'),       -- Camp Jubilee 1
  ('LL01-00000000324',       'b7276cae-ca81-4773-bc03-5ef4b2a93010'),       -- Camp Jubilee 2
  ('LL01-00000000313',       'b7276cae-ca81-4773-bc03-5ef4b2a93010')        -- Camp Jubilee 3
) as v(serial, customer_id)
where u.serial = v.serial
  and u.customer_id is null;   -- guard: never overwrite a link made since the audit

-- ---------------------------------------------------------------------------
-- 3. LL01-…341 is Junaid's office machine, not a customer shipment.
--
-- Its customer_name was set to "Junaid Siddiqui - Office Machine" on
-- 2026-09-01; the stale FK pointed at Kevin Cheng, which is also why Kevin's
-- own unit (…039, linked above) was being hidden from him.
-- ---------------------------------------------------------------------------

update public.units
   set customer_id = null,
       is_team_test = true
 where serial = 'LL01-00000000341'
   and customer_name = 'Junaid Siddiqui - Office Machine';

-- ---------------------------------------------------------------------------
-- 4. Assert the outcome. Fail loudly rather than half-apply.
--
-- Expected, of 175 shipped units:
--   166 FK-linked  (158 before + 9 newly linked − 1 for the office machine)
--     9 unlinked   (8 awaiting triage + the office machine, which is now
--                   is_team_test and so drops out of Stock → Unlinked units)
-- ---------------------------------------------------------------------------

do $$
declare
  linked   int;
  unlinked int;
begin
  select count(*) filter (where customer_id is not null),
         count(*) filter (where customer_id is null)
    into linked, unlinked
    from public.units where status = 'shipped';

  if linked <> 166 or unlinked <> 9 then
    raise exception
      'unit/customer reconciliation did not land as designed: % linked / % unlinked (expected 166 / 9). No changes committed.',
      linked, unlinked;
  end if;
end $$;

commit;
