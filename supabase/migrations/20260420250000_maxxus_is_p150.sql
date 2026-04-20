-- User clarification 2026-04-20: every unit shipped via the MaxxUs log is
-- physically from the P150 batch, even when the printed serial overlaps a
-- serial that was originally on a P50 VIP unit (the P50 originals with
-- those numbers were returned and are no longer in the ledger).
--
-- The rows below were written as batch='P50' by the initial snapshot
-- migration because the serial < 61. Flip them to batch='P150' — the
-- current physical unit at that serial is the P150 refurb that MaxxUs
-- delivered. Status / customer / carrier / location / defect_reason set
-- by later migrations are preserved.

update public.units
   set batch = 'P150'
 where serial in (
   'LL01-00000000004',  -- Sharon Corcoran (MaxxUs 2025-11-11)
   'LL01-00000000007',  -- Melissa Braschuk (MaxxUs 2025-12-29)
   'LL01-00000000016',  -- Doug Bailey (MaxxUs 2025-11-04)
   'LL01-00000000017',  -- Michael Madigan (MaxxUs 2025-11-04)
   'LL01-00000000019',  -- Matthew Lypkie (MaxxUs 2025-12-29, returned 2026-01-26)
   'LL01-00000000021',  -- Don Saldana (MaxxUs 2026-01-19, returned 2026-02-17)
   'LL01-00000000023',  -- Shelley M Small (MaxxUs 2025-12-29, returned 2026-03-16)
   'LL01-00000000025',  -- Matthew Mossey (MaxxUs 2026-01-06)
   'LL01-00000000026',  -- Steven Yang (MaxxUs 2025-10-21)
   'LL01-00000000033',  -- David Foster (MaxxUs 2025-10-21)
   'LL01-00000000043',  -- Sharai Mustatia (MaxxUs 2026-01-06, returned 2026-02-04)
   'LL01-00000000044',  -- Jeff Mottle (MaxxUs 2026-01-19)
   'LL01-00000000049',  -- Jill & James Washington (MaxxUs 2025-12-01)
   'LL01-00000000050',  -- Jenifer Henry (MaxxUs 2026-01-19)
   'LL01-00000000060'   -- Phil Parkinson (MaxxUs 2025-10-21)
 );
