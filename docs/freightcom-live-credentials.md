# Freightcom: connecting the integration to the live account

**Status: RESOLVED 2026-08-11.** A live token was generated in the Freightcom
portal (Settings → API Settings → Manage API Tokens — it is self-serve, no
support ticket needed) and set in Supabase along with `FREIGHTCOM_BASE_URL`. The
first successful sync costed all 38 shipments, $4,709.02 CAD total.

**Read [freightcom-api-shape.md](freightcom-api-shape.md) before changing the
sync** — the live key revealed that this API cannot list shipments at all, which
constrains what the dashboard can ever show.

**Raised:** 2026-08-06. **Resolved:** 2026-08-11. The history below is kept
because the diagnosis sequence is reusable when the token next expires.

---

## The one-line version

`FREIGHTCOM_API_KEY` in Supabase is a **sandbox** key, and as of 2026-08-11 that
sandbox key has been **deactivated by Freightcom for inactivity**. It now
authenticates on *neither* host. Until a live key is issued and
`FREIGHTCOM_BASE_URL` is set to the live host, the Shipping dashboard's
**Rate (CAD)** column stays empty and shipment statuses stay frozen — no matter
how often the sync runs.

## Update — 2026-08-11

Re-ran the probe. The picture changed in the one way that matters:

| Host | Call | 2026-08-06 | 2026-08-11 |
|---|---|---|---|
| live | `GET /shipment/45011657` | 401 | 401 |
| live | `GET /finance/documents` | 401 | 401 |
| sandbox | `GET /shipment/45011657` | 404 (**auth passed**) | **401** `token deactivated due to shipping inactivity` |
| sandbox | `GET /finance/documents` | 200/400 (**auth passed**) | **401** same |

The key now opens nothing. Freightcom's own error string —
`token deactivated due to shipping inactivity` — is the tell: this was a test
token that expired from disuse, which is further confirmation the live account
was never API-provisioned. The request to Freightcom is therefore **issue new
live API credentials**, not "rotate" or "find the existing key".

Dashboard state at that measurement: 38 rows, **0** with a cost,
`max(synced_at) = 2026-06-25`. Nothing has been written since.

Note that `cron.job_run_details` for job 35 (`sync-freightcom-shipments-daily`)
reports **succeeded** for every nightly run. That is a false green: the cron
calls `net.http_post` and never inspects the response, so the function's 502 is
invisible at the cron layer. Judge the integration by `max(synced_at)` on
`public.shipments` or by calling the function directly — not by the cron log.

## Evidence

Not inferred — measured, by sending the configured credential to both hosts.
Reproduce with the read-only `freightcom-auth-probe` edge function (it books,
quotes and cancels nothing):

```bash
curl -s -X POST "$SUPABASE_URL/functions/v1/freightcom-auth-probe" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" -d '{}'
```

Result on 2026-08-06 (see the 2026-08-11 update above for what changed):

| Host | Call | Status | Reading |
|---|---|---|---|
| live (`external-api.freightcom.com`) | `GET /shipment/45011657` | **401** | key not valid for this host |
| live | `GET /finance/documents` | **401** | key not valid for this host |
| sandbox (`customer-external-api.ssd-test.freightcom.com`) | `GET /shipment/45011657` | **404** | **auth passed** — that id just isn't in the test environment |
| sandbox | `GET /finance/documents` | 200 / 400 | **auth passed** — finance scope is present |

Two conclusions:

1. **The key is a sandbox key.** Live 401s everywhere; sandbox authenticates.
2. **Finance/billing scope is NOT the problem.** It was suspected to be missing;
   it isn't. `GET /finance/documents` works on sandbox. The 403s we were seeing
   came from calling the route wrongly (POST instead of GET), fixed in `9a9767e`.

`45011657` is a real shipment on the dashboard. The sandbox returning 404 for it
is the whole issue in miniature: our shipments live in the live account, and our
key opens the test one.

## What to set

Both, together, in Supabase → Project Settings → Edge Functions → Secrets:

| Secret | Value |
|---|---|
| `FREIGHTCOM_API_KEY` | a **live** Freightcom API key with finance/billing scope (bare token — no `Bearer ` prefix) |
| `FREIGHTCOM_BASE_URL` | `https://external-api.freightcom.com` |

Set **both**. `FREIGHTCOM_BASE_URL` is currently unset, and all six
`freightcom-*` functions then fall back to the sandbox default — so a live key
alone would authenticate against the wrong host and still fail. The functions
that read it: `freightcom-book`, `-invoices`, `-quote`, `-status`, `-tracking`,
and `sync-freightcom-shipments`.

## Verifying it worked

1. Re-run the probe above. Expect `shipping_scope_ok_on: ["live"]` and
   `finance_scope_ok_on: ["live"]`.
2. Run the sync directly:

   ```bash
   curl -s -X POST "$SUPABASE_URL/functions/v1/sync-freightcom-shipments" \
     -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
     -H "Content-Type: application/json" -d '{}'
   ```

   Expect `ok: true`, `warnings: []`, `diagnostics.environment: "live"`, and a
   non-zero `costed`. A non-zero `not_found` equal to `shipments_targeted` means
   the host is still wrong — the function now returns **502** in that case rather
   than a silent success.
3. Open Shipping → All Shipments. The **Rate (CAD)** column should show invoiced
   figures in black; anything still grey and tagged `quoted` has not been
   invoiced by Freightcom yet, which is expected for recent shipments.

## What is already fixed and waiting

These landed in `cb0aa21`, `9a9767e` and `00e8b92` — no further code work is
needed before the key arrives:

- The nightly cron was abandoning every run after 5s (pg_net's default timeout);
  rescheduled with 240s.
- The finance-documents call used the wrong verb and the wrong parameter shape,
  earning a 403 then a 400 on every run and reporting "0 invoices".
- Discovery was invoice-only, so shipments already in our table were never
  revisited. It now reconciles every `freightcom_shipment_id` on the dashboard,
  which is what will backfill the 38 existing rows on the first live run.
- Money is now read with its currency instead of being assumed CAD.
- Auth failures used to be swallowed into an empty array, so a dead integration
  looked identical to a quiet one. That is why this went unnoticed from
  2026-06-25 to 2026-08-06. Failures are now loud: a 502 from the function, and a
  staleness banner on the dashboard.

## Open question for the account owner

Is there a live Freightcom API key at all, or has the account only ever been used
through the Freightcom web UI? Every shipment in `public.shipments` was
hand-loaded from a tracking-dashboard CSV export, which is consistent with the
API never having been provisioned for the live account. If so this needs a
request to Freightcom support for live API credentials with finance scope, not
just a copy-paste of an existing key.

As of the 2026-08-11 re-measurement this is effectively answered: the only key we
hold was a test token and Freightcom has now expired it. Treat this as a support
request for **new live credentials with finance/billing scope**.
