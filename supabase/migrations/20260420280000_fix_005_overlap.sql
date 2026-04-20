-- Off-by-one fix for the lost-overlap migration.
--
-- Serial 005 was flipped from P50 to P150 by the initial snapshot (Mary
-- Oskamp P150 replacement 2026-04-14), but the lost-overlap migration
-- missed that fact — it treated 005 like every other low serial still
-- owned by P50. That made:
--   - P50 show 49 instead of 50 (no lost-P50 row at 005)
--   - P150 show 151 instead of 150 (extra lost-P150 row at 005)
--
-- Fix: repoint the existing LL01-00000000005-L row from P150 to P50,
-- matching the actual physical unit that's unaccounted for (the original
-- P50 unit at serial 005 before Mary got the P150 refurb).

update public.units
   set batch = 'P50',
       notes = 'P50 original at serial 00000000005 — physical unit unaccounted for. The plain-serial row at this number is the P150 refurb Mary Oskamp received 2026-04-14.'
 where serial = 'LL01-00000000005-L';
