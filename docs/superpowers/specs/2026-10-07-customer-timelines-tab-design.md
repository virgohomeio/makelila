# Customer Timelines tab — design

Date: 2026-10-07 · Operator: Huayi (huayi@virgohome.io)

## Goal

A `Timelines` tab in the Customers module, between Profitability and Journey, that
answers "where is this customer on the clock?" for every customer at once: when
they ordered, when the machine shipped, when they received it, when they were
onboarded, when they started using it, and every diagnosis call they have had.

The Journey tab already shows *which stage* a customer is in. Timelines shows
*when each thing happened* and *how long each gap took*. Those are different
questions and the Journey tab deliberately does not carry dates.

## The six milestones + the call log

| Milestone | Derived from | Customers covered today |
|---|---|---|
| `ordered` | `min(orders.placed_at)` where `kind='sale'` | 221 |
| `shipped` | `units.shipped_at` → `customer_lifecycle.shipped_at` → `orders.shipped_at` | 179 |
| `received` | `shipments.delivered_at` via sale order → `orders.delivered_at` | 110 |
| `onboarding_call` | `min(service_tickets.calendly_event_start)` where `category='onboarding'` | 42 |
| `onboarded` | `customer_lifecycle.onboarding_completed_at` → `lovely.onboarding_done` event | 5 |
| `first_use` | `min(customer_events.occurred_at)` where `source='lovely'` | 19 |

Plus **diagnosis calls**: every `diagnosis_calls` row for the customer, each with
its date, duration and whether it was attended. These are records, not a single
milestone, so they are never overridable — the matrix shows a count and the
first date, the detail panel lists them all.

### Fallback chains are ordered, and the UI says which link answered

Each derived value records its source. The detail panel prints it
(`units.shipped_at`, `customer_lifecycle`, …) so an operator can tell a
Freightcom-confirmed delivery from an inferred one. A fallback is not a
silent equivalence.

### Why manual overrides are part of v1

`onboarded` has 5 rows and `first_use` has 19, against 179 customers who own a
machine. A derived-only tab would be a report of what the integrations are
missing, not a thing an operator can track. So every one of the six milestones
takes an operator-entered date that **wins over** the derived value, carrying
who set it and an optional note. The derived value is never destroyed — clearing
the override falls back to it.

## Data layer — `app/src/lib/customerTimeline.ts`

- `MILESTONES` — the ordered definition list (key, label, short label, description).
- `buildTimelines(inputs) → CustomerTimeline[]` — a **pure function** over
  already-loaded rows (customers, orders, units, lifecycle, tickets, events,
  deliveries, diagnosis calls, overrides). Pure so the derivation is unit-tested
  without Supabase.
- `useCustomerDeliveries()` — a focused fetch of `shipments(order_id, delivered_at)`.
  `AllShipmentRow` is cost-shaped and carries no `delivered_at`; widening it for
  this would drag freight-invoice fields into a timeline screen.
- `useDiagnosisCalls()` — `diagnosis_calls` rows.
- `useTimelineOverrides()` — `customer_timeline_milestones`, fetch + realtime +
  an explicit `refresh()`. Realtime-only hooks go stale when the socket drops.
- `setMilestoneOverride()` / `clearMilestoneOverride()` — upsert/delete, each
  calling `logAction()`.

Gaps (`shipped → received`, `received → first_use`, `received → onboarded`) are
computed in `gapDays()`, which returns `null` rather than 0 when either end is
missing. A missing date must never read as "same day".

## DB — `customer_timeline_milestones`

```
id            uuid pk
customer_id   uuid not null references customers(id) on delete cascade
milestone     text not null check (in the six keys)
occurred_at   timestamptz not null
note          text
set_by        text          -- operator email
created_at/updated_at timestamptz
unique (customer_id, milestone)
```

RLS: select/insert/update/delete to `authenticated`, matching `ticket_notes`.
One row per customer per milestone, so the upsert target is the unique pair.

## UI — `TimelinesTab.tsx` + its own `Timelines.module.css`

**Own stylesheet, not `Customers.module.css`.** That module is 66KB across two
design regimes and a duplicate class name there silently loses to the later
block. A new tab has no reason to enter it.

- **Matrix** (default): one row per customer, one column per milestone. Each cell
  is a date, or an em-dash when neither derived nor manual has a value. A manual
  value is marked. Sortable by any milestone, searchable, and filterable to
  "machine owners only" / "missing a milestone".
- **Dates ⇄ Durations toggle**: the same grid showing days-since-previous-milestone
  instead of absolute dates, which is how a slow onboarding becomes visible.
- **Coverage strip**: per-milestone count of customers with a value, so the gaps
  in the integrations stay in the operator's face rather than buried.
- **Detail panel**, keyed by customer id: a vertical timeline of every dated
  thing — the six milestones with their source, plus every diagnosis call — with
  inline date edit per milestone. Keyed because an unkeyed panel carries the
  previous row's banner state to the next row clicked.
- **CSV export** of the matrix as rendered.

## Out of scope

- Editing diagnosis calls. They come from Fireflies; makeLILA reads them.
- Backfilling `first_use` from the 3M-row telemetry `events` table. A
  `min(created_at) group by serial` there is a 1.6s sequential scan — it needs a
  materialized first-seen column on the Lovely project, which is its own change.
- A Gantt view. The matrix answers the per-customer lookup; cohort drift is a
  separate question and the Profitability tab already has cohort charts.
