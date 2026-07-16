-- Returns should queue in the "Return & inspection" column first; the refund
-- card is compiled manually ("Compile → George") after inspection. Remove the
-- trigger that auto-created a manager_review refund on every customer-form
-- return — it skipped inspection entirely and copied the filer's name onto the
-- refund (instead of the purchaser, when the two differ).
DROP TRIGGER IF EXISTS returns_auto_refund ON public.returns;
DROP FUNCTION IF EXISTS public.auto_create_refund_for_customer_return();
