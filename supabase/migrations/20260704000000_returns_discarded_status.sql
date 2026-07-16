-- Add 'discarded' status for units the customer disposed of instead of shipping back.
ALTER TABLE returns DROP CONSTRAINT returns_status_check;
ALTER TABLE returns ADD CONSTRAINT returns_status_check
  CHECK (status = ANY (ARRAY[
    'created','pickup_scheduled','picked_up','received',
    'inspected','refunded','denied','closed','discarded'
  ]));
