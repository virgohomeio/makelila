# Google Maps Address Verification — Design

> Alpha-feedback P1 #1. Source: Pedrum (Apr 29 + May 26 email thread). Today: 75 orders; 71 'house' / 3 'apt' / 1 'remote' verdict, all set by regex heuristic at sync time.

**Goal:** Let operators verify a customer's shipping address against Google Maps Geocoding on-demand, detect postal-code mismatches, flag the order, and send the existing `address_mismatch` email template with both versions pre-filled.

**User decisions locked in (from brainstorming):**
- **Validation timing:** On-demand from the OrderReview detail panel (operator clicks "Verify address" button) — no auto-validation on Shopify sync.
- **Mismatch threshold:** Postal/ZIP code differs (strict).
- **Action on mismatch:** Set `orders.status='flagged'` and show a "Send mismatch email" button. Operator clicks send; we don't auto-send.

## Architecture

```
[OrderReview AddressCard] --click "Verify address"--> [verify-address edge function]
                                                           |
                                                           v
                                                  [Google Maps Geocoding API]
                                                           |
                                                           v
                                                  [orders table update]
                                                           |
                                                           v
[realtime → AddressCard re-renders with badge + email button]
```

The Google API key lives only in the edge function's environment (Supabase secret), never in the browser. Frontend talks to `verify-address` only.

## Schema

**Migration:** `20260527150000_address_verification.sql`

```sql
alter table public.orders
  add column address_verified_at      timestamptz,
  add column address_match            text
    check (address_match in ('match','mismatch','unverifiable')),
  add column address_google_formatted text,
  add column address_google_postal    text,
  add column address_customer_postal  text;
```

All nullable — existing orders show as "not verified yet" in the UI. No backfill.

## Edge function

**Path:** `supabase/functions/verify-address/index.ts`

**Env var:** `GOOGLE_MAPS_API_KEY` (Supabase secret; obtained from Google Cloud Console with Geocoding API enabled and billing on; cost ≈ $5 per 1000 requests, first 200/month free).

**Input:** `{ order_id: string }` (POST body)

**Logic:**
1. Auth: `verify_jwt: false`; uses service role internally
2. Fetch order from `orders` table by id
3. Build the query string: `"<address_line>, <city>, <region_state>, <country>"`
4. Parse customer's postal out of `address_line` via regex:
   - US: `\b\d{5}(-\d{4})?\b`
   - CA: `\b[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d\b`
5. Call `https://maps.googleapis.com/maps/api/geocode/json?address=<encoded>&key=<key>`
6. From the response, find the `postal_code` component and the `formatted_address`
7. Determine match:
   - If Google returns no results OR no postal component → `'unverifiable'`
   - If customer postal couldn't be parsed → `'unverifiable'`
   - If postals match (normalized: uppercase, no spaces/hyphens, US ZIP+4 trimmed to base 5) → `'match'`
   - Otherwise → `'mismatch'`
8. Update `orders`:
   - `address_verified_at = now()`
   - `address_match = <verdict>`
   - `address_google_formatted = <google formatted>`
   - `address_google_postal = <google postal>`
   - `address_customer_postal = <parsed customer postal or null>`
   - If `'mismatch'`: also set `status = 'flagged'` (preserves operator's ability to manually move back)
9. Return `{ match: 'match'|'mismatch'|'unverifiable', customer_postal, google_postal, google_formatted }`

**Errors:** non-2xx Google response → return `{ error: "Google <status>: <body>" }` with HTTP 502.

## Frontend

### `app/src/lib/orders.ts`

Extend `Order` type with the 5 new fields (all nullable).

Add mutation:

```typescript
export async function verifyAddress(orderId: string): Promise<{
  match: 'match'|'mismatch'|'unverifiable';
  customer_postal: string | null;
  google_postal: string | null;
  google_formatted: string | null;
}> {
  const { data, error } = await supabase.functions.invoke('verify-address', { body: { order_id: orderId } });
  if (error) throw error;
  await logAction('address_verified', orderId, (data as { match: string }).match);
  return data as Awaited<ReturnType<typeof verifyAddress>>;
}
```

### `app/src/modules/OrderReview/detail/AddressCard.tsx`

Add three pieces below the existing verdict block:

1. **"Verify address" button** — primary action when `address_verified_at` is null; secondary "Re-verify" when already verified.

2. **Verification badge** — shown when `address_verified_at` is set:
   - `match`: green pill "✓ Verified · matches Google Maps"
   - `mismatch`: red pill "⚠ ZIP mismatch · customer: X · Google: Y"
   - `unverifiable`: yellow pill "Could not verify"

3. **"Send mismatch email" button** — shown only on `mismatch`. Clicking it calls `sendTemplate('address_mismatch', {...prefill})` (already-existing template; already-existing send flow). Pre-fills variables:
   - `customer_first_name`: first word of `customer_name`
   - `customer_address`: `address_line` (the customer's version)
   - `google_address`: `address_google_formatted`
   - `order_ref`: `order_ref`

Don't open a dedicated modal — call `sendTemplate` directly so the email goes out without an extra click. Show a confirmation toast on success / error message on failure. (Rationale: operator already clicked the button; second confirmation is friction.)

## Out of scope (deferred)

- Auto-validation on Shopify sync (decided against; manual-only this round)
- Region/state mismatch detection (postal-only this round per spec)
- Suggested-address replacement UX (let the operator manually edit the address via QUO if they want; this v1 just informs)
- Geocoding cache (each verify is a fresh API call — fine at current volume)
- Webhook/event when customer replies to the mismatch email (manual follow-up)

## Setup steps for you (Huayi)

Before this works end-to-end you need to:

1. **Google Cloud Console**: create a project (or reuse existing), enable "Geocoding API", create an API key, set the key's quota + restrict to "Geocoding API" only.
2. **Billing**: enable billing on the project (Google requires it even for the free tier).
3. **Supabase secret**: `supabase secrets set GOOGLE_MAPS_API_KEY=AIza... --project-ref txeftbbzeflequvrmjjr`
4. **No code redeploy needed after setting the secret** (per the recently-updated Shopify integration memory).

The migration + edge function + UI ship without the key — the button will just return `"Google API key not configured"` until step 3 lands.
