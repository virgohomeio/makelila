-- Misc unit data fixes per 2026-04-20 review:
--
-- 1. Chris Phillips (LL01-00000000029) had no date in notes so the regex
--    back-fill missed him; he's at migration-run timestamp. Real ship
--    date isn't in the md (status was "Shipped, Not Delivered" without a
--    date). Null shipped_at so the History tab shows "—" rather than
--    making up a date.
--
-- 2. Louis DiPalma (LL01-00000000253) and Brent Neave (LL01-00000000298)
--    are internal test fulfillments, not real customer shipments. Suffix
--    "(test)" on customer_name and prepend a TEST tag in notes so they
--    don't pollute customer-facing stats.

-- 1. Clear Chris Phillips' fabricated shipped_at
update public.units
   set shipped_at = null
 where serial = 'LL01-00000000029';

-- 2. Tag Louis + Brent as test fulfillments
update public.units
   set customer_name = 'Louis DiPalma (test)',
       notes         = '[TEST FULFILLMENT] ' || coalesce(notes, '')
 where serial = 'LL01-00000000253'
   and customer_name not like '%(test)%';

update public.units
   set customer_name = 'Brent Neave (test)',
       notes         = '[TEST FULFILLMENT] ' || coalesce(notes, '')
 where serial = 'LL01-00000000298'
   and customer_name not like '%(test)%';
