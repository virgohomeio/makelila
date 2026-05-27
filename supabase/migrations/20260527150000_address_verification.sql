-- Alpha P1 #1: Google Maps address verification.
-- See docs/superpowers/specs/2026-05-27-address-verification-design.md

alter table public.orders
  add column address_verified_at      timestamptz,
  add column address_match            text
    check (address_match in ('match','mismatch','unverifiable')),
  add column address_google_formatted text,
  add column address_google_postal    text,
  add column address_customer_postal  text;
