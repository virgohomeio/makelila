-- Fulfillment › Queue → Shopify: record whether a fulfilled row has been
-- marked fulfilled on the Shopify order too.
--
-- Confirming pickup (step 5 → 6) now calls push-shopify-fulfillments for that
-- one row. The function writes the outcome here so the Fulfilled panel can say
-- "Marked fulfilled in Shopify" or show the error with a retry, instead of the
-- result vanishing with the HTTP response.
--
--   shopify_fulfilled_at  set when Shopify accepted the fulfillment, or when
--                         Shopify already showed the order fulfilled
--   shopify_sync_error    the last failure / skip reason; cleared on success
--
-- Replacement rows are never written: they are makeLILA-only orders with no
-- Shopify counterpart.

alter table public.fulfillment_queue
  add column if not exists shopify_fulfilled_at timestamptz,
  add column if not exists shopify_sync_error text;
