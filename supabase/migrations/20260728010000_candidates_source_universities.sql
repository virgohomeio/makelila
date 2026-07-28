-- Adds campus-recruiting sources for intern postings. Idempotent (drop-if-
-- exists + recreate) so this safely re-applies if `db push` ever replays it
-- after already being applied directly via the Supabase SQL editor/MCP.
alter table public.candidates drop constraint if exists candidates_source_check;
alter table public.candidates add constraint candidates_source_check
  check (source in ('indeed', 'linkedin', 'referral', 'other', 'university_of_waterloo', 'university_of_toronto', 'york_university'));
