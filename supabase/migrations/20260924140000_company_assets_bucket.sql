-- Private bucket for company documents that edge functions stamp onto
-- generated PDFs.
--
-- First tenant: the certifier's handwritten signature, which
-- send-eztrans-booking draws onto the UPS pesticide worksheet. It is
-- deliberately NOT in the repo — this repo is public, and a real person's
-- signature in a public git history is forgery material that cannot be taken
-- back. It lives here instead, readable only with the service role.
--
-- No policies are created on purpose. Storage denies by default, so with the
-- bucket private and nothing granted, anon and authenticated clients cannot
-- list, read or write it; the edge function reaches it with the service role,
-- which bypasses RLS. If a browser ever needs one of these, add a narrow
-- select policy for that path rather than opening the bucket.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'company-assets',
  'company-assets',
  false,
  5242880,
  array['image/png', 'image/jpeg', 'application/pdf']
)
on conflict (id) do nothing;
