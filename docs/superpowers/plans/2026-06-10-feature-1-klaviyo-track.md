# Feature 1: Klaviyo Track API Event Firehose

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `logAction()` to mirror selected operator actions to Klaviyo's Track API so marketing lifecycle flows receive server-side event signals without scattering Klaviyo SDK calls across modules.

**Architecture:** Extend `logAction()` with an optional `opts.klaviyoEvent` string; when present, fire-and-forget POST to a new `klaviyo-track` Deno edge function that resolves/creates the Klaviyo profile and records the event. A `customers.klaviyo_profile_id` column caches the resolved ID. Eight existing call sites get the new opt-in.

**Tech Stack:** React 18 + TypeScript, Supabase (Postgres + Edge Functions Deno runtime), Klaviyo Track API v2024-10-15, Vitest

---

## File Map

| File | Change |
|------|--------|
| `app/supabase/migrations/20260610120000_klaviyo_profile_id.sql` | Create — add `klaviyo_profile_id` column + index |
| `app/src/lib/activityLog.ts` | Modify — extend `logAction` signature with `opts` |
| `app/src/lib/activityLog.test.ts` | Modify — add three new test cases |
| `supabase/functions/klaviyo-track/index.ts` | Create — edge function |
| `app/src/lib/fulfillment.ts` | Modify — wire `unit_shipped` event at `markFulfilled` |
| `app/src/lib/postShipment.ts` | Modify — wire `unit_delivered`, `replacement_shipped`, `refund_approved` |
| `app/src/lib/service.ts` | Modify — wire `service_ticket_opened`, `service_ticket_resolved` |
| `app/src/lib/customers.ts` | Modify — wire `journey_stage_changed` at `setJourneyStageOverride` |
| `app/src/lib/dashboard.ts` | Modify — wire `telemetry_status_changed` at mixing-status writer |

---

### Task 1: Schema migration — add `klaviyo_profile_id`

**Files:**
- Create: `app/supabase/migrations/20260610120000_klaviyo_profile_id.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Caches the Klaviyo profile ID resolved by the klaviyo-track edge function.
-- Written by the edge function (service-role only); never written by client JS.
ALTER TABLE customers
  ADD COLUMN klaviyo_profile_id text NULL;

CREATE INDEX idx_customers_klaviyo_profile_id
  ON customers(klaviyo_profile_id)
  WHERE klaviyo_profile_id IS NOT NULL;
```

- [ ] **Step 2: Apply to remote**

```bash
cd app
./node_modules/.bin/supabase db push --linked
```
Expected: migration applied, no errors.

- [ ] **Step 3: Verify column exists**

```bash
./node_modules/.bin/supabase db remote commit
```
Or confirm in Supabase dashboard → Table Editor → customers → columns list shows `klaviyo_profile_id`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260610120000_klaviyo_profile_id.sql
git commit -m "feat(db): add customers.klaviyo_profile_id for Klaviyo Track integration"
```

---

### Task 2: Extend `logAction` with `opts.klaviyoEvent`

**Files:**
- Modify: `app/src/lib/activityLog.ts`
- Modify: `app/src/lib/activityLog.test.ts`

The current signature is:
```ts
export async function logAction(
  type: string,
  entity: string,
  detail: string = '',
  refs?: { entityType?: EntityType; entityId?: string; unitSerial?: string },
): Promise<void>
```

- [ ] **Step 1: Write the failing tests first**

Add to `app/src/lib/activityLog.test.ts` after the existing `describe('logAction')` block — add a `fetchMock` to the hoisted section and three new cases:

```ts
// At the top of the file, inside vi.hoisted(), add fetchMock:
const { insertMock, fromMock, getUserMock, fetchMock } = vi.hoisted(() => {
  const insertMock = vi.fn();
  const fromMock = vi.fn(() => ({ insert: insertMock }));
  const getUserMock = vi.fn<() => Promise<{ data: { user: { id: string } | null } }>>(
    () => Promise.resolve({ data: { user: { id: 'user-1' } } }),
  );
  const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
  return { insertMock, fromMock, getUserMock, fetchMock };
});

// Also mock global fetch inside the vi.mock('./supabase') block — add after supabase mock:
vi.stubGlobal('fetch', fetchMock);
```

Then add these test cases inside the existing `describe('logAction', ...)`:

```ts
it('does NOT call fetch when opts.klaviyoEvent is absent', async () => {
  fetchMock.mockClear();
  await logAction('order_approve', 'Test Order', '#ORD-0001');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('calls fetch with klaviyoEvent payload when opts.klaviyoEvent is set', async () => {
  fetchMock.mockClear();
  await logAction('order_shipped', 'customer@example.com', 'ORD-001', undefined, {
    klaviyoEvent: 'unit_shipped',
  });
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toContain('klaviyo-track');
  const body = JSON.parse(init.body as string) as Record<string, unknown>;
  expect(body.event).toBe('unit_shipped');
});

it('does not throw when fetch rejects (fire-and-forget)', async () => {
  fetchMock.mockRejectedValueOnce(new Error('network'));
  await expect(
    logAction('order_shipped', 'customer@example.com', 'ORD-001', undefined, {
      klaviyoEvent: 'unit_shipped',
    }),
  ).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd app
npm test -- activityLog
```
Expected: 3 new tests fail ("opts is not a valid parameter" / "fetchMock not called").

- [ ] **Step 3: Update `logAction` signature and implementation**

Replace the existing `logAction` function in `app/src/lib/activityLog.ts`:

```ts
export async function logAction(
  type: string,
  entity: string,
  detail: string = '',
  refs?: {
    entityType?: EntityType;
    entityId?: string;
    unitSerial?: string;
  },
  opts?: {
    klaviyoEvent?: string;
  },
): Promise<void> {
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) throw new Error('logAction: not authenticated');

  const { error } = await supabase.from('activity_log').insert({
    user_id: user.id,
    type,
    entity,
    detail,
    entity_type: refs?.entityType ?? null,
    entity_id: refs?.entityId ?? null,
    unit_serial: refs?.unitSerial ?? null,
  });
  if (error) throw error;

  if (opts?.klaviyoEvent) {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
    if (supabaseUrl && anonKey) {
      // Fire-and-forget — never block the operator UI on a marketing API call.
      void fetch(`${supabaseUrl}/functions/v1/klaviyo-track`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${anonKey}`,
        },
        body: JSON.stringify({
          event: opts.klaviyoEvent,
          email: entity,        // caller passes customer email as `entity`
          activity_log_id: undefined, // resolved server-side
        }),
      }).catch(() => {
        // Intentionally swallowed — Klaviyo outage must never block operator mutations.
      });
    }
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npm test -- activityLog
```
Expected: all existing + 3 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/activityLog.ts app/src/lib/activityLog.test.ts
git commit -m "feat(activityLog): extend logAction with opts.klaviyoEvent fire-and-forget"
```

---

### Task 3: Create `klaviyo-track` edge function

**Files:**
- Create: `supabase/functions/klaviyo-track/index.ts`

- [ ] **Step 1: Create the function file**

```ts
// klaviyo-track: receives { event, email, properties? } from logAction's
// fire-and-forget caller. Resolves (or creates) the Klaviyo profile, writes
// the profile_id back to customers.klaviyo_profile_id if absent, then
// records the event via the Track API.
//
// This function accepts both cron-secret and operator JWT (both internal
// paths) so the fire-and-forget fetch in logAction can pass the anon JWT.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';

const KLAVIYO_API_VERSION = '2024-10-15';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  try { return await handle(req); }
  catch (err) {
    return new Response(
      JSON.stringify({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }
});

type Input = {
  event: string;
  email: string;
  properties?: Record<string, unknown>;
};

async function handle(req: Request): Promise<Response> {
  const privateKey = Deno.env.get('KLAVIYO_PRIVATE_API_KEY');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!privateKey || !supabaseUrl || !serviceKey) {
    return j({ error: 'Missing KLAVIYO_PRIVATE_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500);
  }

  const body = await req.json() as Input;
  if (!body.event || !body.email) return j({ error: 'event and email are required' }, 400);

  const admin = createClient(supabaseUrl, serviceKey);

  // 1. Resolve or create the Klaviyo profile.
  const profileId = await resolveKlaviyoProfile(body.email, privateKey, admin);
  if (!profileId) return j({ error: 'Failed to resolve Klaviyo profile' }, 502);

  // 2. Record the event.
  const eventRes = await fetch('https://a.klaviyo.com/api/events/', {
    method: 'POST',
    headers: klaviyoHeaders(privateKey),
    body: JSON.stringify({
      data: {
        type: 'event',
        attributes: {
          metric: { data: { type: 'metric', attributes: { name: body.event } } },
          profile: { data: { type: 'profile', id: profileId } },
          properties: body.properties ?? {},
        },
      },
    }),
  });
  if (!eventRes.ok) {
    const txt = await eventRes.text();
    return j({ error: `Klaviyo events API ${eventRes.status}: ${txt}` }, 502);
  }

  return j({ ok: true, profile_id: profileId });
}

async function resolveKlaviyoProfile(
  email: string,
  privateKey: string,
  admin: ReturnType<typeof createClient>,
): Promise<string | null> {
  // Check if already cached in customers table.
  const { data: customer } = await admin
    .from('customers')
    .select('id, klaviyo_profile_id')
    .eq('email', email.toLowerCase())
    .maybeSingle();

  if (customer?.klaviyo_profile_id) return customer.klaviyo_profile_id;

  // Upsert the profile in Klaviyo.
  const res = await fetch('https://a.klaviyo.com/api/profiles/', {
    method: 'POST',
    headers: klaviyoHeaders(privateKey),
    body: JSON.stringify({
      data: {
        type: 'profile',
        attributes: { email: email.toLowerCase() },
      },
    }),
  });

  // 201 = created, 409 = already exists (body has the existing ID).
  if (!res.ok && res.status !== 409) return null;
  const json = await res.json() as { data?: { id?: string }; errors?: Array<{ meta?: { duplicate_profile_id?: string } }> };

  const profileId =
    json.data?.id ??
    json.errors?.[0]?.meta?.duplicate_profile_id ??
    null;
  if (!profileId) return null;

  // Write back to customers table if we have a matching row.
  if (customer?.id) {
    await admin
      .from('customers')
      .update({ klaviyo_profile_id: profileId })
      .eq('id', customer.id);
  }

  return profileId;
}

function klaviyoHeaders(privateKey: string) {
  return {
    'Authorization': `Klaviyo-API-Key ${privateKey}`,
    'revision': KLAVIYO_API_VERSION,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
```

- [ ] **Step 2: Deploy the function**

```bash
cd app
./node_modules/.bin/supabase functions deploy klaviyo-track --project-ref txeftbbzeflequvrmjjr
```
Expected: "Deployed function klaviyo-track".

- [ ] **Step 3: Set the secret (if not already set)**

```bash
./node_modules/.bin/supabase secrets set KLAVIYO_PRIVATE_API_KEY=<your-private-key> --project-ref txeftbbzeflequvrmjjr
```
Expected: "Saved 1 secret."

- [ ] **Step 4: Smoke-test the function**

```bash
./node_modules/.bin/supabase functions invoke klaviyo-track \
  --project-ref txeftbbzeflequvrmjjr \
  --body '{"event":"test_ping","email":"huayi@virgohome.io"}'
```
Expected: `{ "ok": true, "profile_id": "..." }`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/klaviyo-track/index.ts
git commit -m "feat(edge): add klaviyo-track edge function for Track API firehose"
```

---

### Task 4: Wire 8 call sites

**Files:**
- Modify: `app/src/lib/fulfillment.ts` — `markFulfilled`
- Modify: `app/src/lib/postShipment.ts` — delivery webhook, `shipReplacement`, `approveRefund`
- Modify: `app/src/lib/service.ts` — `createTicket`, `resolveTicket`
- Modify: `app/src/lib/customers.ts` — `setJourneyStageOverride`
- Modify: `app/src/lib/dashboard.ts` — mixing-status writer

**Pattern:** In each function, after the existing `logAction(...)` call, append `undefined, { klaviyoEvent: '<event_name>' }` to the same call — OR if the function has the customer email available, ensure it's passed as the `entity` arg and add the opts.

For each file, search for the existing `logAction(` call and extend it. The `entity` argument must be the customer's email for the edge function to resolve the profile. Where the current call doesn't have the email, pass it as a separate `logAction` call with just the Klaviyo opt (the edge function will look up the profile via the customers table).

- [ ] **Step 1: Wire `unit_shipped` in `lib/fulfillment.ts`**

Find the `markFulfilled` function. Locate its `logAction(` call. Extend it:

```ts
// Before (example — match the actual args in the file):
await logAction('unit_shipped', customerEmail, orderId);

// After:
await logAction('unit_shipped', customerEmail, orderId, undefined, { klaviyoEvent: 'unit_shipped' });
```

If the function doesn't pass `customerEmail` as entity, find where `customer_email` is available in scope and add a separate fire after the existing logAction:

```ts
if (customerEmail) {
  void (async () => {
    await logAction('unit_shipped', customerEmail, orderId, undefined, { klaviyoEvent: 'unit_shipped' });
  })();
}
```

- [ ] **Step 2: Wire `unit_delivered` in `lib/postShipment.ts`**

Same pattern. Find the delivery-webhook handler or `markDelivered` function and extend or add:

```ts
await logAction('unit_delivered', customerEmail, orderId, undefined, { klaviyoEvent: 'unit_delivered' });
```

- [ ] **Step 3: Wire `replacement_shipped` in `lib/postShipment.ts`**

Find `shipReplacement`. Extend the logAction call:

```ts
await logAction('replacement_shipped', customerEmail, replacementOrderId, undefined, { klaviyoEvent: 'replacement_shipped' });
```

- [ ] **Step 4: Wire `refund_approved` in `lib/postShipment.ts`**

Find `approveRefund`. Extend the logAction call:

```ts
await logAction('refund_approved', customerEmail, refundId, undefined, { klaviyoEvent: 'refund_approved' });
```

- [ ] **Step 5: Wire `service_ticket_opened` in `lib/service.ts`**

Find `createTicket`. Extend:

```ts
await logAction('service_ticket_opened', customerEmail ?? ticketId, ticketId, undefined, { klaviyoEvent: 'service_ticket_opened' });
```

- [ ] **Step 6: Wire `service_ticket_resolved` in `lib/service.ts`**

Find `resolveTicket` or wherever `ticket_status_changed` is logged for a resolved state. Extend:

```ts
await logAction('service_ticket_resolved', customerEmail ?? ticketId, ticketId, undefined, { klaviyoEvent: 'service_ticket_resolved' });
```

- [ ] **Step 7: Wire `journey_stage_changed` in `lib/customers.ts`**

Find `setJourneyStageOverride`. Extend:

```ts
await logAction('journey_stage_changed', customer.email ?? customerId, customerId, undefined, { klaviyoEvent: 'journey_stage_changed' });
```

- [ ] **Step 8: Wire `telemetry_status_changed` in `lib/dashboard.ts`**

Find the mixing-status writer — the function that records a machine's status change. Extend:

```ts
await logAction('telemetry_status_changed', customerEmail ?? serial, serial, undefined, { klaviyoEvent: 'telemetry_status_changed' });
```

- [ ] **Step 9: Run full test suite**

```bash
cd app
npm test
```
Expected: all tests pass (the new `opts` param is additive; all existing tests still pass).

- [ ] **Step 10: Commit**

```bash
git add app/src/lib/fulfillment.ts app/src/lib/postShipment.ts app/src/lib/service.ts app/src/lib/customers.ts app/src/lib/dashboard.ts
git commit -m "feat(klaviyo): wire 8 logAction call sites with klaviyoEvent opt"
```

---

### Task 5: End-to-end validation

- [ ] **Step 1: Ship a test order through Fulfillment**

In the dev app (`npm run dev`), navigate to Fulfillment, assign a serial, walk through QC steps, and mark fulfilled.

- [ ] **Step 2: Verify Klaviyo event**

Open Klaviyo dashboard → Profiles → search by the customer email → Activity tab → confirm `unit_shipped` event appears within 60 seconds.

- [ ] **Step 3: Verify `klaviyo_profile_id` populated**

```bash
./node_modules/.bin/supabase db remote commit
```
Or in Supabase Table Editor: `SELECT email, klaviyo_profile_id FROM customers WHERE email = 'customer@test.com'` — confirm `klaviyo_profile_id` is not null.

- [ ] **Step 4: Verify fire-and-forget doesn't block UI**

With `KLAVIYO_PRIVATE_API_KEY` unset (or wrong), run the same fulfillment flow. Confirm the UI completes normally with no error toast.
