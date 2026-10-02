# Freightcom rate probe — mapping ship-date price and week-long drift

**Status:** approved 2026-09-22. Requested by Huayi.

## The question, and the correction it needed

The ask was: quote shipping for James Soto (and every confirmed customer) twice
a day for seven days, to "identify the cheapest date out of the week to ship to
California."

Quoting the same shipment twice a day varies **when you ask**, not **when you
ship**. Freightcom's rate body carries an `expected_ship_date`, and
`nextShipDate()` in `_shared/freightcom.ts` hardcodes it to *tomorrow* for every
caller. So a twice-daily loop over a fixed ship date cannot answer the question
that was asked — every quote in it is a quote for tomorrow.

The fix is to sweep the ship date. Each run rates **D+1 … D+7** per customer, so
the cheapest-ship-date answer exists after run 1 rather than after day 7.

The twice-daily repetition is kept, because rates demonstrably move. The
existing 380 rows in `freight_quotes` contain one order quoted on two separate
days:

| Service | 2026-09-16 | 2026-09-22 | Δ |
|---|---|---|---|
| UPS — Standard | $169.24 | $180.27 | **+6.5%** |

That is a real drift signal over six days, and it is a *different* question from
ship-date choice. The design answers both: within-run comparison gives the
cheapest ship date, across-run comparison gives the drift.

## Scope

The cohort is the **Sales → Confirmed** tab, which holds **29** orders (not 25):
14 US, 15 CA, all with a postal code and a customer email, so all 29 are
quotable. James Soto is `#1185`, postal `94526` (Danville, CA). Four orders are
Californian: `#1185`, `#1187` (95148), `#1263` (91702), `#1255` (91302).

The cohort is **frozen at job start**. The Confirmed tab is live, and a customer
entering or leaving mid-week would make the week's numbers non-comparable.

## Design

### Storage: a separate table

Probe rows do **not** go in `freight_quotes`. `useFreightQuotes`
(`app/src/lib/freight.ts`) selects `*` for an order with no limit, so ~2,850
probe rows would put ~700 rows into each order's Sales Freight card and break
it.

- **`freight_rate_probes`** — one row per returned rate:
  `order_id, order_ref, customer_name, dest_postal, dest_country, ship_date,
  run_index, run_at, carrier, service_level, rate_cad, transit_days, flag_level,
  raw`.
- **`freight_rate_probe_jobs`** — the campaign: `label, started_on, days,
  ship_dates, cohort` (the frozen order ids), `status`.
- **`freight_rate_probe_runs`** — one per invocation cycle: `run_index,
  day_index, cursor_index, quotes_saved, status, error`.

### Probe function — chunked and self-driving

`supabase/functions/freightcom-rate-probe`, authenticated through
`_shared/auth.ts` (`X-Cron-Secret` or an internal JWT).

Each invocation processes **2 orders × 7 ship dates** — 14 rate calls, all seven
of an order's dates in flight at once — then advances `cursor_index` and hands
the next chunk to pg_net, 15 chunks to a run. At the observed ~6 s per rate a
chunk is ~12 s, and ~48 s even if every call runs to the poll limit. This is not
an optimisation. `20260806150000_freightcom_sync_cron_timeout.sql`
records that `invoke_edge_function()` leaves pg_net on its **5000 ms default**
and that `cron.job_run_details` reports **"succeeded" regardless**, which is how
the Freightcom dashboard sat six weeks stale with nothing looking broken. A
single long invocation here would fail the same silent way.

Rate bodies reuse `buildShipmentDetails` / `packagesForLineItems` /
`quotableDestinationPostal` unchanged, with `expected_ship_date` swept rather
than fixed. Box count and destination postal therefore stay correct per the
2026-09-10 accuracy findings.

The cohort is recomputed server-side from `orders` + `fulfillment_queue` +
`units`, mirroring `bucketOrders()`'s `approved` bucket.

### Flagging

On the cheapest CAD quote per (order, ship_date) — the API returns CAD for every
destination including US ones, so no conversion is involved:

- `rate_cad > 200` → **critical**
- `rate_cad > 150` → **warn**
- otherwise → none

### Report function — days 2, 4, 7

`supabase/functions/freight-rate-report` runs daily and sends only when
`today − started_on` is day 2, 4 or 7. To **reina@virgohome.io**, cc
**huayi@virgohome.io** and **george@virgohome.io**, via Resend from
`support@lilacomposter.com` — the only verified sender domain. Every send is
logged to `email_messages` like the other digests.

Contents: cheapest rate per customer × ship date; the best ship weekday overall
and for the four California orders; drift against run 1; and the flagged list
split at $150 / $200.

### Schedule

Explicit `net.http_post(... timeout_milliseconds := 30000)` — **not**
`invoke_edge_function()`, for the reason above.

- probe: `0 12,0 * * *` UTC (08:00 and 20:00 ET)
- report: `0 13 * * *` UTC

`freight_probe_job_active()` guards both, so an expired or aborted campaign
costs nothing at all — no invocation, no cold start. On day 7 the report calls
`freight_probe_finish()`, which closes the job and unschedules both.

## Risks

**API load is unprecedented for this account.** ~203 rate requests per run,
~2,850 over the week. This token was previously deactivated by Freightcom for
*inactivity*, and its behaviour under sustained load is unknown. A single-order
smoke test runs first and is checked for 429s before the cohort is opened — step
2 of the runbook below.

**Deploy is partly gated.** Edge functions auto-deploy on push to main;
migrations sit behind `workflow_dispatch` with `apply_migrations: true` in
`.github/workflows/supabase.yml`, which a human has to trigger.

## Out of scope

No UI. The probe writes to its own tables and reports by email; nothing in the
Sales module reads `freight_rate_probes`. If the finding is durable, folding
"cheapest ship day" into the Sales freight card is a separate piece of work.

## Runbook

The probe does nothing until a job is opened, so deploying it is inert.

1. **Apply the migration** — GitHub → Actions → *Deploy Supabase backend* →
   Run workflow, `apply_migrations: true`. Edge functions deploy on push
   already; this step is only the tables, the crons and the RPCs.
2. **Smoke-test one order** before turning the cohort loose on the API:
   `POST /functions/v1/freightcom-rate-probe`
   `{"start": true, "only_orders": ["#1185"], "label": "smoke-2026-09-22"}`
   That opens a one-order job and rates James Soto against seven ship dates —
   7 rate requests. Check for 429s and check `freight_rate_probes` has rows.
3. **Abort the smoke job** — `update freight_rate_probe_jobs set status =
   'aborted'` — then open the real one:
   `{"start": true, "label": "confirmed-2026-09-22"}`.
   The cohort is frozen at this call, so run it when the Confirmed tab is in
   the state you want measured.
4. **Reports** land on days 2, 4 and 7 without further action. To see one
   early: `POST /functions/v1/freight-rate-report` `{"force": true,
   "dry_run": true}` returns the rendered text without sending.
5. **Stop early** — set the job's status to `aborted`; both crons become
   no-ops immediately via `freight_probe_job_active()`.

`EMAIL_TEST_RECIPIENT`, if set on the function, redirects the report away from
the team, exactly as it does for the other digests.
