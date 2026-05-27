# Google Maps Address Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Spec: `docs/superpowers/specs/2026-05-27-address-verification-design.md`.

**Goal:** On-demand address verification against Google Maps Geocoding API. Postal-only mismatch detection. Flag-and-send email on mismatch.

**Architecture:** New edge function `verify-address` (server-side Google API call); new schema columns on `orders`; new `verifyAddress` mutation; AddressCard UI extensions.

**Tech Stack:** Supabase Edge Function (Deno) + Postgres + React + Resend (for the mismatch email, via existing send-template-email function).

---

### Task 1: Schema migration

**Files:** Create `supabase/migrations/20260527150000_address_verification.sql`

- [ ] **Step 1: Write the migration**

```sql
alter table public.orders
  add column address_verified_at      timestamptz,
  add column address_match            text
    check (address_match in ('match','mismatch','unverifiable')),
  add column address_google_formatted text,
  add column address_google_postal    text,
  add column address_customer_postal  text;
```

- [ ] **Step 2: Apply via MCP**

Use `mcp__claude_ai_Supabase__apply_migration` with name `address_verification`.

- [ ] **Step 3: Verify**

```sql
select column_name from information_schema.columns
 where table_schema='public' and table_name='orders'
   and column_name like 'address_%';
```
Expected: 7 rows (existing `address_line`, `address_verdict` + 5 new).

- [ ] **Step 4: Commit**

```powershell
cd e:/Claude/makelila
git add supabase/migrations/20260527150000_address_verification.sql
git commit -m @'
feat(orders): schema for Google Maps address verification

Adds 5 nullable columns capturing the verification verdict, customer-
vs-Google postal comparison, and Google's normalized formatted address.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 2: `verify-address` edge function

**Files:** Create `supabase/functions/verify-address/index.ts`

- [ ] **Step 1: Write the function**

```typescript
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';

type VerifyInput = { order_id: string };

type GoogleAddrComponent = {
  long_name: string;
  short_name: string;
  types: string[];
};

type GoogleResult = {
  formatted_address: string;
  address_components: GoogleAddrComponent[];
};

type GoogleResponse = {
  status: string;
  results: GoogleResult[];
  error_message?: string;
};

function normalizePostal(p: string | null | undefined, country: 'US' | 'CA' | string): string | null {
  if (!p) return null;
  const s = p.replace(/[\s-]/g, '').toUpperCase();
  if (country === 'US') {
    // US ZIP+4 → trim to 5 digits
    const m = s.match(/^(\d{5})\d{0,4}$/);
    return m ? m[1] : null;
  }
  if (country === 'CA') {
    // CA postal: 6 alphanumeric, alternating
    return /^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(s) ? s : null;
  }
  return s;
}

function parseCustomerPostal(addressLine: string | null, country: 'US' | 'CA' | string): string | null {
  if (!addressLine) return null;
  if (country === 'US') {
    const m = addressLine.match(/\b(\d{5})(-\d{4})?\b/);
    return m ? m[1] : null;
  }
  if (country === 'CA') {
    const m = addressLine.match(/\b([A-Za-z]\d[A-Za-z])[ -]?(\d[A-Za-z]\d)\b/);
    return m ? (m[1] + m[2]).toUpperCase() : null;
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const apiKey      = Deno.env.get('GOOGLE_MAPS_API_KEY');
  if (!supabaseUrl || !serviceKey) {
    return j({ error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' }, 500);
  }
  if (!apiKey) {
    return j({ error: 'GOOGLE_MAPS_API_KEY not configured. Set it via supabase secrets set.' }, 500);
  }

  const { order_id } = (await req.json()) as VerifyInput;
  if (!order_id) return j({ error: 'order_id required' }, 400);

  const admin = createClient(supabaseUrl, serviceKey);

  // 1. Fetch order
  const { data: order, error: oErr } = await admin
    .from('orders')
    .select('id, address_line, city, region_state, country, status')
    .eq('id', order_id)
    .single();
  if (oErr || !order) return j({ error: `Order not found: ${oErr?.message}` }, 404);

  // 2. Build query
  const query = [order.address_line, order.city, order.region_state, order.country]
    .filter(Boolean).join(', ');
  if (!query) return j({ error: 'Order has no address to verify' }, 400);

  // 3. Call Google Maps
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${apiKey}`;
  const gRes = await fetch(url);
  if (!gRes.ok) {
    const body = await gRes.text();
    return j({ error: `Google ${gRes.status}: ${body.slice(0, 400)}` }, 502);
  }
  const gJson = (await gRes.json()) as GoogleResponse;
  if (gJson.status !== 'OK' || gJson.results.length === 0) {
    // Record unverifiable verdict
    await admin.from('orders').update({
      address_verified_at: new Date().toISOString(),
      address_match: 'unverifiable',
      address_google_formatted: null,
      address_google_postal: null,
      address_customer_postal: parseCustomerPostal(order.address_line, order.country),
    }).eq('id', order_id);
    return j({
      match: 'unverifiable',
      customer_postal: parseCustomerPostal(order.address_line, order.country),
      google_postal: null,
      google_formatted: null,
      google_status: gJson.status,
    });
  }

  // 4. Extract postal from Google result
  const top = gJson.results[0];
  const postalComp = top.address_components.find(c => c.types.includes('postal_code'));
  const googlePostalRaw = postalComp?.short_name ?? null;
  const googlePostal = normalizePostal(googlePostalRaw, order.country);
  const customerPostal = normalizePostal(parseCustomerPostal(order.address_line, order.country), order.country);

  // 5. Determine match
  let match: 'match' | 'mismatch' | 'unverifiable';
  if (!googlePostal || !customerPostal) match = 'unverifiable';
  else if (googlePostal === customerPostal) match = 'match';
  else match = 'mismatch';

  // 6. Write back
  const patch: Record<string, unknown> = {
    address_verified_at: new Date().toISOString(),
    address_match: match,
    address_google_formatted: top.formatted_address,
    address_google_postal: googlePostalRaw,
    address_customer_postal: customerPostal,
  };
  if (match === 'mismatch' && order.status !== 'flagged') {
    patch.status = 'flagged';
  }
  const { error: upErr } = await admin.from('orders').update(patch).eq('id', order_id);
  if (upErr) return j({ error: `DB update failed: ${upErr.message}` }, 500);

  return j({
    match,
    customer_postal: customerPostal,
    google_postal: googlePostalRaw,
    google_formatted: top.formatted_address,
  });
});

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
```

- [ ] **Step 2: Deploy via MCP**

Use `mcp__claude_ai_Supabase__deploy_edge_function`:
- `project_id`: `txeftbbzeflequvrmjjr`
- `name`: `verify-address`
- `entrypoint_path`: `index.ts`
- `verify_jwt`: `false` (matches the project's pattern for other edge fns; uses service role internally)
- `files`: array with `index.ts` (the above content) and `../_shared/cors.ts` (copy from the existing path)

- [ ] **Step 3: Smoke test deployment**

Confirm the function is listed as ACTIVE via:
```typescript
mcp__claude_ai_Supabase__list_edge_functions({ project_id: 'txeftbbzeflequvrmjjr' })
```

Don't invoke it — it'll fail because the API key isn't set yet. That's expected; Huayi sets the key after the feature ships.

- [ ] **Step 4: Commit**

```powershell
cd e:/Claude/makelila
git add supabase/functions/verify-address/index.ts
git commit -m @'
feat(orders): verify-address edge function for Google Maps geocoding

On-demand address verification. Parses customer postal from address_line,
calls Google Geocoding, compares postals strictly. Sets address_match
to match/mismatch/unverifiable and flags the order on mismatch.

Requires GOOGLE_MAPS_API_KEY secret (set separately via supabase secrets set).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 3: lib/orders.ts — type extension + verifyAddress mutation

**Files:** Modify `app/src/lib/orders.ts`

- [ ] **Step 1: Extend `Order` type**

Find the `Order` type (~line 24). Add these 5 fields after `address_verdict` (line 36):

```typescript
  address_verified_at: string | null;
  address_match: 'match' | 'mismatch' | 'unverifiable' | null;
  address_google_formatted: string | null;
  address_google_postal: string | null;
  address_customer_postal: string | null;
```

- [ ] **Step 2: Add the mutation**

Find a sensible location for mutations in `orders.ts` (look for `setSalesConfirmedFit` — add nearby). Add:

```typescript
export type VerifyAddressResult = {
  match: 'match' | 'mismatch' | 'unverifiable';
  customer_postal: string | null;
  google_postal: string | null;
  google_formatted: string | null;
};

export async function verifyAddress(orderId: string): Promise<VerifyAddressResult> {
  const { data, error } = await supabase.functions.invoke<VerifyAddressResult>(
    'verify-address',
    { body: { order_id: orderId } },
  );
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Empty response from verify-address');
  await logAction('address_verified', orderId, data.match);
  return data;
}
```

Make sure `logAction` is already imported at the top — likely is.

- [ ] **Step 3: Fix test fixtures**

Run `cd app && npm test -- --run`. If any existing `Order` fixtures are missing the new fields, add them as `null`. Check:
- `app/src/modules/OrderReview/__tests__/Detail.test.tsx`
- `app/src/modules/OrderReview/__tests__/Sidebar.test.tsx`

- [ ] **Step 4: Build**

`cd app && npm run build` — must be clean.

- [ ] **Step 5: Commit**

```powershell
cd e:/Claude/makelila
git add app/src/lib/orders.ts app/src/modules/OrderReview/__tests__
git commit -m @'
feat(orders): verifyAddress mutation + type fields for verification verdict

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 4: AddressCard — verify button + badge + mismatch send

**Files:** Modify `app/src/modules/OrderReview/detail/AddressCard.tsx`

- [ ] **Step 1: Read the current file end-to-end**

Already inspected — there's a `verdict` block + a `salesConfirmToggle`. Add new pieces BELOW these.

- [ ] **Step 2: Add the verification UI**

Add these imports at the top:

```typescript
import { useState } from 'react';
import { verifyAddress } from '../../../lib/orders';
import { sendTemplate } from '../../../lib/templates';
```

Inside the `AddressCard` component, add state + handlers:

```typescript
const [busy, setBusy] = useState(false);
const [msg, setMsg] = useState<string | null>(null);

const runVerify = async () => {
  setBusy(true); setMsg(null);
  try {
    const r = await verifyAddress(order.id);
    setMsg(r.match === 'match' ? 'Address verified.' : r.match === 'mismatch' ? 'Postal code mismatch — see below.' : 'Could not verify.');
  } catch (e) {
    setMsg(`Error: ${(e as Error).message}`);
  } finally {
    setBusy(false);
  }
};

const sendMismatchEmail = async () => {
  if (!order.customer_email) { setMsg('No customer email on file.'); return; }
  setBusy(true); setMsg(null);
  try {
    const r = await sendTemplate({
      template_key: 'address_mismatch',
      to: order.customer_email,
      to_name: order.customer_name,
      variables: {
        customer_first_name: order.customer_name.split(' ')[0],
        customer_address:    order.address_line ?? '',
        google_address:      order.address_google_formatted ?? '',
        order_ref:           order.order_ref,
      },
    });
    setMsg(`✓ Email sent (id ${r.message_id})`);
  } catch (e) {
    setMsg(`Send failed: ${(e as Error).message}`);
  } finally {
    setBusy(false);
  }
};
```

Insert the JSX BELOW the existing verdict block (after the salesConfirmToggle, before the closing `</div>` of `cardBody`):

```tsx
<div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
    <button
      onClick={() => void runVerify()}
      disabled={busy}
      style={{
        padding: '6px 12px', fontSize: 11, fontWeight: 600,
        background: order.address_verified_at ? '#fff' : 'var(--color-crimson)',
        color: order.address_verified_at ? 'var(--color-ink-muted)' : '#fff',
        border: '1px solid ' + (order.address_verified_at ? 'var(--color-border)' : 'var(--color-crimson)'),
        borderRadius: 'var(--radius-sm)', cursor: 'pointer',
      }}
    >
      {busy ? 'Verifying…' : order.address_verified_at ? 'Re-verify' : 'Verify address'}
    </button>

    {order.address_match === 'match' && (
      <span style={{
        fontSize: 10, padding: '3px 8px', borderRadius: 4,
        background: '#f0fff4', color: '#276749', border: '1px solid #9ae6b4', fontWeight: 700,
      }}>✓ MATCH</span>
    )}
    {order.address_match === 'mismatch' && (
      <span style={{
        fontSize: 10, padding: '3px 8px', borderRadius: 4,
        background: '#fff5f5', color: '#9b2c2c', border: '1px solid #fc8181', fontWeight: 700,
      }}>⚠ POSTAL MISMATCH</span>
    )}
    {order.address_match === 'unverifiable' && (
      <span style={{
        fontSize: 10, padding: '3px 8px', borderRadius: 4,
        background: '#fffaf0', color: '#c05621', border: '1px solid #fbd38d', fontWeight: 700,
      }}>UNVERIFIABLE</span>
    )}
  </div>

  {order.address_match === 'mismatch' && order.address_google_formatted && (
    <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-ink-muted)' }}>
      <div>Customer ZIP: <strong>{order.address_customer_postal ?? '—'}</strong></div>
      <div>Google ZIP: <strong>{order.address_google_postal ?? '—'}</strong></div>
      <div style={{ marginTop: 4 }}>Google's address: <em>{order.address_google_formatted}</em></div>
      <button
        onClick={() => void sendMismatchEmail()}
        disabled={busy || !order.customer_email}
        style={{
          marginTop: 8, padding: '6px 12px', fontSize: 11, fontWeight: 600,
          background: 'var(--color-crimson)', color: '#fff', border: 'none',
          borderRadius: 'var(--radius-sm)', cursor: 'pointer',
        }}
      >
        Send mismatch email
      </button>
    </div>
  )}

  {msg && (
    <div style={{ marginTop: 8, fontSize: 11, color: msg.startsWith('Error') || msg.startsWith('Send failed') ? 'var(--color-error)' : 'var(--color-ink-muted)' }}>
      {msg}
    </div>
  )}
</div>
```

- [ ] **Step 3: Build + tests**

```
cd app && npm run build
cd app && npm test -- --run
```

Both must be clean.

- [ ] **Step 4: Commit**

```powershell
cd e:/Claude/makelila
git add app/src/modules/OrderReview/detail/AddressCard.tsx
git commit -m @'
feat(order-review): Verify address button + mismatch email send

Operator clicks Verify address → calls verify-address edge function →
shows MATCH / POSTAL MISMATCH / UNVERIFIABLE badge. On mismatch, shows
customer vs Google ZIP side-by-side + a Send mismatch email button
that fires the existing address_mismatch template pre-filled with
both versions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

---

### Task 5: Final review + commit docs

- [ ] **Step 1: Commit the spec + plan**

```powershell
cd e:/Claude/makelila
git add docs/superpowers/specs/2026-05-27-address-verification-design.md docs/superpowers/plans/2026-05-27-address-verification.md
git commit -m @'
docs(orders): spec + plan for alpha P1 #1 Google Maps address verification

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
'@
```

- [ ] **Step 2: Dispatch a final cross-cutting reviewer**

See the implementer's report. (Handled by the orchestrator, not the implementer subagent.)

- [ ] **Step 3: Tell Huayi what's left for him to do**

1. Get a Google Maps Geocoding API key from Google Cloud Console
2. Set it: `supabase secrets set GOOGLE_MAPS_API_KEY=AIza... --project-ref txeftbbzeflequvrmjjr`
3. Click "Verify address" on any order in OrderReview to test
