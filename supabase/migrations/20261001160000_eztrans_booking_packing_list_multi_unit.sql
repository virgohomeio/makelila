-- An order is not one machine: the EZ Trans templates name every unit on it.
--
-- Both documents had a single "Serial No" line and a hardcoded "Quantity: 1".
-- M-0001 is three LILA Pros, so the booking EZ Trans works from named one of
-- the three and told them to pick one box. The other two were on the order, in
-- the queue and reserved in Stock, and absent from the only document the 3PL
-- reads. One box would have shipped against a three-unit order.
--
-- {{units_block}} is the fix: one "Serial No: … — Master Carton: …" line per
-- machine, so the pairing survives when two units sit on different cartons.
-- {{serial}} and {{master_carton}} are kept, as lists, for any wording an
-- operator writes themselves; {{quantity}} is now the count of units on the
-- row rather than the constant 1.
--
-- These bodies must stay byte-identical to DEFAULT_EZTRANS_* in
-- supabase/functions/_shared/eztransTemplate.ts — eztransTemplate.test.ts and
-- eztransPackingList.test.ts fail the build on drift.

update public.email_templates set
  subject = E'Order confirmed — {{order_ref}} · {{quantity}} × {{sku}} · Serial {{serial}}',
  body = E'Hello EZ Trans team,\n\nWe are confirming that an order has been placed and the shipment has been booked on Goorooship. Please fulfill it on your end. {{attachments_note}}\n\nCUSTOMER\nName: {{customer_name}}\nAddress: {{customer_address}}\nEmail: {{customer_email}}\nPhone: {{customer_phone}}\n\nSHIPMENT\nProduct Name: {{product_name}}\nSKU: {{sku}}\nBatch/Lot Number: {{batch_lot}}\nQuantity: {{quantity}}\n{{units_block}}\n\nSHIPPING LABEL (attached)\nCarrier: {{carrier}}\nTracking Number: {{tracking}}\nPlease print the attached PDF and affix the shipping label to the carton.\n\nOrder reference: {{order_ref}}\n\nPlease reply to confirm once the order is picked and the shipment is on its way.\n\nThank you,\nThe VCycene Team',
  variables = array[
    'customer_name','customer_address','customer_email','customer_phone',
    'product_name','sku','serial','batch_lot','master_carton','quantity',
    'units_block','carrier','tracking','order_ref','attachments_note'
  ]
where key = 'eztrans_booking';

update public.email_templates set
  body = E'# PACKING LIST\nOrder: {{order_ref}}\nDate: {{date}}\n\n## SHIP TO\n{{customer_name}}\n{{customer_address_block}}\nEmail: {{customer_email}}\nPhone: {{customer_phone}}\n\n## CONTENTS\nProduct Name: {{product_name}}\nSKU: {{sku}}\nBatch/Lot Number: {{batch_lot}}\nQuantity: {{quantity}}\n{{units_block}}\n\n## SHIPPING\nCarrier: {{carrier}}\nTracking No: {{tracking}}\n\nVCycene Inc. - LILA Composter\nQuestions: support@lilacomposter.com',
  variables = array[
    'customer_name','customer_address_block','customer_email','customer_phone',
    'product_name','sku','serial','batch_lot','master_carton','quantity',
    'units_block','carrier','tracking','order_ref','date'
  ]
where key = 'eztrans_packing_list';
