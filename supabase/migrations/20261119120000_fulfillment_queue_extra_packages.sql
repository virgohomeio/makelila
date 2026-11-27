-- A Freightcom booking for more than one box issues one label and one
-- tracking number per box (order #1341: three machines, three labels).
-- fulfillment_queue held exactly one of each, so packages 2..N had nowhere
-- to go.
--
-- Package 1 stays where it always was — carrier / tracking_num /
-- label_pdf_path — so every existing reader (pickup rail, dock step, the
-- customer email, the Shopify push, the Shipping list) keeps working. The
-- rest go here, in box order:
--   [{ "tracking_num": "…", "label_pdf_path": "<queue id>/label-….pdf" }, …]
-- Same carrier as package 1: a Freightcom booking is one carrier.

alter table public.fulfillment_queue
  add column if not exists extra_packages jsonb not null default '[]'::jsonb;
