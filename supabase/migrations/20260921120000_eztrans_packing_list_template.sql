-- The EZ Trans packing list, as an operator-editable template.
--
-- The packing list is the document EZ Trans prints and tapes to the box. It
-- was built in code and deliberately un-editable, on the reasoning that a
-- field edited out of it would ship a box nobody can identify. Operators need
-- to add a one-off handling note or correct a carton line without waiting on a
-- deploy, so it is a template now — but the guarantee it was protecting is
-- kept a different way: send-eztrans-booking fills every {{variable}} below
-- from the queue row, the order and the shelf row, so an edit changes what the
-- document says, never which shipment it describes.
--
-- Resolved in the same order as the wording:
--   1. what the operator typed into the step-3 panel for that one order
--   2. this row
--   3. the built-in default in _shared/eztransTemplate.ts
-- (3) is why this migration is not load-bearing: an environment that has not
-- applied it still sends, it just sends the stock list. The body below is
-- byte-identical to that default, and a test asserts the two stay in step.
--
-- Line markers, read by packingListLines() when the PDF is built:
--   '# '  document title
--   '## ' section heading
--   blank line becomes space under the line above
-- Everything else is a body line, so an all-caps value line like
-- "SKU: LILA-P100X" is never mistaken for a heading.

insert into public.email_templates (key, name, category, description, subject, body, variables, channel, active)
values
(
  'eztrans_packing_list',
  'EZ Trans packing list (PDF)',
  'fulfillment',
  'The packing-list PDF attached to the EZ Trans booking confirmation. Start a line with # for the title and ## for a section heading. Variables are filled from the order and the queue row when it sends.',
  E'Packing list — {{order_ref}}',
  E'# PACKING LIST\nOrder: {{order_ref}}\nDate: {{date}}\n\n## SHIP TO\n{{customer_name}}\n{{customer_address_block}}\nEmail: {{customer_email}}\nPhone: {{customer_phone}}\n\n## CONTENTS\nProduct Name: {{product_name}}\nSKU: {{sku}}\nSerial No: {{serial}}\nBatch/Lot Number: {{batch_lot}}\nMaster Carton: {{master_carton}}\nQuantity: {{quantity}}\n\n## SHIPPING\nCarrier: {{carrier}}\nTracking No: {{tracking}}\n\nVCycene Inc. - LILA Composter\nQuestions: support@lilacomposter.com',
  array[
    'customer_name','customer_address_block','customer_email','customer_phone',
    'product_name','sku','serial','batch_lot','master_carton','quantity',
    'carrier','tracking','order_ref','date'
  ]::text[],
  'email',
  true
)
on conflict (key) do nothing;
