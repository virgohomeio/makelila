-- Decouple customer-paid shipping from the operator's freight estimate
-- (backlog #65). Today both surfaces (FreightCard's editable estimate +
-- LineItemsCard's Payment Summary "Shipping" row) read from the same column
-- `orders.freight_estimate_usd`. Operator edits to the freight estimate
-- silently change the "shipping actually paid" row — which is wrong because
-- the customer's invoice isn't being modified.
--
-- Quick fix: add a separate column for the customer-paid value. The Shopify
-- sync function writes the same Shopify value to BOTH columns at insert
-- time; the operator can then edit `freight_estimate_usd` without affecting
-- the payment summary.
--
-- Backfill copies the current freight_estimate_usd into the new column for
-- every existing order. For orders the operator has already edited, this
-- captures the operator's edited value rather than the original Shopify
-- value — best we can do without re-syncing. A future re-sync from Shopify
-- will correct any drift on un-finalized orders.

alter table public.orders
  add column if not exists customer_paid_shipping_usd numeric(10,2);

update public.orders
  set customer_paid_shipping_usd = freight_estimate_usd
  where customer_paid_shipping_usd is null;
