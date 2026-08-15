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

## Rating works, and it is the one route that mints ids we can follow

Measured 2026-08-12 with `freightcom-endpoint-scan`'s `rate` probe (a pricing
query — it books and reserves nothing), origin L3R9Z7 → M1N 1H9, one 23 kg
61×61×61 cm package:

| Leg | Result |
|---|---|
| `POST /rate` | **202**, `request_id` |
| `GET /rate/{request_id}` (poll 1, +2s) | 200, `done:false`, 19 rates |
| `GET /rate/{request_id}` (poll 2, +4s) | 200, `done:true`, **22 rates** |

So the live key rates fine — the sweep above only looked GET-shaped routes and
never covered this. A rate looks like:

```json
{ "service_id": "canpar.ground",
  "carrier_name": "Canpar", "service_name": "Ground",
  "total": { "value": "3605", "currency": "CAD" },
  "transit_time_days": 1, "transit_time_not_available": false }
```

- **`total.value` is in CENTS**, same as finance documents. `"3605"` is $36.05.
- Rates come back in CAD for our account regardless of the destination country,
  which is why `orders.freight_estimate_usd` is rendered as CAD and why
  `selectQuote` refuses to copy a USD-priced quote into it.
- `service_id` is what `freightcom-book` feeds to `POST /shipment`. Booking
  through makelila is therefore the only way to get a shipment id that
  `GET /shipment/{id}` will resolve — see point 4 below.

Note this went unmeasured for two months because quoting could never reach the
API at all: `freightcom-quote` selected `orders.address_postal_code`, a column
that does not exist, so every request died as "Order not found" before any
Freightcom call was made. Fixed 2026-08-12; `edgeFunctionColumns.test.ts` guards
the functions tree against the name coming back.

## Cross-border rating needs an email address at each end

Measured 2026-08-13. A CA→US destination is an **international** shipment to
Freightcom, and the body that rates a domestic one is rejected outright:

| Body | `POST /rate` |
|---|---|
| `origin`/`destination` = address only | **400** `details.origin.email_addresses: at least one email address is required for international shipments` |
| …plus `origin.email_addresses` | **400** same complaint, now for `details.destination` |
| …plus `destination.email_addresses` | **202** → 8–10 rates, CAD |

Two things worth knowing about that error surface:

- The validator reports **one `data` map per call**, so the required-field set
  can only be found by resending a fuller body and reading the next complaint.
  `freightcom-endpoint-scan` takes a `rate_body` passthrough for exactly this.
- **Nothing else** is required for cross-border: no street address, no city or
  region, no customs block. Only the two email fields.

This is why freight estimates worked for Canadian orders and failed for every
American one from the feature's first day — the 502 branch reported a flat
"Freightcom rate request failed" and dropped the body that named the field.
`_shared/freightcom.ts` now builds the request for `freightcom-quote`,
`freightcom-book` and `book-return-label`, emitting the emails on every
shipment (domestic rating is unaffected: 22 rates with and without), and falling
back to `support@lilacomposter.com` when an order carries no customer email.

Rates come back **CAD for a US destination too**, so `cheapestCadQuote` and
`selectQuote` need no currency handling beyond what they already do.

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
return untruncated bodies. Every call is a GET.

Add `{ "paths": [], "rate": { "postal_code": "M1N 1H9", "country": "CA" } }` to
run the rate probe instead of the GET sweep. It POSTs a rate request and polls
the result; nothing is booked, reserved or charged. Takes up to ~20s.

Add `{ "rate_body": { "details": { … } } }` to POST an exact body of your own
instead of the probe's. That is how the international requirement above was
established, and it is the tool to reach for whenever Freightcom answers 400.
