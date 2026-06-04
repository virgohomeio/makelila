-- Security pass Phase 2 (spec: docs/superpowers/specs/2026-06-03-security-pass-design.md).
-- Sweep every "to authenticated using (true)" operational-table policy and
-- replace with is_internal_user() gating. Customer-form anon policies and
-- per-user-scoped policies (activity_log, order_notes, unit_reworks) get
-- the internal check stacked on; profiles.* policies are untouched.
--
-- Two tables (fulfillment_log, ticket_notes) were added since the plan was
-- written — covered here as well.

-- ---------- activity_log ----------
drop policy if exists "activity_log_select_all_authenticated" on public.activity_log;
create policy "activity_log_select" on public.activity_log
  for select to authenticated using (public.is_internal_user());

drop policy if exists "activity_log_insert_self" on public.activity_log;
create policy "activity_log_insert_self" on public.activity_log
  for insert to authenticated
  with check (public.is_internal_user() and auth.uid() = user_id);

-- ---------- batches ----------
drop policy if exists "batches_select" on public.batches;
create policy "batches_select" on public.batches
  for select to authenticated using (public.is_internal_user());

drop policy if exists "batches_update" on public.batches;
create policy "batches_update" on public.batches
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());

-- ---------- build_attachments ----------
drop policy if exists "attachments_select" on public.build_attachments;
create policy "attachments_select" on public.build_attachments
  for select to authenticated using (public.is_internal_user());

drop policy if exists "attachments_insert" on public.build_attachments;
create policy "attachments_insert" on public.build_attachments
  for insert to authenticated with check (public.is_internal_user());

-- ---------- build_defects ----------
drop policy if exists "defects_select" on public.build_defects;
create policy "defects_select" on public.build_defects
  for select to authenticated using (public.is_internal_user());

drop policy if exists "defects_insert" on public.build_defects;
create policy "defects_insert" on public.build_defects
  for insert to authenticated with check (public.is_internal_user());

drop policy if exists "defects_update" on public.build_defects;
create policy "defects_update" on public.build_defects
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());

-- ---------- burn_in_tests ----------
drop policy if exists "burnin_select" on public.burn_in_tests;
create policy "burnin_select" on public.burn_in_tests
  for select to authenticated using (public.is_internal_user());

drop policy if exists "burnin_insert" on public.burn_in_tests;
create policy "burnin_insert" on public.burn_in_tests
  for insert to authenticated with check (public.is_internal_user());

drop policy if exists "burnin_update" on public.burn_in_tests;
create policy "burnin_update" on public.burn_in_tests
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());

-- ---------- customer_lifecycle ----------
drop policy if exists "lifecycle_select" on public.customer_lifecycle;
create policy "lifecycle_select" on public.customer_lifecycle
  for select to authenticated using (public.is_internal_user());

drop policy if exists "lifecycle_insert" on public.customer_lifecycle;
create policy "lifecycle_insert" on public.customer_lifecycle
  for insert to authenticated with check (public.is_internal_user());

drop policy if exists "lifecycle_update" on public.customer_lifecycle;
create policy "lifecycle_update" on public.customer_lifecycle
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());

-- ---------- customers ----------
drop policy if exists "customers_select" on public.customers;
create policy "customers_select" on public.customers
  for select to authenticated using (public.is_internal_user());

drop policy if exists "customers_insert" on public.customers;
create policy "customers_insert" on public.customers
  for insert to authenticated with check (public.is_internal_user());

drop policy if exists "customers_update" on public.customers;
create policy "customers_update" on public.customers
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());

-- ---------- email_messages ----------
drop policy if exists "email_messages_select" on public.email_messages;
create policy "email_messages_select" on public.email_messages
  for select to authenticated using (public.is_internal_user());

drop policy if exists "email_messages_insert" on public.email_messages;
create policy "email_messages_insert" on public.email_messages
  for insert to authenticated with check (public.is_internal_user());

drop policy if exists "email_messages_update" on public.email_messages;
create policy "email_messages_update" on public.email_messages
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());

-- ---------- email_templates ----------
drop policy if exists "templates_select" on public.email_templates;
create policy "templates_select" on public.email_templates
  for select to authenticated using (public.is_internal_user());

drop policy if exists "templates_insert" on public.email_templates;
create policy "templates_insert" on public.email_templates
  for insert to authenticated with check (public.is_internal_user());

drop policy if exists "templates_update" on public.email_templates;
create policy "templates_update" on public.email_templates
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());

-- ---------- factory_orders ----------
drop policy if exists "factory_orders_select" on public.factory_orders;
create policy "factory_orders_select" on public.factory_orders
  for select to authenticated using (public.is_internal_user());

drop policy if exists "factory_orders_insert" on public.factory_orders;
create policy "factory_orders_insert" on public.factory_orders
  for insert to authenticated with check (public.is_internal_user());

drop policy if exists "factory_orders_update" on public.factory_orders;
create policy "factory_orders_update" on public.factory_orders
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());

-- ---------- freight_shipments ----------
drop policy if exists "freight_select" on public.freight_shipments;
create policy "freight_select" on public.freight_shipments
  for select to authenticated using (public.is_internal_user());

drop policy if exists "freight_insert" on public.freight_shipments;
create policy "freight_insert" on public.freight_shipments
  for insert to authenticated with check (public.is_internal_user());

drop policy if exists "freight_update" on public.freight_shipments;
create policy "freight_update" on public.freight_shipments
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());

-- ---------- fulfillment_log (added by CodeX post-plan) ----------
drop policy if exists "fulfillment_log_select" on public.fulfillment_log;
create policy "fulfillment_log_select" on public.fulfillment_log
  for select to authenticated using (public.is_internal_user());

drop policy if exists "fulfillment_log_insert" on public.fulfillment_log;
create policy "fulfillment_log_insert" on public.fulfillment_log
  for insert to authenticated with check (public.is_internal_user());

drop policy if exists "fulfillment_log_update" on public.fulfillment_log;
create policy "fulfillment_log_update" on public.fulfillment_log
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());

-- ---------- fulfillment_queue ----------
drop policy if exists "fulfillment_queue_select" on public.fulfillment_queue;
create policy "fulfillment_queue_select" on public.fulfillment_queue
  for select to authenticated using (public.is_internal_user());

drop policy if exists "fulfillment_queue_insert" on public.fulfillment_queue;
create policy "fulfillment_queue_insert" on public.fulfillment_queue
  for insert to authenticated with check (public.is_internal_user());

drop policy if exists "fulfillment_queue_update" on public.fulfillment_queue;
create policy "fulfillment_queue_update" on public.fulfillment_queue
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());

-- ---------- gmail_sync_state ----------
drop policy if exists "gss_select" on public.gmail_sync_state;
create policy "gss_select" on public.gmail_sync_state
  for select to authenticated using (public.is_internal_user());

-- ---------- order_cancellations (preserve anon insert policy) ----------
drop policy if exists "ordercancellations_select" on public.order_cancellations;
create policy "ordercancellations_select" on public.order_cancellations
  for select to authenticated using (public.is_internal_user());

drop policy if exists "ordercancellations_insert" on public.order_cancellations;
create policy "ordercancellations_insert" on public.order_cancellations
  for insert to authenticated with check (public.is_internal_user());

drop policy if exists "ordercancellations_update" on public.order_cancellations;
create policy "ordercancellations_update" on public.order_cancellations
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());
-- ordercancellations_insert_anon untouched.

-- ---------- order_notes ----------
drop policy if exists "order_notes_select" on public.order_notes;
create policy "order_notes_select" on public.order_notes
  for select to authenticated using (public.is_internal_user());

drop policy if exists "order_notes_insert" on public.order_notes;
create policy "order_notes_insert" on public.order_notes
  for insert to authenticated
  with check (public.is_internal_user() and author_id = auth.uid());

-- ---------- orders ----------
drop policy if exists "orders_select" on public.orders;
create policy "orders_select" on public.orders
  for select to authenticated using (public.is_internal_user());

drop policy if exists "orders_update" on public.orders;
create policy "orders_update" on public.orders
  for update to authenticated using (public.is_internal_user());

-- ---------- part_shipments ----------
drop policy if exists "partshipments_select" on public.part_shipments;
create policy "partshipments_select" on public.part_shipments
  for select to authenticated using (public.is_internal_user());

drop policy if exists "partshipments_insert" on public.part_shipments;
create policy "partshipments_insert" on public.part_shipments
  for insert to authenticated with check (public.is_internal_user());

drop policy if exists "partshipments_update" on public.part_shipments;
create policy "partshipments_update" on public.part_shipments
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());

-- ---------- parts ----------
drop policy if exists "parts_select" on public.parts;
create policy "parts_select" on public.parts
  for select to authenticated using (public.is_internal_user());

drop policy if exists "parts_insert" on public.parts;
create policy "parts_insert" on public.parts
  for insert to authenticated with check (public.is_internal_user());

drop policy if exists "parts_update" on public.parts;
create policy "parts_update" on public.parts
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());

-- ---------- refund_approvals ----------
drop policy if exists "refundapprovals_select" on public.refund_approvals;
create policy "refundapprovals_select" on public.refund_approvals
  for select to authenticated using (public.is_internal_user());

drop policy if exists "refundapprovals_insert" on public.refund_approvals;
create policy "refundapprovals_insert" on public.refund_approvals
  for insert to authenticated with check (public.is_internal_user());

drop policy if exists "refundapprovals_update" on public.refund_approvals;
create policy "refundapprovals_update" on public.refund_approvals
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());

-- ---------- remote_postal_prefixes ----------
drop policy if exists "remote_postal_prefixes_read" on public.remote_postal_prefixes;
create policy "remote_postal_prefixes_read" on public.remote_postal_prefixes
  for select to authenticated using (public.is_internal_user());

drop policy if exists "remote_postal_prefixes_write" on public.remote_postal_prefixes;
create policy "remote_postal_prefixes_write" on public.remote_postal_prefixes
  for insert to authenticated with check (public.is_internal_user());

drop policy if exists "remote_postal_prefixes_update" on public.remote_postal_prefixes;
create policy "remote_postal_prefixes_update" on public.remote_postal_prefixes
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());

drop policy if exists "remote_postal_prefixes_delete" on public.remote_postal_prefixes;
create policy "remote_postal_prefixes_delete" on public.remote_postal_prefixes
  for delete to authenticated using (public.is_internal_user());

-- ---------- replacement_queue ----------
drop policy if exists "replqueue_select" on public.replacement_queue;
create policy "replqueue_select" on public.replacement_queue
  for select to authenticated using (public.is_internal_user());

drop policy if exists "replqueue_insert" on public.replacement_queue;
create policy "replqueue_insert" on public.replacement_queue
  for insert to authenticated with check (public.is_internal_user());

drop policy if exists "replqueue_update" on public.replacement_queue;
create policy "replqueue_update" on public.replacement_queue
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());

-- ---------- returns (preserve anon insert policy) ----------
drop policy if exists "returns_select" on public.returns;
create policy "returns_select" on public.returns
  for select to authenticated using (public.is_internal_user());

drop policy if exists "returns_insert" on public.returns;
create policy "returns_insert" on public.returns
  for insert to authenticated with check (public.is_internal_user());

drop policy if exists "returns_update" on public.returns;
create policy "returns_update" on public.returns
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());
-- returns_insert_anon untouched.

-- ---------- service_ticket_attachments (preserve anon insert policy) ----------
drop policy if exists "attachments_select" on public.service_ticket_attachments;
create policy "attachments_select" on public.service_ticket_attachments
  for select to authenticated using (public.is_internal_user());

drop policy if exists "attachments_insert_auth" on public.service_ticket_attachments;
create policy "attachments_insert_auth" on public.service_ticket_attachments
  for insert to authenticated with check (public.is_internal_user());
-- attachments_insert_anon untouched (already has customer_form ticket check).

-- ---------- service_tickets (preserve anon insert policy) ----------
drop policy if exists "tickets_select" on public.service_tickets;
create policy "tickets_select" on public.service_tickets
  for select to authenticated using (public.is_internal_user());

drop policy if exists "tickets_insert_auth" on public.service_tickets;
create policy "tickets_insert_auth" on public.service_tickets
  for insert to authenticated with check (public.is_internal_user());

drop policy if exists "tickets_update" on public.service_tickets;
create policy "tickets_update" on public.service_tickets
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());

drop policy if exists "tickets_delete" on public.service_tickets;
create policy "tickets_delete" on public.service_tickets
  for delete to authenticated using (public.is_internal_user());
-- tickets_insert_anon untouched.

-- ---------- shelf_slots ----------
drop policy if exists "shelf_slots_select" on public.shelf_slots;
create policy "shelf_slots_select" on public.shelf_slots
  for select to authenticated using (public.is_internal_user());

drop policy if exists "shelf_slots_update" on public.shelf_slots;
create policy "shelf_slots_update" on public.shelf_slots
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());

-- ---------- team_invite_list ----------
drop policy if exists "invite_list_select" on public.team_invite_list;
create policy "invite_list_select" on public.team_invite_list
  for select to authenticated using (public.is_internal_user());

-- ---------- ticket_classification_log ----------
drop policy if exists "clog_select" on public.ticket_classification_log;
create policy "clog_select" on public.ticket_classification_log
  for select to authenticated using (public.is_internal_user());

drop policy if exists "clog_insert" on public.ticket_classification_log;
create policy "clog_insert" on public.ticket_classification_log
  for insert to authenticated with check (public.is_internal_user());

-- ---------- ticket_messages ----------
drop policy if exists "msgs_select" on public.ticket_messages;
create policy "msgs_select" on public.ticket_messages
  for select to authenticated using (public.is_internal_user());

drop policy if exists "msgs_insert" on public.ticket_messages;
create policy "msgs_insert" on public.ticket_messages
  for insert to authenticated with check (public.is_internal_user());

drop policy if exists "msgs_update" on public.ticket_messages;
create policy "msgs_update" on public.ticket_messages
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());

-- ---------- ticket_notes (added by CodeX post-plan) ----------
drop policy if exists "ticket_notes_select" on public.ticket_notes;
create policy "ticket_notes_select" on public.ticket_notes
  for select to authenticated using (public.is_internal_user());

drop policy if exists "ticket_notes_insert" on public.ticket_notes;
create policy "ticket_notes_insert" on public.ticket_notes
  for insert to authenticated with check (public.is_internal_user());

drop policy if exists "ticket_notes_update" on public.ticket_notes;
create policy "ticket_notes_update" on public.ticket_notes
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());

drop policy if exists "ticket_notes_delete" on public.ticket_notes;
create policy "ticket_notes_delete" on public.ticket_notes
  for delete to authenticated using (public.is_internal_user());

-- ---------- unit_reworks ----------
drop policy if exists "unit_reworks_select" on public.unit_reworks;
create policy "unit_reworks_select" on public.unit_reworks
  for select to authenticated using (public.is_internal_user());

drop policy if exists "unit_reworks_insert" on public.unit_reworks;
create policy "unit_reworks_insert" on public.unit_reworks
  for insert to authenticated
  with check (public.is_internal_user() and flagged_by = auth.uid());

drop policy if exists "unit_reworks_update" on public.unit_reworks;
create policy "unit_reworks_update" on public.unit_reworks
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());

-- ---------- units ----------
drop policy if exists "units_select" on public.units;
create policy "units_select" on public.units
  for select to authenticated using (public.is_internal_user());

drop policy if exists "units_insert" on public.units;
create policy "units_insert" on public.units
  for insert to authenticated with check (public.is_internal_user());

drop policy if exists "units_update" on public.units;
create policy "units_update" on public.units
  for update to authenticated
  using (public.is_internal_user()) with check (public.is_internal_user());
