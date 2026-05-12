-- Promote Ron Russell's return record into the new structured columns.
-- Migration 20260421120000 stuffed everything into description; now that
-- we have proper columns (usage_duration, return_reasons[], rating, etc.)
-- we update his row in place so the Returns table on the ops side reads
-- as a real customer-form submission.

update public.returns
   set
     usage_duration         = 'Less than 1 week',
     return_reasons         = array[
       'Odor issues',
       'Difficult to use or maintain',
       'Device malfunction or hardware issue'
     ],
     support_contacted      = 'Yes — they tried to help but the issue wasn''t resolved',
     experience_rating      = 2,
     would_change_decision  = 'If it worked all the time. and didn''t smell.',
     future_likelihood      = 'Probably Not',
     condition              = 'like-new',
     packaging_status       = 'Partial — some packaging materials',
     alternative_composting = 'None — not composting anymore',
     refund_method_preference = 'Credit Card (Enter phone number below, we will call you)',
     refund_contact         = '604-834-4451',
     additional_comments    = null,
     -- Tidy description down to just the prose the customer wrote
     description            = 'Software glitch. Keeps showing errors. Starts to smell.'
 where source = 'customer_form'
   and customer_email = 'ron@newcmi.ca'
   and original_order_ref = '#1239';
