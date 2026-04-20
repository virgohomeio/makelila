-- Normalize serial ranges per user clarification (2026-04-20):
--   P50   = 1-60         (kept as-is — May 2025 VIP shipments)
--   P150  = 1-150        (earlier seed over-extended to 61-210; remove 151-200)
--   P50N  = 201-240      (40 units, all shipped; earlier seed put at 211-250)
--   P100  = 251-350      (kept as-is)
--   P100X = 351-450      (kept as-is)
--
-- Two data corrections:
--   - Serials 151-200 never existed physically. Delete.
--   - Serials 241-250 are outside every real batch range. Delete.
--   - All serials 201-240 are P50N, status='shipped'. Normalize in place
--     (keeping customer_name / carrier / location from the snapshot).
--   - Serial 045 was listed in the md's Batch 3 P50N section by mistake;
--     the P150 Serial Shipments row (Jason Kemp) has the right batch.

-- 1. Remove phantom overflow serials.
delete from public.units
 where serial between 'LL01-00000000151' and 'LL01-00000000200';

delete from public.units
 where serial between 'LL01-00000000241' and 'LL01-00000000250';

-- 2. Normalize 201-240 to P50N / shipped. Preserves any customer_name,
--    location, carrier, shipped_at already set by the snapshot.
update public.units
   set batch  = 'P50N',
       status = 'shipped',
       notes  = case
         when notes is null or notes ilike '%Toronto warehouse%'
           then 'P50N batch — shipped per 2026-04-20 snapshot (customer TBD if blank)'
         else notes
       end
 where serial between 'LL01-00000000201' and 'LL01-00000000240';

-- 3. Stamp a shipped_at for any 201-240 rows that still lack one so the
--    "Shipped" column on the Stock table isn't all em-dashes for the
--    unmatched P50N serials. Use the status_updated_at as a conservative
--    fallback.
update public.units
   set shipped_at = status_updated_at
 where batch = 'P50N'
   and status = 'shipped'
   and shipped_at is null;

-- 4. Fix 045 batch — was P50N in md Batch 3 section, should be P150.
update public.units
   set batch = 'P150'
 where serial = 'LL01-00000000045';
