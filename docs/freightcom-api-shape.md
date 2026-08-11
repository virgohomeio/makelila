# What the Freightcom API can and cannot tell us

Measured against the **live** account on 2026-08-11 with `freightcom-endpoint-scan`.
Read this before designing anything that expects the Shipping dashboard to mirror
the Freightcom portal — it can't, and the reason is structural rather than a bug.

## The headline: there is no way to list shipments

| Route | Result | Reading |
|---|---|---|
| `GET /finance/documents?start_date&end_date` | **200**, 774 docs | the only bulk read that exists |
| `GET /finance/payment-methods` | 200 | works |
| `GET /shipment/{id}` | 404 `not found` | route exists; our ids don't resolve |
| `GET /shipment/{id}/tracking-events` | 404 | same |
| `GET /shipments` · `/shipment` · `/shipments/search` · `/track/{n}` · `/tracking/{n}` | **403** | **no such route** |
| `GET /finance/invoices-for-shipment-id/{n}` | 500 | route exists, errors on these ids |

Reading the status codes correctly matters here:

- **403 with an AWS SigV4 complaint** (`Authorization header requires 'Credential'
  parameter…`) means **the route does not exist**. It is API Gateway rejecting an
  unknown path, not a permissions problem. This misled an earlier investigation
  into thinking finance scope was missing.
- **404 `{"message":"not found"}`** means the route exists and authentication
  passed — the resource simply isn't there.

## Two id spaces that never meet

Finance documents look like this:

```json
{ "id": "028uK6URd6MJa7YXqpP8hjm2Y29HFFW7",
  "type": "shipment-order-details",
  "number": "43694778",
  "date": { "year": 2026, "month": 5, "day": 14 },
  "amount": { "value": "19304", "currency": "CAD" },
  "owing": { "value": "0", "currency": "CAD" } }
```

- **`number`** is the portal's transaction number — exactly what
  `shipments.freightcom_shipment_id` holds. This is the join key.
- **`id`** is an opaque document key that resolves nowhere else.
- **`amount.value` is in CENTS.** `"19304"` is $193.04.
- `GET /shipment/{id}` accepts **neither**. It only resolves ids minted by
  `POST /shipment` — i.e. shipments *we* booked through the API. Anything booked
  in the Freightcom web portal 404s there permanently.

Document types seen (774 documents, 359 distinct numbers):

| Type | Count |
|---|---|
| `shipment-order-details` | 582 |
| `shipment-credit-card-invoice` | 167 |
| `shipment-credit-card-detailed-invoice` | 15 |
| `shipment-credit-card-refund-invoice` | 9 |
| `bulk-refund-credit-card-invoice` | 1 |

Several documents per shipment, so picking one arbitrarily can read a refund as
the shipment's cost. `pickCostDocument()` in `parse.ts` ranks them and drops
refunds.

## What follows for the dashboard

1. **Cost, invoice date and existence** come from finance documents, for any
   shipment on the account.
2. **Carrier, service, tracking number, addresses and status** come only from
   `GET /shipment/{id}` — so for portal-booked shipments we get money and nothing
   else. `scripts/import-freightcom-tracking.mjs` (portal CSV export) is what
   fills in the rest, and remains necessary.
3. **A shipment is invisible to us until Freightcom raises a finance document for
   it**, which lags shipping by up to a billing cycle. The dashboard therefore
   cannot be a live mirror of the portal by API alone.
4. If shipments were booked through makelila's **Book a Label**
   (`freightcom-book`, `POST /shipment`), we would capture the API's own shipment
   id at creation and all of the above would resolve — that is the only route to
   genuine parity.

## Reproducing

```bash
curl -s -X POST "$SUPABASE_URL/functions/v1/freightcom-endpoint-scan" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" -d '{}'
```

Accepts `{ "paths": [...] }` to scan specific routes and `{ "full": true }` to
return untruncated bodies. Read-only; every call is a GET.
