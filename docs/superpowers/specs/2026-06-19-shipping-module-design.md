# Shipping Module Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a standalone Shipping nav module with four tabs (Shipping, Tracking, Invoices, Claims) backed by the Freightcom REST API, enabling operators to quote, book, track shipments, look up invoices, and file internal claims — all from makeLILA.

---

## Decisions Logged

| Question | Decision |
|---|---|
| Shipping tab mode | Full booking workflow (quote → select → book → print label) |
| Claims tab | Internal tracker stored in makeLILA DB |
| Module placement | Standalone nav module (`/shipping`) |
| Left panel queue | All orders, filtered by status chips (Ready / Shipped / All) |
| Data architecture | Hybrid: booking stored in DB; tracking + invoices fetched live |

---

## Freightcom API — Key Endpoints

Base URL: `https://customer-external-api.ssd-test.freightcom.com` (test) / `https://external-api.freightcom.com` (live)  
Auth: `Authorization: <token>` header (bare token, no Bearer prefix)

| Tab | Endpoints |
|---|---|
| Shipping (quote) | `POST /rate` → poll `GET /rate/{id}` (already implemented in `freightcom-quote` edge fn) |
| Shipping (book) | `POST /shipment` → poll `GET /shipment/{id}` until 200 → extract `labels[].url` + `primary_tracking_number` |
| Tracking | `GET /shipment/{id}/tracking-events` |
| Invoices | `GET /finance/documents` (date range) + `GET /finance/invoices-for-shipment-id/{id}` |
| Claims | No Freightcom API — internal DB only |

**Booking detail:**
- `POST /shipment` required fields: `unique_id` (use `freight_quotes.id` to prevent duplicate bookings), `payment_method_id` (from env secret `FREIGHTCOM_PAYMENT_METHOD_ID`), `service_id` (from `freight_quotes.raw.service_id`), `details` (same origin/destination/packages structure as rate request)
- `POST /shipment` returns 202 `{id}`. Then poll `GET /shipment/{id}` — returns 202 while processing, 200 when ready.
- From 200: `shipment.labels` array — take first entry with `format="pdf"` for label URL. Also extract `shipment.primary_tracking_number` and `shipment.state`.
- New env secret needed: `FREIGHTCOM_PAYMENT_METHOD_ID` — set via `supabase secrets set FREIGHTCOM_PAYMENT_METHOD_ID=<id>`. Obtain by calling `GET /finance/payment-methods` with the API key.

---

## Data Model

### New: `shipments` table

```sql
create table shipments (
  id                     uuid primary key default gen_random_uuid(),
  order_id               uuid references orders(id) not null,
  freightcom_shipment_id text not null unique,
  carrier                text not null,
  service                text not null,
  rate_cad               numeric,
  transit_days           int,
  label_url              text,
  primary_tracking_number text,
  status                 text not null default 'booked',
  booked_at              timestamptz default now(),
  booked_by              uuid references auth.users(id)
);

-- RLS: is_internal only
alter table shipments enable row level security;
create policy "internal only" on shipments
  using (exists (select 1 from profiles where id = auth.uid() and is_internal));

create index on shipments(order_id);
```

`status` values mirror Freightcom's `shipment.state`: `booked` (waiting-for-transit), `in_transit` (in-transit), `delivered`, `exception`, `missing`, `cancelled`.

### New: `claims` table

```sql
create table claims (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid references orders(id) not null,
  shipment_id  uuid references shipments(id),
  reason       text not null check (reason in ('damage','lost','late','other')),
  amount_cad   numeric,
  status       text not null default 'open'
                 check (status in ('open','submitted','resolved','denied')),
  notes        text,
  filed_at     timestamptz default now(),
  filed_by     uuid references auth.users(id),
  resolved_at  timestamptz
);

alter table claims enable row level security;
create policy "internal only" on claims
  using (exists (select 1 from profiles where id = auth.uid() and is_internal));

create index on claims(order_id);
create index on claims(shipment_id);
```

### Existing: `freight_quotes` (unchanged)

Already stores quoted rates. The selected quote's `raw` JSON contains `service_id` needed for booking.

---

## File Structure

```
app/src/
  modules/Shipping/
    index.tsx                    # Route root: ShippingQueue (left) + tab router (right)
    ShippingQueue.tsx            # Left panel: order list + status filter chips
    tabs/
      ShippingTab.tsx            # Quote table + Book & Print Label button
      TrackingTab.tsx            # Live tracking events timeline
      InvoicesTab.tsx            # Finance documents list + per-shipment invoices
      ClaimsTab.tsx              # Claims table + File Claim inline form
    Shipping.module.css
  lib/
    shipping.ts                  # Types, hooks (useShipment, useClaims), mutations
supabase/functions/
  freightcom-book/index.ts       # POST /shipment → poll → store in shipments table
  freightcom-tracking/index.ts   # GET /shipment/{id}/tracking-events → return events
  freightcom-invoices/index.ts   # GET /finance/documents + invoices-for-shipment-id
```

---

## Module Behaviour

### Route

`/shipping` — renders `ShippingQueue` on the left, nothing on the right until an order is selected.  
`/shipping/:orderId/:tab` — tab is one of `shipping | tracking | invoices | claims`.

Register in `App.tsx` alongside existing routes. Add "Shipping" to `GlobalNav`.

### Left panel — ShippingQueue

Chips: **Ready to Ship** (orders joined to `fulfillment_queue` where `step >= 3` and no `shipments` row exists — at dock or label stage, not yet booked) | **Shipped** (orders with a `shipments` row, status ≠ `cancelled`) | **All**.

Default chip: Ready to Ship. Each row shows: order number, customer name, destination city/province, status badge.

### Shipping tab

1. Load `freight_quotes` for the order (existing hook `useQuotes`).
2. If no quotes yet: show "Fetch Quotes" button → calls `fetchFreightcomQuotes()` (existing).
3. Rate table columns: Carrier, Service, Rate (CAD), Transit Days, [Select] button.
4. Selecting a rate calls `selectQuote()` (existing) — highlights the row with a checkmark.
5. Once a rate is selected: "Book & Print Label" button appears.
6. Clicking it: calls `freightcom-book` edge function with `{order_id, quote_id}`.
   - On success: row inserted into `shipments`, label URL opens in a new tab, left panel order status flips to "Shipped".
   - On error: toast with Freightcom error message, no DB change.
7. If a `shipments` row already exists for this order: show "Already booked" card with carrier, tracking number, label link, booked-at timestamp. No re-booking allowed (operator must cancel via Freightcom portal first).

### Tracking tab

Calls `freightcom-tracking` edge function with the order's `freightcom_shipment_id`. Shows a vertical timeline of tracking events (timestamp, location, description). If no shipment booked yet: "No shipment booked" empty state.

### Invoices tab

Two sections:
1. **This shipment** — calls `freightcom-invoices` with `shipment_id` mode → lists invoices for the booked shipment. Columns: Invoice #, Date, Amount, Due Date.
2. **All invoices** — calls `freightcom-invoices` with `date_range` mode → `GET /finance/documents` filtered by last 90 days. Same columns. Useful for month-end reconciliation.

If no shipment booked: only "All invoices" section is shown.

### Claims tab

Table of existing claims for the selected order (from `claims` table). Columns: Filed, Reason, Amount, Status, Notes.

"+ File Claim" button → expands an inline form:
- Reason: dropdown (`Shipping Damage | Lost in Transit | Late Delivery | Other`)
- Amount (CAD): number input
- Notes: textarea
- Submit → inserts row into `claims`, logs activity

Status can be updated inline via a dropdown on each row (open → submitted → resolved / denied). Resolved sets `resolved_at = now()`.

---

## Edge Functions

### `freightcom-book`

**Input:** `{ order_id: string, quote_id: string }`

**Steps:**
1. Authenticate caller (same JWT → is_internal check as `freightcom-quote`).
2. Load `freight_quotes` row for `quote_id` — extract `service_id` from `raw.service_id`, `rate_cad`, `transit_days`, `service_level` (carrier + service name).
3. Load order destination (postal code, country).
4. Build `POST /shipment` body: `unique_id = quote_id`, `payment_method_id = FREIGHTCOM_PAYMENT_METHOD_ID` env secret, `service_id`, `details` (same origin/destination/packages structure as rate request).
5. `POST /shipment` → expect 202 `{id}`.
6. Poll `GET /shipment/{id}` every 2s, max 20 tries, until HTTP 200.
7. Extract from 200 response: `labels` (first `format=pdf` entry), `primary_tracking_number`, `state`.
8. Insert into `shipments` table. Return `{ shipment_id, label_url, tracking_number }`.

**New env secret required:** `FREIGHTCOM_PAYMENT_METHOD_ID`

### `freightcom-tracking`

**Input:** `{ freightcom_shipment_id: string }`

Calls `GET /shipment/{id}/tracking-events`. Returns `{ events: [...] }` as-is.

### `freightcom-invoices`

**Input:** `{ mode: 'shipment' | 'date_range', freightcom_shipment_id?: string, days?: number }`

- `mode=shipment`: calls `GET /finance/invoices-for-shipment-id/{freightcom_shipment_id}`
- `mode=date_range`: calls `GET /finance/documents` with a date range (default 90 days back)

Returns invoice list as-is.

---

## Data Layer — `lib/shipping.ts`

```typescript
export type Shipment = {
  id: string;
  order_id: string;
  freightcom_shipment_id: string;
  carrier: string;
  service: string;
  rate_cad: number | null;
  transit_days: number | null;
  label_url: string | null;
  primary_tracking_number: string | null;
  status: 'booked' | 'in_transit' | 'delivered' | 'exception' | 'cancelled';
  booked_at: string;
  booked_by: string | null;
};

export type Claim = {
  id: string;
  order_id: string;
  shipment_id: string | null;
  reason: 'damage' | 'lost' | 'late' | 'other';
  amount_cad: number | null;
  status: 'open' | 'submitted' | 'resolved' | 'denied';
  notes: string | null;
  filed_at: string;
  resolved_at: string | null;
};

// Hooks
export function useShipment(orderId: string | null): { shipment: Shipment | null; loading: boolean }
export function useClaims(orderId: string | null): { claims: Claim[]; loading: boolean }

// Mutations
export async function bookShipment(orderId: string, quoteId: string): Promise<Shipment>
export async function updateClaimStatus(claimId: string, status: Claim['status']): Promise<void>
export async function fileClaim(orderId: string, shipmentId: string | null, fields: Omit<Claim, 'id' | 'order_id' | 'filed_at' | 'resolved_at'>): Promise<Claim>
```

All mutations call `logAction()` for audit trail.

---

## Activity Log Actions

| action | entity | detail |
|---|---|---|
| `shipment_booked` | order | `freightcom_id=FC-xxx carrier=UPS` |
| `claim_filed` | order | `reason=damage amount=340` |
| `claim_status_updated` | order | `claim_id=xxx status=resolved` |

---

## Env Secrets

| Secret | Purpose | How to set |
|---|---|---|
| `FREIGHTCOM_API_KEY` | Already set — API auth | — |
| `FREIGHTCOM_PAYMENT_METHOD_ID` | Payment method for booking | Call `GET /finance/payment-methods` with the API key; pick the net-terms or credit card ID; run `supabase secrets set FREIGHTCOM_PAYMENT_METHOD_ID=<id>` |

---

## Out of Scope

- Cancelling a shipment from makeLILA (`DELETE /shipment/{id}`) — operator uses Freightcom portal
- Schedule/pickup booking (`POST /shipment/{id}/schedule`) — future enhancement
- Cross-border customs data — LILA ships domestic CA only for now
- Claim attachments (photos) — future enhancement
