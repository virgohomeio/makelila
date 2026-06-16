# System of Record

> Decision committed 2026-05-27 by Huayi in response to Alpha Feedback P3 #8 (Pedrum's "platform overload" concern).
> Updated 2026-06-10 to reflect HubSpot decommission: makelila is now the single owner for all customer and deal data; HubSpot is an import-only seed source.

**makelila is the system of record for all internal operational data.** HubSpot, Shopify, Calendly, Klaviyo, OpenPhone/Quo, Resend, Gmail are **inputs** (seed data, event sources) — never authoritative on records that exist in makelila.

**HubSpot decommission note:** HubSpot is no longer a co-owner of any data type. All HubSpot syncs are insert-only: net-new customers are imported; existing makelila records are never overwritten. Lead attribution (`hs_analytics_source`) is populated once on first sync and then treated as makelila-owned. Deal stage is derived from makelila order status, not HubSpot deals.

## Per-data-type ownership

| Data type | System of record | Source / sync direction |
|---|---|---|
| Customer name | **makelila.customers** | HubSpot → makelila (import-only on first contact, never overwrite) |
| Customer email | **makelila.customers** | HubSpot → makelila (import-only on first contact, never overwrite) |
| Customer phone | **makelila.customers** | HubSpot → makelila (import-only on first contact, never overwrite) |
| Customer stage / disposition | **makelila (operators)** | Operators set this; HubSpot deal stage is ignored |
| Customer notes | **makelila.customers.fu_notes** | Operators only; no external source |
| Customer shipping address | **makelila.customers / orders** | Shopify (on order placement; subsequent syncs respect operator edits) |
| Lead attribution source | **makelila.customers.first_touch_source** | HubSpot → makelila (import-only, populate `hs_analytics_source` / `first_touch_source` on first sync; never overwrite) |
| Deal stage | **makelila (order status)** | Derived from makelila orders; HubSpot deals are not read after initial import |
| Onboarding date + follow-up status | **makelila.customers.onboard_date + fu1/fu2_status** | Calendly events (seed via `sync-calendly-events`) |
| Orders | **makelila.orders** | Shopify (sync IN); operator dispositions are makelila-authoritative |
| Order financial breakdown (subtotal, tax, discounts, methods) | **Shopify** (Shopify-side is canonical for what was charged); makelila mirrors for reporting | n/a — read-only mirror |
| Units (machines) lifecycle, QC, technician | **makelila.units** | none external — populated via Build module + Excel imports |
| Returns / refund approvals | **makelila.returns + refund_approvals** | Customer return form (Jotform → makelila) |
| Activity log | **makelila.activity_log** | All mutations call `logAction()` — no external source |
| Support tickets | **makelila.service_tickets** | Gmail (auto-import), operator manual entry, Quo (TBD); HubSpot legacy sync discontinued |
| Email send history | **makelila.email_messages** | Resend (transactional sends, logged back) |
| Email campaigns | **Klaviyo** | makelila pushes profiles/lists to Klaviyo; Klaviyo owns campaign send data |
| Ad performance | **Facebook Ads** | CAPI + Ads API sync IN to makelila for reporting; Facebook is authoritative on ad metrics |

## Sync direction summary

```
   ┌─────────────────────────┐
   │   external systems      │
   │  (HubSpot, Shopify,     │
   │   Calendly, Gmail,      │
   │   OpenPhone, Jotform)   │
   └───────────┬─────────────┘
               │   sync IN (insert + new-field-fill only,
               │              never clobber existing values)
               ▼
   ┌─────────────────────────┐
   │       makelila          │
   │   (source of truth)     │
   └───────────┬─────────────┘
               │   push OUT (optional, future):
               │     - Klaviyo: customer lists for marketing
               │     - Shopify: address fixes via operator (TBD if needed)
               ▼
   ┌─────────────────────────┐
   │   external systems      │
   └─────────────────────────┘
```

## Conflict-resolution rules

When a sync IN runs and finds an existing makelila record:

1. **Default: don't touch.** New rows insert; existing rows are left alone.
2. **Exception (orders pre-disposition):** orders still at `status='pending'` or `status='flagged'` are not yet operator-validated — Shopify wins for contact + address until operator approves or holds.
3. **Always-safe fields (never operator-edited):** placed_at, financial breakdown (subtotal/tax/discount/methods/financial_status), shipping cost. These refresh unconditionally from Shopify.

## How current syncs comply (as of 2026-06-10)

| Sync function | Behavior | Status |
|---|---|---|
| `sync-shopify-orders` | Refresh path freezes contact/address once operator dispositions (status leaves pending/flagged). Always-safe fields refresh unconditionally. | ✅ Compliant (commit 509c1e0) |
| `sync-hubspot-customers` | Insert net-new + fill blank columns on existing rows + refresh `last_synced_at`. Never overwrites a non-blank (operator-curated) value. `name`/`phone` are insert-only (guard in `upsertHubSpotContact`). | ✅ Compliant — insert-only guard enforced in `lib/customers.ts` |
| `sync-calendly-events` | Creates new onboarding tickets; doesn't write back to customers. | ✅ Compliant |
| `sync-gmail-tickets` | Append-only (each email creates a ticket; no overwrites). | ✅ Compliant |
| `sync-hubspot-tickets` | Legacy sync discontinued with HubSpot decommission. | ⛔ Discontinued |
| `push-shopify-fulfillments` | Writes OUT (makelila → Shopify). This is push direction, fine. | ✅ Compliant |

## Operator workflow implications

**To correct customer data:** Edit in makelila. Don't touch HubSpot/Shopify for record-keeping; those are now treated as external feeds.

**To pull fresh data from HubSpot for an existing customer:** The `⟳ Sync from HubSpot` button adds net-new customers and fills blank columns on existing rows, but never overwrites operator-curated values (`name`, `phone`, `address`, `notes`, `stage`). Since HubSpot is decommissioned as a co-owner, force-overwriting a makelila field from HubSpot must be done manually via SQL — there is no "Re-pull from HubSpot" button planned.

**To push customer-list to Klaviyo:** Use the `↓ Export CSV` buttons today; future Klaviyo integration will replace this with `↑ Push to Klaviyo list`.

**To get a Shopify address fix into a fulfilled order:** Edit in makelila. The push-to-Shopify direction is not built (and likely won't be unless operationally needed).

## Open questions

- `sync-hubspot-tickets` is discontinued. Confirm edge function is disabled or removed from cron.
- Monitor whether `first_touch_source` coverage improves over time now that HubSpot import-only semantics are codified.
- "Re-pull from HubSpot for one customer" — not planned; if needed, use SQL directly.
