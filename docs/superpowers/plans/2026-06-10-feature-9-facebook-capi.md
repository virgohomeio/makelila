# Feature 9: Facebook Conversions API (CAPI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send server-side conversion events to Facebook's Conversions API (CAPI) when key makelila milestones happen — order fulfilled, return submitted — so Facebook can attribute conversions that iOS 14.5+ ATT blocking would otherwise miss. Events fire from the `klaviyo-track` edge function or a new dedicated `facebook-capi` edge function called from the same `logAction` hook extended in Feature 1.

**Architecture:** New `supabase/functions/facebook-capi/index.ts` posts Purchase and Refund events to `https://graph.facebook.com/v19.0/{pixel_id}/events`. Called server-side (not from the browser) so no client-side pixel code is needed. The function receives event data from `logAction`'s `opts.facebookEvent` extension (same pattern as `opts.klaviyoEvent` from Feature 1). Hashing (SHA-256 of email/phone/name) happens inside the edge function.

**Dependency:** Feature 1 (klaviyo-track / logAction extension) must ship first — the `opts` parameter on `logAction` is already established.

**Tech Stack:** Supabase Edge Functions (Deno), Crypto Web API (built-in), Facebook Graph API v19.0, Vitest

---

## File Map

| File | Change |
|------|--------|
| `supabase/functions/facebook-capi/index.ts` | Create |
| `app/src/lib/activityLog.ts` | Modify — add `facebookEvent` to `opts` |
| `app/src/lib/activityLog.test.ts` | Modify — add 2 tests for facebook-capi invocation |

---

### Task 1: `facebook-capi` edge function

**Files:**
- Create: `supabase/functions/facebook-capi/index.ts`

The function accepts a POST body with:
```json
{
  "event_name": "Purchase",
  "event_time": 1717776000,
  "email": "user@example.com",
  "phone": "+16135551234",
  "value": 1396.00,
  "currency": "CAD",
  "order_id": "ord-abc123",
  "event_id": "evt-uuid-for-dedup"
}
```

It SHA-256-hashes the PII fields before sending to Facebook.

- [ ] **Step 1: Create the function**

```ts
// supabase/functions/facebook-capi/index.ts
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const PIXEL_ID  = Deno.env.get('FACEBOOK_PIXEL_ID') ?? '';
const FB_TOKEN  = Deno.env.get('FACEBOOK_SYSTEM_USER_TOKEN') ?? '';
const API_VER   = 'v19.0';
const TEST_CODE = Deno.env.get('FACEBOOK_TEST_EVENT_CODE') ?? ''; // for Pixel Helper testing

type CAPIPayload = {
  event_name: string;
  event_time: number;
  email?: string;
  phone?: string;
  name?: string;
  value?: number;
  currency?: string;
  order_id?: string;
  event_id?: string;
};

async function sha256(value: string): Promise<string> {
  const normalized = value.trim().toLowerCase();
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(normalized),
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const authError = await authenticate(req);
  if (authError) return authError;

  const body = await req.json() as CAPIPayload;

  // Build user_data with hashed PII
  const userData: Record<string, string> = {};
  if (body.email) userData['em'] = await sha256(body.email);
  if (body.phone) userData['ph'] = await sha256(body.phone.replace(/\D/g, ''));
  if (body.name) {
    const parts = body.name.trim().split(' ');
    if (parts[0]) userData['fn'] = await sha256(parts[0]);
    if (parts.length > 1) userData['ln'] = await sha256(parts.slice(1).join(' '));
  }

  const event: Record<string, unknown> = {
    event_name:  body.event_name,
    event_time:  body.event_time,
    action_source: 'system_generated',
    user_data:   userData,
    event_id:    body.event_id,
  };

  if (body.value != null && body.currency) {
    event['custom_data'] = {
      value:    body.value.toFixed(2),
      currency: body.currency.toUpperCase(),
      order_id: body.order_id,
    };
  }

  const url = new URL(`https://graph.facebook.com/${API_VER}/${PIXEL_ID}/events`);
  url.searchParams.set('access_token', FB_TOKEN);

  const fbBody: Record<string, unknown> = { data: [event] };
  if (TEST_CODE) fbBody['test_event_code'] = TEST_CODE;

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fbBody),
  });

  const result = await res.json();

  if (!res.ok) {
    console.error('Facebook CAPI error:', JSON.stringify(result));
    return new Response(JSON.stringify({ error: result }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify(result), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
```

- [ ] **Step 2: Deploy**

```bash
cd app
./node_modules/.bin/supabase functions deploy facebook-capi --project-ref txeftbbzeflequvrmjjr
```

- [ ] **Step 3: Set environment variable**

```bash
./node_modules/.bin/supabase secrets set FACEBOOK_PIXEL_ID=... --project-ref txeftbbzeflequvrmjjr
# FACEBOOK_SYSTEM_USER_TOKEN already set in Feature 7
# For testing:
./node_modules/.bin/supabase secrets set FACEBOOK_TEST_EVENT_CODE=TEST12345 --project-ref txeftbbzeflequvrmjjr
```

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/facebook-capi/index.ts
git commit -m "feat(edge): add facebook-capi edge function for server-side conversion events"
```

---

### Task 2: Wire `logAction` to fire facebook-capi events

**Files:**
- Modify: `app/src/lib/activityLog.ts`
- Modify (or create): `app/src/lib/activityLog.test.ts`

- [ ] **Step 1: Read current `activityLog.ts`**

```bash
cat app/src/lib/activityLog.ts
```

Find the current `opts` type (it should already have `klaviyoEvent?: string` from Feature 1). Note the exact pattern for invoking the edge function.

- [ ] **Step 2: Read the tests file**

```bash
cat app/src/lib/activityLog.test.ts
```

Note the existing mock setup for `supabase.functions.invoke`.

- [ ] **Step 3: Write the new tests**

Add to the test file after the existing Klaviyo tests:

```ts
describe('logAction — facebookEvent', () => {
  it('invokes facebook-capi when opts.facebookEvent is provided', async () => {
    invokeMock.mockResolvedValueOnce({ data: { events_received: 1 }, error: null });

    await logAction('order_fulfilled', 'customer@example.com', 'order shipped', undefined, {
      facebookEvent: {
        event_name: 'Purchase',
        event_time: 1717776000,
        email: 'customer@example.com',
        value: 1396,
        currency: 'CAD',
        order_id: 'ord-1',
        event_id: 'evt-1',
      },
    });

    expect(invokeMock).toHaveBeenCalledWith(
      'facebook-capi',
      expect.objectContaining({
        body: expect.objectContaining({ event_name: 'Purchase' }),
      }),
    );
  });

  it('does not invoke facebook-capi when facebookEvent is absent', async () => {
    invokeMock.mockClear();
    await logAction('order_created', 'customer@example.com', 'new order');
    const capiCalls = invokeMock.mock.calls.filter(c => c[0] === 'facebook-capi');
    expect(capiCalls).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run — expect failure**

```bash
npm test -- activityLog
```
Expected: FAIL (facebookEvent not yet on opts type).

- [ ] **Step 5: Extend `activityLog.ts`**

Find the `opts` parameter type in `logAction`. Add `facebookEvent` field:

```ts
opts?: {
  klaviyoEvent?: string;
  facebookEvent?: {
    event_name: string;
    event_time: number;
    email?: string;
    phone?: string;
    name?: string;
    value?: number;
    currency?: string;
    order_id?: string;
    event_id?: string;
  };
}
```

In the function body, after the klaviyo fire-and-forget block, add:

```ts
if (opts?.facebookEvent) {
  void supabase.functions.invoke('facebook-capi', { body: opts.facebookEvent })
    .catch((e: unknown) => console.error('facebook-capi fire-and-forget failed', e));
}
```

- [ ] **Step 6: Run tests — expect pass**

```bash
npm test -- activityLog
```
Expected: all tests pass.

- [ ] **Step 7: Wire call sites**

Add `facebookEvent` to two key call sites:

**In `lib/fulfillment.ts`** — when order status changes to `fulfilled`:

```ts
await logAction('order_fulfilled', order.customer_email ?? order.id, 'status → fulfilled', {
  entityType: 'order', entityId: order.id,
}, {
  klaviyoEvent: 'Order Fulfilled',
  facebookEvent: {
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    email: order.customer_email ?? undefined,
    value: order.total_usd ?? undefined,
    currency: order.currency ?? 'CAD',
    order_id: order.id,
    event_id: `purchase-${order.id}`,
  },
});
```

**In `lib/postShipment.ts`** — when a return is submitted:

```ts
await logAction('return_submitted', order.customer_email ?? order.id, 'return filed', {
  entityType: 'order', entityId: order.id,
}, {
  facebookEvent: {
    event_name: 'StartTrial',  // closest standard event for return/refund initiation
    event_time: Math.floor(Date.now() / 1000),
    email: order.customer_email ?? undefined,
    order_id: order.id,
    event_id: `return-${order.id}`,
  },
});
```

- [ ] **Step 8: Run full test suite**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add app/src/lib/activityLog.ts app/src/lib/activityLog.test.ts \
        app/src/lib/fulfillment.ts app/src/lib/postShipment.ts
git commit -m "feat(CAPI): wire facebook-capi events from order_fulfilled and return_submitted"
```
