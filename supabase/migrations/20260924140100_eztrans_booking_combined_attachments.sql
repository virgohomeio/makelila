-- Re-word the EZ Trans booking confirmation now that the documents changed.
--
-- The shipping label and the packing list used to be two attachments; they are
-- merged into one PDF now, and a UPS booking carries the signed FIFRA
-- pesticide worksheet as a second. The old body told the 3PL to look for a
-- packing list and a label, which is no longer what arrives.
--
-- What is attached is now {{attachments_note}}, filled by the edge function
-- from the carrier on the queue row, so the sentence is right on both a UPS
-- booking and every other one without the operator having to keep two versions
-- of the template.
--
-- Only touches rows still carrying the wording this replaces: an operator who
-- has since edited the template in the Templates tab keeps their edit, and
-- gets the new variable available to them rather than having their text
-- overwritten by a migration.

update public.email_templates
set
  body = E'Hello EZ Trans team,\n\nWe are confirming that an order has been placed and the shipment has been booked on Goorooship. Please fulfill it on your end. {{attachments_note}}\n\nCUSTOMER\nName: {{customer_name}}\nAddress: {{customer_address}}\nEmail: {{customer_email}}\nPhone: {{customer_phone}}\n\nSHIPMENT\nProduct Name: {{product_name}}\nSKU: {{sku}}\nSerial No: {{serial}}\nBatch/Lot Number: {{batch_lot}}\nMaster Carton: {{master_carton}}\nQuantity: {{quantity}}\n\nSHIPPING LABEL (attached)\nCarrier: {{carrier}}\nTracking Number: {{tracking}}\nPlease print the attached PDF and affix the shipping label to the carton.\n\nOrder reference: {{order_ref}}\n\nPlease reply to confirm once the unit is picked and the shipment is on its way.\n\nThank you,\nThe VCycene Team',
  description = 'Sent to cs@goorooship.ca when a unit held at the EZTrans 3PL has been booked on Goorooship. The shipping label and the packing-list PDF are merged into one attachment automatically, and a UPS booking also carries the signed FIFRA pesticide worksheet. None of those documents are part of this template.'
where key = 'eztrans_booking'
  and body like '%The packing list and the shipping label are attached to this email.%';

-- Available to every copy of the row, edited or not.
update public.email_templates
set variables = array[
  'customer_name','customer_address','customer_email','customer_phone',
  'product_name','sku','serial','batch_lot','master_carton','quantity',
  'carrier','tracking','order_ref','attachments_note'
]::text[]
where key = 'eztrans_booking';
