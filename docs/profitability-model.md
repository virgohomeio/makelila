# Customer profitability model

How makeLILA decides whether a customer was worth having. Every figure on the
Customers → Profitability tab is defined here, with its formula, its source
table, and whether it is an **actual**, an **estimate**, or a **projection**.

The rule the whole model is built on: **a number we have not measured is never
presented as if we had.** A cost nobody has priced comes back as $0 with an
"unpriced" label beside it. A metric no table can answer is listed as
unavailable rather than quietly omitted.

That rule only holds if the reader can see which is which, so **every figure on
the tab carries its basis**:

| Mark | Meaning |
|---|---|
| *(none)* | Invoiced. Summed from bills or records of what happened. |
| `est` | A rate multiplied by a quantity. Real arithmetic, but the rate is an assumption. |
| `part est` | Partly invoiced, partly projected — COGS with a mix of batch and schedule, or freight with orders still uncosted. |
| `unpriced` | No rate set, so the bucket reads $0 and the margin is an upper bound. |

`costsBasis()` derives the mark per bucket and `marginBasis()` rolls them up, so
anything downstream of an estimate — contribution margin, LTV, lifetime profit —
inherits and displays it. Today only refunds, consumables and fully-invoiced
COGS and freight carry no mark.

---

## Where the numbers come from

| Layer | File | Job |
|---|---|---|
| SQL view | `public.customer_profitability` | Per-customer aggregation — joins orders, returns, refunds, tickets and diagnosis calls, converts to CAD, emits one row per customer |
| Rates | `public.profitability_rates` | Variable-cost rates and projection assumptions |
| Spend | `public.acquisition_spend_monthly` | Meta spend from `fb_campaigns` + hand-entered rows from `acquisition_spend_manual` |
| Calculations | `app/src/lib/profitability.ts` | Everything needing more than one customer: CAC allocation, rollups, cohorts, distribution |
| Region data | `app/src/lib/regions.ts` | Province/state names and the map's tile positions |
| UI | `app/src/modules/Customers/ProfitabilityTab.tsx` + `profitability/` | Views, charts, map, drill-down |

Currency: every amount is CAD, converted through `public.fx_rates` at the
**current** company rate — not the rate on the order date. A USD order booked
last year is restated at today's rate.

---

## Revenue

| Metric | Formula | Source | Basis |
|---|---|---|---|
| Revenue | `Σ (total_usd − tax_usd)` over sale orders, cancelled included | `orders` | Actual |
| Gross revenue | `revenue + discounts` | `orders.discount_total_usd` | Actual |
| Discount rate | `discounts ÷ gross revenue` | `orders` | Actual |
| Initial unit revenue | Net revenue of the **first** sale order | `orders`, earliest `placed_at` | Actual |
| Upsell revenue | `revenue − initial revenue` | derived | Actual |
| ARPU | `revenue ÷ sale orders` | derived | Actual |
| Recurring revenue | **0** | — | Not offered |

**Tax is not revenue.** Sales tax is collected for the government and passed
through, so it is excluded from revenue and shown separately.

**A cancelled order keeps its revenue and loses its cost** (V16, 2026-08-28).

*Revenue stays.* A cancelled order was a sale, so it counts, and the refund
subtracts it through bucket 4. One reversal, not two — a cancellation refunded
in full nets to zero on the customer's record.

*Cost leaves.* LILA keeps the machine, so its COGS and freight do not belong to
the person who cancelled. They move to `public.retained_unit_costs`, a
company-level view with no customer id, surfaced on the Overview as a line
**beside** contribution margin. No dollar can appear in both places: the view
reads only cancelled sale orders, which are exactly the orders excluded from the
COGS and freight buckets.

Today that is 13 orders, 13 machines, $8,724.98 of build cost plus $778.68 of
freight on the four that shipped before they were cancelled — $9,503.66 in
total. Contribution margin improved by $15,556.52 against V14, all of it cost
that left the customers who cancelled.

**Test orders are not retained machines.** Pedrum's seven cancelled orders
(#1013, #1014, #1089, #1101, #1105, #1106, #1193) are test data — no machine was
built — so `retained_unit_costs` excludes team accounts outright. Including them
would have invented $6,052.78.

> V15, shipped and superseded the same day, also removed the revenue. That broke
> the refund: the approval reversing the sale was still a cost, so the reversal
> counted twice and five customers' margins overstated the loss by $6,547.69.
> V16 is the correction.

**Units.** Sale-order count is the unit denominator. `units_shipped_count`
counts orders with a machine traced to them via `units.customer_order_ref`, but
only 85 of 450 units carry that link, so it is reported and not used as a
denominator.

---

## Cost buckets

Eleven buckets. Each dollar belongs to exactly one; they sum to variable cost
and nothing else is added.

| # | Bucket | Formula | Source | Basis |
|---|---|---|---|---|
| 1 | Product COGS | `Σ cogs_usd` over sale orders | `orders.cogs_usd` | Actual where `cogs_basis = 'batch_actual'`, **estimated** where `'schedule'` (V-SAX roadmap projection) |
| 2 | Shipping | Per shipment: invoiced charge where on file, else the booking quote; **plus** pre-Freightcom freight attributed per customer | `shipment_invoiced_charges`, `orders.shipping_cost_usd`, `legacy_shipping_costs` | Actual; **incomplete** where `shipping_uncosted_count > 0` |
| 3 | Warranty | `Σ (cogs + shipping)` over non-cancelled replacement orders | `orders` where `kind = 'replacement'` | Actual |
| 4 | Refunds | `Σ refund_amount` over approvals not denied | `refund_approvals`, reached through the return **or** by the approval's own customer fields | Actual (expected) + settled subset |
| 5 | Support | `Σ duration × internal attendees × person-hour rate` | `diagnosis_calls`, `support_rates` | Estimated — no-shows billed, since the team's time was spent either way |
| 6 | Return handling | `stocking + inspection + return freight` for units that physically came back | `returns`, `return_cost_rates`, `shipments` | Estimated; freight often missing |
| 7 | Payment fees | `charged gross (incl. tax) × payment_fee_pct` | `profitability_rates` | **Unpriced — rate is 0** |
| 8 | Sales commission | `revenue × sales_commission_pct` | `profitability_rates` | **Unpriced — rate is 0** |
| 9 | Installation | `sale orders × installation_cost_per_unit_cad` | `profitability_rates` | **Unpriced — rate is 0**; LILA ships self-install, so 0 may also be correct |
| 10 | Consumables & parts | `Σ amount` over the customer's retail purchases | `external_item_costs` | Actual |
| 11 | 3PL handling | `order fee + first pick + additional pick × (items − 1)` per order, from the contract's effective date | `profitability_rates` (`fulfilment_*`) | **Estimated** — contracted rates, no invoice to reconcile |

Buckets 7–9 are rated at $0 today. Set them in `profitability_rates` and every
margin, LTV and payback figure moves with them — no code change needed.

**Freight is the bill, not the quote.** `shipments.billed_amount` is what
Freightcom quoted at booking and is never revised, so four batch fuel-surcharge
invoices raised later were invisible — 46 of 169 shipments understated. The
largest single correction is UPS 1ZV56D26DK11111494 (Phayvanh
Nanthavongdouangsy), quoted $173.40 and finally billed $400.92. Bucket 2 now prefers `shipment_invoiced_charges.applicable_cad`,
which is net of both later adjustments and refunds.

The coalesce happens **per shipment, not per order**. Ten sale orders carry more
than one shipment and five are only partly invoiced; swapping an order's whole
freight for its invoiced subset silently deletes the uninvoiced legs, and reads
as a saving where an invoice true-up should only ever cost more.

**Bucket 10 is not freight.** The Amazon orders behind it buy worm castings and
repair parts that the customer keeps — the postage was free with Prime. They
arrived labelled "Amazon shipping costs", but filing them under Shipping would
corrupt every freight-per-unit figure on the tab, so they sit in their own
bucket beside cost of goods. A recipient who matches no customer record is held
at `customer_id is null` and reported as unattributed rather than dropped.
None today: the one case, Kaiti Klucas, now has a customer record.

**The freight gap is measured at customer level.** An order still in the queue
owes no freight, so bucket 2's `shipping_uncosted_count` only counts orders that
shipped. Asking that per order via `units.customer_order_ref` was wrong: the
column carries 80 of 176 shipped units, so the gap read 3 when it was 51.
V10 asks it of the customer instead — did this customer receive a machine? —
which a repeat buyer can over-count. Deliberate: an over-estimate that says so
beats a silent zero. `units_shipped_count` keeps the strict per-order trace,
because it is shown to operators as "Units shipped".

**Pre-Freightcom freight now has a home.** VCycene shipped via Canpar, GLS,
Purolator and FedEx from Oct 2025 until the cutover on 2026-01-26; none of it is
in `shipments` and the Freightcom API has no record of it. 44 shipments worth
$2,526.81 are entered by hand in `legacy_shipping_costs`, keyed by tracking
number.

They attach to the **customer**, not an order. Every row matched a customer on
exact email and 42 of 42 serials matched a unit, but not one carried an order
link — most of that Oct/Nov 2025 cohort predates any order record. Pinning the
cost to an order would mean inventing the order.

`superseded_by_order_ref` holds the one row already counted elsewhere:
Elizabeth Antony's $66.01 sits on order #1173 as `legacy_backfill`. It stays in
the table for the audit trail and out of the sum, so $2,460.80 is countable.
Orders that shipped in the Freightcom era with no invoice on file are still
reported as a gap and still imputed at nothing.

**An approval without a return still counts.** `refund_agg` used to walk
customers → returns → approvals, so an approval with a null `return_id` matched
nothing and contributed nothing — $5,030.56 across five customers, all settled,
all real money out the door. V13 adds a second path that matches the approval's
own `customer_name` / `customer_email`, UNIONed on (customer, approval) so an
approval reachable both ways still counts once.

**Refunds are gross, revenue is net.** A refund returns the tax the customer
paid, but revenue excludes that tax, so a fully-refunded customer shows a
margin worse than their COGS by the tax alone. That is arithmetically right —
the cash did leave — but the HST portion is recoverable from CRA and the model
has no way to know it. Roughly $2.2k across the current 18 approvals.

**The 3PL's transportation is not bucket 11.** FlexSpace passes carrier cost
through at cost, and that same freight is already bucket 2 via Freightcom.
Charging it in both places would bill every shipment twice. As of this writing
no shipment has moved to the 3PL's own carriers either — every one since the
2026-06-23 effective date is still GLS, Canpar or UPS, and there is not one
Canada Post or UniUni record in `shipments`.

**The 3PL's fixed fees are out of scope by design.** Account management
($150/mo) and pallet storage ($28/pallet/mo) do not vary with any one customer,
and this is a *contribution* margin model. Spreading them over customers would
be an allocation presented as a measurement, and would move every customer's
margin whenever the pallet count changed. On the rate card's own ~300-order
scenario that is $2,225–$2,645/mo depending on pallets — a real cost, but an
operating-cost figure rather than a per-customer one. Inbound container
unloading ($550/$850 plus overage) is inventory cost incurred before any
customer exists, and belongs with COGS.

Cancelled orders carry no 3PL fee: nothing was picked.

**Return handling is not the restocking fee.** Bucket 6 is what it costs *us* to
take a machine back. `refund_approvals.restocking_fee_usd` is a fee charged *to
the customer* and already nets out of bucket 4.

---

## Contribution margin

```
Contribution margin   = revenue − Σ(buckets 1…11)
Contribution margin % = contribution margin ÷ revenue      (null when revenue = 0)
```

Computed in SQL as `net_margin_cad` so every surface quotes the same number.

---

## Acquisition cost

```
CAC(customer) = spend(channel, month) ÷ customers acquired(channel, month)
```

Spend is matched to the month of the customer's **first** sale order, on the
channel that order was attributed to. Later orders are upsells and must not
re-attribute the customer.

The split within a channel-month is even. There is no per-customer ad cost, and
weighting it would be precision we did not buy.

Each CAC carries a **basis**:

| Basis | Meaning |
|---|---|
| `allocated` | Real spend, divided across the customers it won |
| `no_spend` | Channel had no traceable spend that month — booked at $0 |
| `unknown` | No acquisition date, so no month to allocate from |

**Only Meta spend syncs.** `fb_campaigns` covers paid social. Organic search,
direct, referral and email have no spend feed, so their CAC reads $0 and their
LTV:CAC is undefined. Add rows to `acquisition_spend_manual` to fix this.

Spend in a channel-month that won no customers is reported as *unallocated*
rather than silently dropped — it is real money nobody carries.

Team accounts are excluded from the split; letting them absorb a share would
deflate every real customer's CAC.

**Channels** are normalized by `public.normalize_channel(source, medium)` into:
paid social, organic search, organic social, referral, direct, email, other,
unattributed.

---

## Lifetime value

| Metric | Formula | Basis |
|---|---|---|
| Realized LTV | Contribution margin banked to date | **Actual** |
| Projected LTV | `realized + monthly recurring × months remaining in assumed lifetime` | **Projection** |
| LTV:CAC | `LTV ÷ CAC`, null when CAC is 0 | Mixed |
| Lifetime contribution profit | `contribution margin − CAC` | **Actual** (the primary metric) |

With the recurring rate at 0, **projected LTV equals realized LTV**. This is
deliberate: the dashboard will not show a projection that is really a guess.
The assumed lifetime (`projected_lifetime_years`, currently 5) only matters once
a recurring product exists.

A ratio against zero spend is **undefined, not infinite** — it returns null so
it stays out of averages instead of poisoning them.

### CAC payback

LILA sells a machine once and nothing after it, so a customer's entire
contribution arrives at the sale. Payback is therefore binary today:

| Status | Meaning |
|---|---|
| `immediate` | The sale covered acquisition (months = 0) |
| `not_recovered` | Margin is short of CAC; the shortfall is reported, months stays **null** |
| `no_cac` | Nothing was spent to win them |
| `unknown` | CAC could not be established |

`months` is null in the shortfall case on purpose — there is no recurring
revenue stream to project a recovery date from. When a subscription exists,
`cacPayback()` is the one function that changes.

---

## Geography

Province/state is read from the **first sale order's ship-to** — present on all
215 sale orders — falling back to `customers.region`. Country is read from
whichever record supplied the region; mixing a CRM country with an order region
invents places like "US-ON".

Region codes are `country-region`: `CA-ON`, `US-CA`. The prefix is required —
`CA` alone is Canada in one column and California in another.

`public.normalize_region()` folds `Ontario` and `ON` to the same code so a
province is one row, not two.

**The map** is a choropleth on real province and state outlines. The geometry
is generated, not fetched: `app/scripts/generate-region-shapes.mjs` projects
Natural Earth's 1:50m admin-1 boundaries once and writes `lib/regionShapes.ts`,
so the app ships no mapping library and the map draws with no network call.
Rerun that script only when the outlines themselves need to change.

The projection is composite, the same shape d3's `albersUsa` takes: one Albers
conic equal-area over Canada and the lower 48, plus separate framed insets for
Alaska and Hawaii. Alaska in the mainland cone would be a smeared crescent
bigger than Ontario; Hawaii would push the frame 3,000km west for eight pixels
of island. Both insets are captioned as such, and carry their value in the
caption rather than on the islands.

Real geography costs what a tile grid did not: Prince Edward Island is three
pixels across. Regions too small to hold a label get a leader line out to a
chip in the right-hand gutter — and which regions those are is decided by
measured drawing room (the radius of the largest circle that fits inside the
region, computed by the generator), not a hand-kept list, so it stays correct
if the projection changes. Regions never sold into are hatched, because "no
customers here" belongs on a sales map.

Colour is **diverging** (loss ↔ neutral ↔ profit), red for loss and blue for
profit. Red-green was rejected: it is the one pair a red-green colourblind
reader cannot separate, and separating profit from loss is the map's whole job.
Every region is also labelled with its value — inline or in its gutter chip —
so colour never carries meaning alone.

**Ranking floor:** a region needs ≥ 3 customers to appear in the best/worst
lists. One customer tells you nothing about a province, and one warranty claim
would otherwise flip the order.

---

## Segments and cohorts

| Dimension | Key | Note |
|---|---|---|
| Geography | `region_code` | Province/state; country available separately |
| Acquisition channel | `acquisition_channel` | Normalized from first-order UTM |
| Purchase volume | units bought | No purchase / single / 2–3 / 4+ |
| Cohort | month or quarter of `acquired_on` | First sale order, **not** onboard date |

**Cohorts anchor on the first sale**, not `customers.onboard_date` — onboarding
is entered by hand and often lands weeks after the customer actually bought.

**Segment CAC is spend-weighted**: total allocated spend ÷ total customers, not
the mean of per-customer CACs. Those differ whenever cohorts are uneven, and the
weighted figure is the one that reconciles to the ad bill.

**Residential vs commercial is not recorded.** Units purchased is used as the
closest observable proxy — a fleet buyer is almost always a business.

---

## Reliability

```
Warranty claim rate   = customers with a replacement ÷ customers
Replacement rate      = replacements shipped ÷ units sold
Service cost per unit = (support + return handling) ÷ units sold
Warranty + service per unit = (warranty + support + return handling) ÷ units sold
```

Every per-unit figure returns null when no unit has sold.

---

## Metrics this database cannot answer

Listed in the UI under "What these numbers do and don't cover", and in
`UNAVAILABLE_METRICS` in `lib/profitability.ts`.

| Metric | Why not |
|---|---|
| Utilization, cycles, waste processed | Machine telemetry lives in the Lovely dashboard, not this database |
| Active-usage rate (30/90/180/365-day) | Same — Lovely Activity tracks machine presence but is not joined to financial records |
| Subscription / service-plan retention | LILA sells no subscription or service plan |
| Churn rate | A one-time hardware purchase has no renewal to miss; return and refund rates stand in |
| Recurring revenue (MRR/ARR) | No recurring product exists — held at $0, not estimated |
| Residential vs commercial | Customer type is not recorded |
| Per-campaign and per-rep CAC | Campaign-level spend for Meta only; no order carries a sales rep |

---

## Data integrity

- **No double counting.** Each cost belongs to exactly one bucket; a test asserts
  the eleven sum with powers of two so a duplicated bucket changes the total,
  and two more pin consumables and 3PL handling out of the shipping bucket.
- **Refunds reduce margin** through bucket 4, not by editing revenue — the
  original sale stays visible.
- **Cancelled replacement orders are excluded** from warranty cost.
- **Discarded returns are excluded** from return handling: nothing shipped back,
  so there was nothing to stock or inspect.
- **Return freight is matched on the return's own tracking number**, never on
  order id, so it cannot also land in bucket 2.
- **CAC is allocated once over all customers**, before any filter narrows the
  set. Allocating inside the filter would make one customer's CAC change
  depending on who else is on screen.
- **Team accounts are excluded** from CAC allocation and hidden by default.

---

## Filling in the blanks

Everything currently unpriced is one `update` away:

```sql
-- Payment processing, e.g. 2.9% blended
update public.profitability_rates set value = 2.9, updated_at = now()
 where key = 'payment_fee_pct';

-- Sales commission as a share of net revenue
update public.profitability_rates set value = 5, updated_at = now()
 where key = 'sales_commission_pct';

-- Acquisition spend for a channel with no API feed
insert into public.acquisition_spend_manual (channel, month, spend_cad, note)
values ('organic_search', '2026-01-01', 4200, 'SEO retainer');
```

No code change is needed. The view reads the rates on every query and the tab
recomputes from them.

---

## Tests

`app/src/lib/profitability.test.ts` — 69 tests covering revenue, all nine cost
buckets, contribution margin, CAC allocation, LTV, LTV:CAC, payback, rollups,
cohorts, distribution, the waterfall and reliability, plus the edge cases:
zero revenue, zero CAC, zero units, missing cost data, refunds, comped orders,
multi-unit customers and negative lifetime profit.

`app/src/modules/Customers/__tests__/ProfitabilityGeography.test.tsx` — the
province/state comparison, the map, and region reference data.

`app/src/modules/Customers/__tests__/ProfitabilitySupportCost.test.tsx` — the
per-customer card's cost provenance labelling.
