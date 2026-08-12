-- Return/refund card photos split into two operator-facing sections:
--   context    → "Context of the Case - Photos" (what the customer sent / why
--                the case exists)
--   inspection → "Inspection Photos" (what we found once the unit landed)
--
-- Everything uploaded before this migration was a single undifferentiated
-- strip, so it backfills to 'context' — those photos were overwhelmingly the
-- customer-supplied evidence that opened the case. Operators can re-upload
-- into Inspection where it matters.
-- (Applied to prod via MCP.)

alter table public.return_attachments
  add column if not exists category text not null default 'context';

alter table public.return_attachments
  drop constraint if exists return_attachments_category_check;

alter table public.return_attachments
  add constraint return_attachments_category_check
  check (category in ('context', 'inspection'));

create index if not exists return_attachments_return_id_category_idx
  on public.return_attachments(return_id, category);
