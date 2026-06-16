-- #83: Add held_reason to orders to support the "hold queued replacement on
-- return/refund" workflow. When an operator holds a replacement order while a
-- refund is in progress, the reason is stored here for audit trail visibility.
-- The replacement_state column already exists as text; 'held' is the new value.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS held_reason text;
