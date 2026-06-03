# Security Pass — Design Spec

**Date:** 2026-06-03
**Author:** Huayi Gao (with Claude)
**Status:** Draft for review
**Addresses:** CodeX backlog items #45 (edge function JWT verification), #46 (move `@virgohome.io` auth gate into RLS), #48 (tighten anonymous ticket-attachment uploads).

---

## 1. Problem

Three linked security gaps in the production app:

1. **Edge functions are unauthenticated.** All 8 functions (`sync-shopify-orders`, `send-fulfillment-email`, `sync-hubspot-customers`, `send-template-email`, `sync-calendly-events`, `sync-hubspot-tickets`, `push-shopify-fulfillments`, `verify-address`) have `verify_jwt = false` in `supabase/config.toml`. They use the service-role key internally with no caller verification. A determined external party who learns the function URL can invoke any of them.
2. **`@virgohome.io` access gate is React-only.** [`app/src/lib/auth.tsx:8-11`](app/src/lib/auth.tsx#L8-L11) checks the email-domain suffix in the React shell. The 97 RLS policies in the project that match `to authenticated using (true)` are wide open — any signed-in Supabase user has full read/write access to operational tables (`customers`, `orders`, `units`, `service_tickets`, etc.). The Google OAuth `hd=virgohome.io` query param is a hint, not enforced server-side.
3. **Anonymous storage uploads are unverified.** [`supabase/migrations/20260512110000_service_storage_bucket.sql:35-40`](supabase/migrations/20260512110000_service_storage_bucket.sql#L35-L40) lets any `anon` request upload to `ticket-attachments` as long as the first path segment matches a UUID regex. No check that the UUID corresponds to a real `service_tickets` row. Free-CDN / storage-quota-DOS exposure.

## 2. Goal

Establish server-enforced authorization with one identity check (`profiles.is_internal`) that gates:
- All RLS policies on operational tables.
- All edge-function invocations from authenticated callers.
- All anonymous storage uploads (require a matching customer-form ticket).

Cron-triggered edge functions stay automatable via a shared secret header. Public customer forms (`/return`, `/cancel-order`, `/service-request`) keep working.

## 3. Decisions (locked in during brainstorming)

| Decision | Choice |
|----------|--------|
| Internal-user identity | **`profiles.is_internal boolean`**. New column, backfilled `true` for `@virgohome.io` emails. New signups default `false`; admin flips manually. |
| Edge-function auth | **Shared wrapper in `_shared/auth.ts`**. Every function accepts either an `X-Cron-Secret` header (cron path) or a user JWT + `is_internal` check (operator path). `config.toml` keeps `verify_jwt = false` — auth enforced inside the function so we don't fight the ES256 gateway issue. |
| Storage policy | **Require matching customer_form ticket.** Anon upload check joins `service_tickets` via a `security definer` helper. Time-window deferred. |
| Rollout | **Phased.** 4 sequential commits; each phase reversible independently. |

## 4. Architecture

### 4.1 Identity helper

```sql
alter table public.profiles
  add column if not exists is_internal boolean not null default false;

-- Backfill from auth.users email pattern. One-time at migration apply.
update public.profiles p
   set is_internal = true
  from auth.users u
 where u.id = p.id and lower(u.email) like '%@virgohome.io';

-- Helper used by every RLS policy. SECURITY DEFINER so it can read profiles
-- regardless of caller's RLS context; STABLE so Postgres can cache the
-- per-statement result.
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

### 4.2 RLS rewrite

Sweep every operational table's `using (true)` and `with check (true)` policy. Replace with `using (public.is_internal_user())` / `with check (public.is_internal_user())`.

**Tables in scope** (gated to internal users only):

- `customers`, `orders`, `units`, `units_serial_tracker`
- `service_tickets`, `customer_lifecycle`, `ticket_messages`, `ticket_attachments`, `ticket_classification_log`
- `fulfillment_queue`, `shelf_slots`
- `returns`, `refunds`, `refund_approvals`, `cancellations`, `replacements`
- `factory_orders`, `freight_shipments`, `build_defects`, `build_attachments`, `burn_in_tests`
- `email_templates`, `activity_log`
- `parts`, `parts_inventory`, `parts_shipments`
- `gmail_sync_state`, `remote_postal_prefixes`

**Tables that keep their existing policies** (not rewritten):

- `profiles` — self-read + add an "internal can read all" path.
- Customer-form anon-insert policies on `service_tickets`, `returns`, `cancellations` already scoped `to anon with check (source = 'customer_form')`. Untouched.

**Failure mode:** if a table is missed, it stays at current `using (true)` — degrades to today's behavior, not worse. Detect via a post-deploy audit query that lists any remaining `using (true)` policies on tables in the operational set.

### 4.3 Edge-function auth wrapper

`supabase/functions/_shared/auth.ts`:

```ts
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

export type Caller =
  | { kind: 'cron' }
  | { kind: 'user'; user_id: string; email: string };

// Returns the validated caller. Throws a Response (which the handler can
// return directly) on auth failure — never returns null/undefined so the
// caller can't accidentally proceed unauthenticated.
export async function authenticate(req: Request, admin: SupabaseClient): Promise<Caller> {
  // Cron path: shared-secret header set by pg_cron.invoke_edge_function.
  const cronSecret = Deno.env.get('CRON_SHARED_SECRET');
  const cronHeader = req.headers.get('x-cron-secret');
  if (cronHeader && cronSecret && cronHeader === cronSecret) {
    return { kind: 'cron' };
  }

  // User path: validate JWT and verify is_internal.
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
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    },
  });
}
```

Each of the 8 edge functions gets the same 4-line snippet near the top of `handle()`:

```ts
let caller;
try { caller = await authenticate(req, admin); }
catch (e) { if (e instanceof Response) return e; throw e; }
// caller.kind === 'cron' or 'user' — use as needed for attribution
```

For functions that record who did what (e.g. `send-fulfillment-email` records `email_sent_by`), use `caller.kind === 'user' ? caller.user_id : null`.

### 4.4 pg_cron secret-header injection

The existing helper at [`supabase/migrations/20260512130000_service_pg_cron.sql:10`](supabase/migrations/20260512130000_service_pg_cron.sql#L10) has signature `public.invoke_edge_function(fn_name text, body jsonb default '{}'::jsonb)` and authenticates via `app.supabase_anon_key`. Add the cron secret to its headers:

```sql
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
    -- fallback to baked-in anon key (matches existing migration)
    ''
  );
  cron_secret text := coalesce(current_setting('app.cron_shared_secret', true), '');
begin
  perform net.http_post(
    url := base_url || '/functions/v1/' || fn_name,
    headers := jsonb_build_object(
      'Content-Type',   'application/json',
      'Authorization',  'Bearer ' || anon_key,
      'X-Cron-Secret',  cron_secret
    ),
    body := body
  );
end $$;
```

Preserve the existing baked-in anon-key fallback (reuse the literal from the source migration to avoid divergence). `app.cron_shared_secret` is a Postgres GUC that mirrors the edge-fn env var `CRON_SHARED_SECRET`. Set both atomically during Phase 3:

```sql
alter database postgres set app.cron_shared_secret = '<value>';
```

(Postgres `ALTER DATABASE ... SET` is the right idiom for per-DB GUCs that need to be visible across sessions.)

### 4.5 Storage policy tightening

Replace the loose anon policy:

```sql
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

The public form code already inserts the ticket first, then uploads to `{ticket_id}/...`. No app-side change needed.

## 5. Phased rollout

### Phase 1 — `profiles.is_internal` + helper

- Single migration: schema + backfill + `is_internal_user()` helper.
- **Inert** — nothing reads it yet. Zero blast radius.
- **Verification:** `select email, is_internal from auth.users u join profiles p on p.id = u.id where is_internal = false;` — confirm every active operator is `true` (otherwise they'll lose access in Phase 2).

### Phase 2 — RLS rewrite

- Single migration: sweeping policy rewrite over the operational table set.
- **Breaking phase.** Non-internal sessions immediately lose access. Mitigate via the Phase-1 verification above.
- **Rollback:** revert the migration; previous `using (true)` policies come back.

### Phase 3 — Edge-function auth + cron secret

Order matters within the phase:

1. Set the `CRON_SHARED_SECRET` Supabase secret AND the matching Postgres GUC. **Do this first** — if the function deploy lands before the secret, cron jobs fail.
2. Deploy `_shared/auth.ts` (no-op file by itself).
3. Update `pg_cron`'s `invoke_edge_function` to send the header.
4. Edit + redeploy each of the 8 edge functions with the `authenticate()` wrapper. One at a time, verify each via manual invocation before moving on.

**Rollback per function:** redeploy the prior version (Supabase keeps version history).

### Phase 4 — Storage policy tightening

- Single migration: drop loose anon policy, add `customer_form_ticket_exists` helper + tight anon policy.
- **Pre-test:** confirm the customer-form flow (create ticket → upload attachment) still works on a staging branch. Today's order (insert ticket → upload) preserves the new check.
- **Rollback:** revert; loose policy comes back.

## 6. Out of scope

- **Granular roles** (admin vs staff vs viewer). Just `is_internal` for now.
- **Per-user audit log expansion.** `activity_log` already records most mutations; not touching it.
- **React route gating.** `requireInternalDomain` stays as a UX nicety (cleaner error than RLS rejection); the real gate is now server-side.
- **OAuth `hd` enforcement at Supabase.** Out of scope — RLS now blocks non-internal users regardless of how they signed in.
- **Storage upload time-window.** Deferred. UUIDs aren't predictable and we don't expose them publicly; an `customer_form` row check is sufficient.

## 7. Testing strategy

**Phase 1 — manual:**
```sql
-- Helper returns true for an internal user
set local request.jwt.claims = '{"sub": "<internal-user-uuid>"}';
select public.is_internal_user();  -- expect: t

-- Helper returns false for a non-internal user
set local request.jwt.claims = '{"sub": "<non-internal-user-uuid>"}';
select public.is_internal_user();  -- expect: f
```

**Phase 2 — manual on staging:**
- Sign in as an internal user → can list customers, orders, etc.
- Sign in as a fresh Google account (non-`@virgohome.io`) → all queries return empty (RLS blocks).
- Confirm public customer forms still work (insert succeeds with `source = 'customer_form'`).

**Phase 3 — manual + invocation tests:**
- Invoke an edge function with no auth → 401.
- Invoke with a valid JWT but `is_internal = false` profile → 403.
- Invoke with a valid internal JWT → succeeds.
- Trigger a cron tick manually via `select public.invoke_edge_function('sync-quo-tickets');` → succeeds, X-Cron-Secret path used.
- Invoke with wrong `X-Cron-Secret` and no JWT → 401.

**Phase 4 — manual:**
- Customer-form upload (real flow) → succeeds.
- `curl -X POST` to storage with a random UUID → 403 (no matching ticket).

**Automated regression:** existing 102 vitest tests should keep passing — the React layer is unchanged.

## 8. File touch list

| File | Phase | Action |
|------|-------|--------|
| `supabase/migrations/<ts>_profiles_is_internal.sql` | 1 | New: column + backfill + `is_internal_user()` helper |
| `supabase/migrations/<ts>_rls_internal_only.sql` | 2 | New: sweep all `using (true)` operational policies to `using (is_internal_user())` |
| `supabase/functions/_shared/auth.ts` | 3 | New: `authenticate()` wrapper |
| 8 edge-fn `index.ts` (sync-shopify-orders, send-fulfillment-email, sync-hubspot-customers, send-template-email, sync-calendly-events, sync-hubspot-tickets, push-shopify-fulfillments, verify-address) | 3 | Edit: 4-line auth check at top of `handle()` |
| `supabase/migrations/<ts>_cron_secret_header.sql` | 3 | New: update `invoke_edge_function()` to send `X-Cron-Secret` |
| Supabase secret `CRON_SHARED_SECRET` + Postgres GUC `app.cron_shared_secret` | 3 | Manual: set before deploying the cron-helper migration |
| `supabase/migrations/<ts>_storage_ticket_form_check.sql` | 4 | New: `customer_form_ticket_exists()` + tightened anon policy |

Total: 4 migrations, 1 new shared file, 8 edge-fn edits, 1 manual secret-set step. No frontend changes.

## 9. Open questions

None. All decisions locked in during brainstorming.
