-- The EZ Trans (Goorooship) booking confirmation, as an operator-editable
-- template.
--
-- Machines held at the EZTrans 3PL are booked on Goorooship rather than
-- Freightcom, and EZ Trans will not pick a box until we email cs@goorooship.ca
-- a confirmation with the packing list and the shipping label attached. The
-- wording was hard-coded when that flow shipped; this lifts it into the
-- Templates tab so it can be changed without a deploy.
--
-- Sent by supabase/functions/send-eztrans-booking, which resolves the wording
-- in this order:
--   1. what the operator typed into the step-3 panel for that one order
--   2. this row
--   3. the built-in default in _shared/eztransTemplate.ts
-- (3) is why this migration is not load-bearing: an environment that has not
-- applied it still sends, it just sends the stock wording. The body below is
-- byte-identical to that default, and a test asserts the two stay in step.
--
-- NOT templated: the packing-list PDF. It is the document EZ Trans picks from,
-- and a field edited out of it would ship a box nobody can identify, so it is
-- rebuilt from the queue row, the order and the shelf row on every send.
--
-- 'fulfillment' category matches where the flow lives (email_templates
-- category check constraint).

insert into public.email_templates (key, name, category, description, subject, body, variables, channel, active)
values
(
  'eztrans_booking',
  'EZ Trans booking confirmation',
  'fulfillment',
  'Sent to cs@goorooship.ca when a unit held at the EZTrans 3PL has been booked on Goorooship. The packing-list PDF and the shipping label are attached automatically and are not part of this template.',
  E'Order confirmed — {{order_ref}} · {{sku}} · Serial {{serial}}',
  E'Hello EZ Trans team,\n\nWe are confirming that an order has been placed and the shipment has been booked on Goorooship. Please fulfill it on your end. The packing list and the shipping label are attached to this email.\n\nCUSTOMER\nName: {{customer_name}}\nAddress: {{customer_address}}\nEmail: {{customer_email}}\nPhone: {{customer_phone}}\n\nSHIPMENT\nProduct Name: {{product_name}}\nSKU: {{sku}}\nSerial No: {{serial}}\nBatch/Lot Number: {{batch_lot}}\nMaster Carton: {{master_carton}}\nQuantity: {{quantity}}\n\nSHIPPING LABEL (attached)\nCarrier: {{carrier}}\nTracking Number: {{tracking}}\nPlease print the attached label and affix it to the carton.\n\nOrder reference: {{order_ref}}\n\nPlease reply to confirm once the unit is picked and the shipment is on its way.\n\nThank you,\nThe VCycene Team',
  array[
    'customer_name','customer_address','customer_email','customer_phone',
    'product_name','sku','serial','batch_lot','master_carton','quantity',
    'carrier','tracking','order_ref'
  ]::text[],
  'email',
  true
)
on conflict (key) do nothing;
