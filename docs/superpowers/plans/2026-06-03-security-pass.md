# Security Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three CodeX-flagged security gaps (#45 edge function JWT verification, #46 React-only `@virgohome.io` gate, #48 unverified anonymous storage uploads) by introducing one shared identity check (`profiles.is_internal`) and gating RLS, edge functions, and storage uploads against it.

**Architecture:** Add a boolean column on the existing `profiles` table + a `SECURITY DEFINER` SQL helper `public.is_internal_user()`. Rewrite all "operational" RLS policies (currently `to authenticated using (true)`) to call the helper. Wrap every edge function with a shared `authenticate()` function that accepts EITHER an `X-Cron-Secret` header OR a user JWT whose profile is internal. Replace the loose UUID-regex anon storage policy with a real `service_tickets`-row existence check.

**Tech Stack:** Postgres RLS · Supabase edge functions (Deno + TS) · Supabase storage policies · pg_cron + the existing `public.invoke_edge_function()` helper.

**Spec:** [`docs/superpowers/specs/2026-06-03-security-pass-design.md`](docs/superpowers/specs/2026-06-03-security-pass-design.md)

---

## File touch list (overview)

| File | Phase | Task |
|------|-------|------|
| `supabase/migrations/20260603160000_profiles_is_internal.sql` | 1 | T2 |
| `supabase/migrations/20260603170000_rls_internal_only.sql` | 2 | T3 |
| `supabase/migrations/20260603180000_cron_secret_header.sql` | 3a | T4 |
| `supabase/functions/_shared/auth.ts` | 3b | T5 |
| `supabase/functions/sync-shopify-orders/index.ts` | 3c | T6 |
| `supabase/functions/send-fulfillment-email/index.ts` | 3c | T6 |
| `supabase/functions/sync-hubspot-customers/index.ts` | 3c | T6 |
| `supabase/functions/send-template-email/index.ts` | 3c | T6 |
| `supabase/functions/sync-calendly-events/index.ts` | 3c | T6 |
| `supabase/functions/sync-hubspot-tickets/index.ts` | 3c | T6 |
| `supabase/functions/push-shopify-fulfillments/index.ts` | 3c | T6 |
| `supabase/functions/verify-address/index.ts` | 3c | T6 |
| `supabase/migrations/20260603190000_storage_ticket_form_check.sql` | 4 | T7 |
| Supabase secret `CRON_SHARED_SECRET` + Postgres GUC `app.cron_shared_secret` | 3a | T4 (manual, user) |

---

## Task 1: Pre-flight verification (no commit)

**Goal:** Confirm every active operator has access AFTER Phase 1+2. If anyone is missing, Phase 2 will lock them out.

- [ ] **Step 1: Inspect all auth users vs. profiles**

Run via `mcp__claude_ai_Supabase__execute_sql`:

```sql
select u.email,
       p.id is not null as has_profile,
       case when u.last_sign_in_at > now() - interval '30 days' then 'recent' else 'stale' end as activity
  from auth.users u
  left join public.profiles p on p.id = u.id
 order by u.last_sign_in_at desc nulls last;
```

Expected: every recent (`activity='recent'`) user has `has_profile=true`. If a recent user has no profile row, the auto-insert trigger from migration `20260417015714_profiles.sql` failed for them — investigate before proceeding.

- [ ] **Step 2: Preview the Phase 1 backfill**

```sql
-- Who WILL get is_internal=true after Phase 1's backfill?
select count(*) as would_backfill,
       array_agg(u.email order by u.email) as emails
  from auth.users u
 where lower(u.email) like '%@virgohome.io';
```

Expected: every active operator's email is in the list (george, julie, junaid, raymond, reina, huayi, plus anyone else who currently uses the app).

- [ ] **Step 3: List recent non-virgohome.io signins**

```sql
select email, last_sign_in_at
  from auth.users
 where lower(email) not like '%@virgohome.io'
   and last_sign_in_at > now() - interval '30 days';
```

Expected: empty. If anyone here is intentional (e.g. a contractor), they need to be manually flipped to `is_internal=true` AFTER Phase 1.

- [ ] **Step 4: Report findings**

Summarize: (a) total operators that will be backfilled, (b) any non-virgohome.io recent users (red flag — they'll lose access in Phase 2 unless manually granted). Block on user confirmation if anyone's missing.

---

## Task 2: Phase 1 — `profiles.is_internal` + helper

**Files:**
- Create: `supabase/migrations/20260603160000_profiles_is_internal.sql`

- [ ] **Step 1: Write the migration file**

Save the following as `supabase/migrations/20260603160000_profiles_is_internal.sql`:

```sql
-- Security pass Phase 1 (spec: docs/superpowers/specs/2026-06-03-security-pass-design.md).
-- Add the is_internal flag + the SECURITY DEFINER helper used by every
-- subsequent RLS policy and edge function. INERT until Phase 2 starts
-- reading it — nothing here changes behavior on its own.

alter table public.profiles
  add column if not exists is_internal boolean not null default false;

-- Backfill: anyone currently in profiles whose corresponding auth.users
-- email ends in @virgohome.io is internal. Future signups default false;
-- non-virgohome.io contractors need a manual flip via SQL.
update public.profiles p
   set is_internal = true
  from auth.users u
 where u.id = p.id
   and lower(u.email) like '%@virgohome.io';

-- Helper. SECURITY DEFINER so it reads profiles regardless of caller's
-- own RLS context. STABLE so Postgres can cache the per-statement result.
create or replace function public.is_internal_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid() and is_internal = true
  );
$$;

grant execute on function public.is_internal_user() to authenticated, anon;
```

- [ ] **Step 2: Apply via Supabase MCP**

Use `mcp__claude_ai_Supabase__apply_migration` with:
- `project_id`: `txeftbbzeflequvrmjjr`
- `name`: `profiles_is_internal`
- `query`: the SQL above

Expected: success, no errors.

- [ ] **Step 3: Verify schema + backfill**

Run via `mcp__claude_ai_Supabase__execute_sql`:

```sql
-- Schema: column exists with the right default
select column_name, data_type, column_default, is_nullable
  from information_schema.columns
 where table_name = 'profiles' and column_name = 'is_internal';

-- Backfill: count per is_internal value, list any virgohome.io email
-- that DIDN'T get flipped to true (shouldn't be any)
select is_internal, count(*) from public.profiles group by is_internal;

select u.email, p.is_internal
  from public.profiles p
  join auth.users u on u.id = p.id
 where lower(u.email) like '%@virgohome.io'
   and p.is_internal is not true;
```

Expected:
- `column_default = false`, `is_nullable = NO`
- `is_internal=true` count ≈ number of virgohome.io profiles; `is_internal=false` count covers anyone else
- The third query returns zero rows (all virgohome.io profiles got flipped)

- [ ] **Step 4: Verify helper works**

```sql
-- As a known internal user (replace UUID with a real internal user.id)
set local "request.jwt.claims" = '{"sub":"<internal-user-uuid>"}';
select public.is_internal_user();  -- expect: t

reset role;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-000000000000"}';
select public.is_internal_user();  -- expect: f
```

(If you don't have a known internal UUID handy, grab one from `select id from public.profiles where is_internal limit 1`.)

Expected: first query returns `true`, second returns `false`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260603160000_profiles_is_internal.sql
git commit -m "feat(security): profiles.is_internal + is_internal_user() helper

Phase 1 of the security pass (spec
docs/superpowers/specs/2026-06-03-security-pass-design.md). Adds the
identity column + SECURITY DEFINER helper that Phases 2-4 will gate
on. Backfills is_internal=true for every existing @virgohome.io
profile; new signups default false and need a manual flip.

Inert on its own — no policy or function reads is_internal yet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Phase 2 — RLS rewrite

**Files:**
- Create: `supabase/migrations/20260603170000_rls_internal_only.sql`

This is the **breaking phase.** Non-internal sessions immediately lose access after this migration applies. Pre-flight (Task 1) must be green.

The migration drops and recreates every `to authenticated using (true)` policy on operational tables. **Preserved as-is** (not rewritten):
- `profiles.profiles_select_all_authenticated` / `profiles.profiles_update_self`
- Per-user-scoped policies that already have a tighter predicate: `activity_log_insert_self`, `order_notes_insert`, `unit_reworks_insert` — these get the internal check added on top.
- All `*_insert_anon` policies for customer forms: `returns_insert_anon`, `ordercancellations_insert_anon`, `tickets_insert_anon`, `service_ticket_attachments.attachments_insert_anon`. These stay untouched.

- [ ] **Step 1: Write the migration file**

Save the following as `supabase/migrations/20260603170000_rls_internal_only.sql`:

```sql
-- Security pass Phase 2 (spec: docs/superpowers/specs/2026-06-03-security-pass-design.md).
-- Sweep every "to authenticated using (true)" operational-table policy and
-- replace with is_internal_user() gating. Customer-form anon policies and
-- per-user-scoped policies (with auth.uid() = X predicates) get the
-- internal check stacked on; profiles.* policies are untouched.

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
  for update to authenticated
  using (public.is_internal_user());

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
```

- [ ] **Step 2: Apply via Supabase MCP**

`mcp__claude_ai_Supabase__apply_migration` with `name=rls_internal_only`.

Expected: success.

- [ ] **Step 3: Audit — find any remaining open policies**

```sql
-- Find any operational policy that's still `using (true)` or `with check (true)`
select tablename, policyname, cmd, qual, with_check
  from pg_policies
 where schemaname = 'public'
   and tablename not in ('profiles')
   and 'authenticated' = any(roles)
   and (qual = 'true' or with_check = 'true');
```

Expected: empty result. If any row appears, the table was missed — add a DROP+CREATE block for it and re-apply.

- [ ] **Step 4: Smoke-test as a real internal user**

Open the makelila app in a browser. Sign in with your `@virgohome.io` account. Click through:
- Order Review tab — orders list loads
- Customers tab — customers list loads
- Service → Inbox / Tickets — both load
- Fulfillment queue — queue loads
- Stock — units list loads

Expected: every tab renders data exactly as before.

- [ ] **Step 5: Verify customer forms still work**

In an incognito browser (no auth), navigate to:
- http://localhost:5173/return — page loads, form is interactive
- http://localhost:5173/cancel-order — page loads
- http://localhost:5173/service-request — page loads

(Use `cd app && npm run dev` to start the dev server if needed.)

Expected: pages load. If any returns 401 / blank, an anon policy was accidentally rewritten — review the migration.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260603170000_rls_internal_only.sql
git commit -m "feat(security): RLS gated on is_internal_user() for operational tables

Phase 2 of the security pass. Every \"to authenticated using (true)\"
policy on customers, orders, units, service_tickets,
fulfillment_queue, returns, refunds, etc. is replaced with
is_internal_user() gating. Customer-form anon policies preserved.
Per-user-scoped policies (activity_log, order_notes, unit_reworks)
get the internal check stacked on top of their existing auth.uid()
predicate.

A non-virgohome.io signed-in user now gets empty results on every
operational table instead of full read/write access. The React
@virgohome.io check in lib/auth.tsx is now belt-and-suspenders.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Phase 3a — Cron secret + `invoke_edge_function` helper

**Files:**
- Create: `supabase/migrations/20260603180000_cron_secret_header.sql`
- Manual user action: set `CRON_SHARED_SECRET` (Supabase secret) and `app.cron_shared_secret` (Postgres GUC)

- [ ] **Step 1: Generate a secret and stop**

Generate a 32-byte random secret locally — DO NOT include it in this plan or commit it anywhere. Suggested command:

```bash
openssl rand -hex 32
# or, on Windows PowerShell:
# [Convert]::ToHexString((1..32 | ForEach-Object { Get-Random -Maximum 256 }) | ForEach-Object { [byte]$_ })
```

Copy the output to your clipboard. **DO NOT paste it into chat.**

- [ ] **Step 2: Set the Supabase edge-function secret**

```powershell
$env:KEY = Get-Clipboard
& "./app/node_modules/.bin/supabase.cmd" secrets set CRON_SHARED_SECRET="$env:KEY" --project-ref txeftbbzeflequvrmjjr
```

Expected: `Finished supabase secrets set.`

(Don't `Remove-Item Env:\KEY` yet — Task 4 Step 3 needs it.)

- [ ] **Step 3: Set the Postgres GUC**

Run via `mcp__claude_ai_Supabase__execute_sql` — but this needs the secret. Since the secret is in your local env not the MCP context, the easiest path: have the user execute it themselves via the Supabase Dashboard SQL editor:

```sql
-- Replace <SECRET> with the same value you set in the edge-fn secret.
alter database postgres set app.cron_shared_secret = '<SECRET>';
```

OR if you can run `execute_sql` with the secret substituted, run it through MCP. Either way: confirm success then verify:

```sql
show app.cron_shared_secret;
```

Expected: prints the value. (If you run `show` and get `unrecognized configuration parameter`, the ALTER didn't apply — re-run.)

Now `Remove-Item Env:\KEY` to clear your local env.

- [ ] **Step 4: Write the invoke_edge_function migration**

Save the following as `supabase/migrations/20260603180000_cron_secret_header.sql`:

```sql
-- Security pass Phase 3a (spec: docs/superpowers/specs/2026-06-03-security-pass-design.md).
-- Update the pg_cron → edge function bridge to send X-Cron-Secret. Reads
-- the secret from the Postgres GUC `app.cron_shared_secret` (set via
-- `alter database postgres set app.cron_shared_secret = '...'`).
-- The matching Supabase secret CRON_SHARED_SECRET is what each edge
-- function compares against in Phase 3b's authenticate() wrapper.

create or replace function public.invoke_edge_function(
  fn_name text,
  body jsonb default '{}'::jsonb
)
returns void language plpgsql security definer as $$
declare
  base_url text := coalesce(
    current_setting('app.supabase_url', true),
    'https://txeftbbzeflequvrmjjr.supabase.co'
  );
  anon_key text := coalesce(
    current_setting('app.supabase_anon_key', true),
    -- Match the baked-in fallback from migration 20260512130000.
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4ZWZ0YmJ6ZWZsZXF1dnJtampyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNzk3NjcsImV4cCI6MjA5MTg1NTc2N30.sWmDCODRuhutbHuXcoVIVRvVvVyZADpNysFkerOXNPw'
  );
  cron_secret text := coalesce(current_setting('app.cron_shared_secret', true), '');
begin
  perform net.http_post(
    url := base_url || '/functions/v1/' || fn_name,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || anon_key,
      'X-Cron-Secret', cron_secret
    ),
    body := body
  );
end $$;
```

- [ ] **Step 5: Apply via MCP**

`mcp__claude_ai_Supabase__apply_migration` with `name=cron_secret_header`.

Expected: success.

- [ ] **Step 6: Verify the header reaches a function**

Trigger one cron job manually and inspect a recent invocation log:

```sql
select public.invoke_edge_function('sync-quo-tickets');
```

Then check `get_logs(service='edge-function')` for sync-quo-tickets in the last minute. It should show a 200 (function still works because Phase 3b hasn't gated it yet — the header is just a no-op until then).

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260603180000_cron_secret_header.sql
git commit -m "feat(security): pg_cron sends X-Cron-Secret to edge functions

Phase 3a of the security pass. invoke_edge_function() now reads the
app.cron_shared_secret Postgres GUC and forwards it as an X-Cron-Secret
header on every cron-triggered fn call. Header is inert until Phase 3b
deploys the authenticate() wrapper that reads it.

Manual setup BEFORE applying this migration:
  alter database postgres set app.cron_shared_secret = '<value>';
  supabase secrets set CRON_SHARED_SECRET='<value>' --project-ref ...

Both values must match.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Phase 3b — Shared auth wrapper

**Files:**
- Create: `supabase/functions/_shared/auth.ts`

- [ ] **Step 1: Write the wrapper**

Save the following as `supabase/functions/_shared/auth.ts`:

```ts
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

export type Caller =
  | { kind: 'cron' }
  | { kind: 'user'; user_id: string; email: string };

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/**
 * Authenticates an edge-function request. Returns a Caller on success.
 * On failure, throws a fully-formed Response that the handler should
 * return directly.
 *
 * Auth paths (in order):
 *   1. X-Cron-Secret header matches CRON_SHARED_SECRET env var → kind='cron'
 *   2. Authorization: Bearer <jwt> resolves to a profiles.is_internal=true
 *      user → kind='user'
 *   3. Otherwise → throws a 401/403 Response.
 *
 * Mixed-caller functions (sync-hubspot-customers — both cron and operator
 * "Sync now" button) get whichever path the inbound request used.
 */
export async function authenticate(req: Request, admin: SupabaseClient): Promise<Caller> {
  // Path 1: cron-secret header.
  const cronSecret = Deno.env.get('CRON_SHARED_SECRET');
  const cronHeader = req.headers.get('x-cron-secret');
  if (cronHeader && cronSecret && cronHeader === cronSecret) {
    return { kind: 'cron' };
  }

  // Path 2: user JWT.
  const authHeader = req.headers.get('authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) throw jsonError(401, 'Missing Authorization header');

  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) throw jsonError(401, 'Invalid token');

  const { data: profile, error: pErr } = await admin
    .from('profiles')
    .select('is_internal')
    .eq('id', userData.user.id)
    .maybeSingle();
  if (pErr) throw jsonError(500, `Profile lookup: ${pErr.message}`);
  if (!profile?.is_internal) throw jsonError(403, 'Not authorized');

  return {
    kind: 'user',
    user_id: userData.user.id,
    email: userData.user.email ?? '',
  };
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/auth.ts
git commit -m "feat(security): shared edge-function auth wrapper

Phase 3b of the security pass. _shared/auth.ts exports authenticate(),
which every edge function calls at the top of its handler. Accepts
either an X-Cron-Secret header (cron path) or a user JWT whose profile
has is_internal=true (operator path).

Inert until Phase 3c wires it into each function.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

(No deploy needed — `_shared/` files are bundled into each function at deploy time.)

---

## Task 6: Phase 3c — Apply wrapper to all 8 edge functions

**Files:** all 8 `supabase/functions/<name>/index.ts`.

Each function needs the same 5-line snippet inserted at the top of its `handle()` function (right after env-var checks, before the function's actual work). Do them ONE AT A TIME and verify each before moving on.

**The snippet to add to each function:**

```ts
import { authenticate } from '../_shared/auth.ts';

// … inside handle() / Deno.serve() body, after env-var checks:
const admin = createClient(supabaseUrl, serviceKey);
let _caller;
try { _caller = await authenticate(req, admin); }
catch (e) { if (e instanceof Response) return e; throw e; }
// _caller.kind === 'cron' | 'user'. For functions that record who-did-what
// (e.g. send-fulfillment-email's email_sent_by), use:
//   _caller.kind === 'user' ? _caller.user_id : null
```

For functions that **already manually parse the JWT** (e.g. `send-fulfillment-email` reads the sub claim from the Authorization header at line ~170), replace that block with the `authenticate()` call and use `_caller.user_id`.

**For each of the 8 functions below:**

- [ ] **Step a: Edit the function file** to add the import + `authenticate()` call at the top of `handle()`.
- [ ] **Step b: Replace manual JWT parsing** (if any) with `_caller.user_id`.
- [ ] **Step c: Re-deploy via `mcp__claude_ai_Supabase__deploy_edge_function`** with `verify_jwt: false` (preserves existing gateway setting) and the FULL inlined file contents.
- [ ] **Step d: Verify cron path** (for cron-invoked fns): trigger `select public.invoke_edge_function('<name>');` from MCP execute_sql, then check edge-function logs show a 200.
- [ ] **Step e: Verify user path** (for UI-invoked fns): use the makelila UI in a browser, perform the operation that calls this function (e.g. click "Sync now" in Customers tab for sync-hubspot-customers), confirm it succeeds.
- [ ] **Step f: Verify unauthorized path**: `curl -X POST 'https://txeftbbzeflequvrmjjr.supabase.co/functions/v1/<name>' -H 'Content-Type: application/json' --data '{}'`. Expected: 401 (`{"error":"Missing Authorization header"}`).

**Order to apply (cron-only first; mixed and UI-only last):**

1. **sync-shopify-orders** — cron only. Verify via cron tick + 401 from curl.
2. **sync-calendly-events** — cron only. Same verification.
3. **sync-hubspot-tickets** — cron only. Same verification.
4. **push-shopify-fulfillments** — UI-triggered. Verify via UI action ("Push fulfillments" in OrderReview if present) + 401 from curl.
5. **sync-hubspot-customers** — mixed (cron + UI "Sync now"). Verify BOTH paths.
6. **send-fulfillment-email** — UI-triggered. Replace the manual JWT parsing at line ~170 with `_caller.user_id`. Verify via Fulfillment Step 5 in browser + 401 from curl.
7. **send-template-email** — UI-triggered. Same JWT-parse cleanup if present. Verify via Templates tab + 401 from curl.
8. **verify-address** — UI-triggered. Verify via OrderReview "Verify address" button + 401 from curl.

- [ ] **Step 9 (after all 8 deployed): Commit**

```bash
git add supabase/functions/sync-shopify-orders/index.ts \
        supabase/functions/sync-calendly-events/index.ts \
        supabase/functions/sync-hubspot-tickets/index.ts \
        supabase/functions/push-shopify-fulfillments/index.ts \
        supabase/functions/sync-hubspot-customers/index.ts \
        supabase/functions/send-fulfillment-email/index.ts \
        supabase/functions/send-template-email/index.ts \
        supabase/functions/verify-address/index.ts
git commit -m "feat(security): all edge functions gated via authenticate()

Phase 3c of the security pass. Every edge function now calls
authenticate(req, admin) at the top of handle(). Cron-triggered
invocations pass the X-Cron-Secret check; operator-triggered
invocations validate the JWT and verify profiles.is_internal=true.
Unauthorized requests get 401/403 before any work runs.

send-fulfillment-email and send-template-email used to base64-decode
the JWT manually to extract the sub claim for email_sent_by;
replaced with caller.user_id from the wrapper.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Phase 4 — Storage policy tightening

**Files:**
- Create: `supabase/migrations/20260603190000_storage_ticket_form_check.sql`

- [ ] **Step 1: Write the migration**

Save the following as `supabase/migrations/20260603190000_storage_ticket_form_check.sql`:

```sql
-- Security pass Phase 4 (spec: docs/superpowers/specs/2026-06-03-security-pass-design.md).
-- Replace the loose UUID-regex anon storage policy with a real
-- service_tickets-row existence check. The customer-form code already
-- inserts the ticket first then uploads to {ticket_id}/...; this just
-- adds a real check instead of a regex-shape check. A leaked ticket-id
-- is still uploadable to but the attacker would need an active
-- customer-form ticket UUID, which we don't expose publicly.

create or replace function public.customer_form_ticket_exists(p_ticket_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.service_tickets
     where id = p_ticket_id and source = 'customer_form'
  );
$$;
grant execute on function public.customer_form_ticket_exists(uuid) to anon;

drop policy if exists "ticket_attachments_write_anon" on storage.objects;
create policy "ticket_attachments_write_anon" on storage.objects
  for insert to anon
  with check (
    bucket_id = 'ticket-attachments'
    and public.customer_form_ticket_exists(
      ((storage.foldername(name))[1])::uuid
    )
  );
```

- [ ] **Step 2: Apply via MCP**

`mcp__claude_ai_Supabase__apply_migration` with `name=storage_ticket_form_check`.

Expected: success.

- [ ] **Step 3: Verify the new policy rejects bogus uploads**

```bash
# Use the anon key (publishable) — same one as Browser. Replace <ANON_KEY>.
curl -X POST \
  'https://txeftbbzeflequvrmjjr.supabase.co/storage/v1/object/ticket-attachments/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/test.jpg' \
  -H 'apikey: <ANON_KEY>' \
  -H 'Authorization: Bearer <ANON_KEY>' \
  -H 'Content-Type: image/jpeg' \
  --data-binary @/dev/null
```

Expected: 403 (no service_tickets row with that UUID).

- [ ] **Step 4: Verify the customer-form flow still works**

In an incognito browser, submit a `/return` or `/service-request` form WITH a photo attached. The form should:
1. Insert the ticket
2. Upload the photo

Expected: form submission succeeds; the photo appears in the ops view of that ticket.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260603190000_storage_ticket_form_check.sql
git commit -m "feat(security): require real customer_form ticket for anon storage upload

Phase 4 of the security pass. Replaces the UUID-regex check on
ticket-attachments anon uploads with a real EXISTS check against
service_tickets where source='customer_form'. Closes the free-CDN /
storage-quota DOS exposure (any anon could upload to any UUID path
before).

The customer-form flow (ReturnForm, ServiceRequestForm) already
inserts the ticket then uploads, so no app-side change needed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Final verification (no commit)

- [ ] **Step 1: RLS state audit**

```sql
select tablename, count(*) filter (where qual = 'true') as open_select,
       count(*) filter (where with_check = 'true') as open_write
  from pg_policies
 where schemaname = 'public'
   and 'authenticated' = any(roles)
 group by tablename
 having count(*) filter (where qual = 'true' or with_check = 'true') > 0;
```

Expected: empty (or only the profiles row, which is intentional).

- [ ] **Step 2: All edge functions reject unauthenticated requests**

For each of the 8 functions:
```bash
curl -X POST 'https://txeftbbzeflequvrmjjr.supabase.co/functions/v1/<name>' \
  -H 'Content-Type: application/json' --data '{}'
```

Expected: 401 for every one.

- [ ] **Step 3: Cron invocations still work**

```sql
-- Trigger each cron-driven function manually
select public.invoke_edge_function('sync-quo-tickets');
select public.invoke_edge_function('sync-gmail-tickets');
select public.invoke_edge_function('sync-calendly-events');
select public.invoke_edge_function('sync-hubspot-tickets');
select public.invoke_edge_function('sync-hubspot-customers');
```

Then `get_logs(service='edge-function')` should show 200s for all five in the last minute.

- [ ] **Step 4: UI flows still work as an internal user**

In the makelila app: Order Review, Fulfillment, Build, PostShipment, Service (Inbox/Tickets/Onboarding/Repair), Stock, Customers, Templates, ActivityLog, Dashboard — every tab loads with data.

- [ ] **Step 5: Non-internal user is locked out**

Have a colleague sign in with a fresh Google account (NOT `@virgohome.io`). The React layer will sign them out, but also:
- They cannot reach any operational table directly via the Supabase JS client
- Verify via the console: `await window.supabase.from('customers').select('*')` returns `[]` (empty array, no error — RLS just hides the rows).

- [ ] **Step 6: Customer forms still work as anonymous**

In an incognito browser, submit `/return`, `/cancel-order`, `/service-request` — each succeeds; the new ticket appears in the ops view.

- [ ] **Step 7: Report and close**

Summarize: total commits, total tasks completed, any issues found during verification. Update the CodeX backlog items #45 / #46 / #48 to mark them as shipped.
