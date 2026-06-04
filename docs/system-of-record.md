# System of Record

> Decision committed 2026-05-27 by Huayi in response to Alpha Feedback P3 #8 (Pedrum's "platform overload" concern).

**makelila is the system of record for all internal operational data.** HubSpot, Shopify, Calendly, Klaviyo, OpenPhone/Quo, Resend, Gmail are **inputs** (seed data, event sources) — never authoritative on records that exist in makelila.

## Per-data-type ownership

| Data type | System of record | Inputs (sync IN, never overwrite) |
|---|---|---|
| Customer email + phone | **makelila.customers** | HubSpot (seed only), Shopify (orders only) |
| Customer shipping address | **makelila.customers / orders** | Shopify (on order placement; future syncs respect operator edits) |
| Operator notes on a customer | **makelila.customers.fu_notes** | none |
| Onboarding date + follow-up status | **makelila.customers.onboard_date + fu1/fu2_status** | Calendly events (seed via `sync-calendly-events`) |
| Orders | **makelila.orders** | Shopify (sync IN); operator dispositions are makelila-authoritative |
| Order financial breakdown (subtotal, tax, discounts, methods) | **Shopify** (Shopify-side is canonical for what was charged); makelila mirrors for reporting | n/a — read-only mirror |
| Units (machines) lifecycle, QC, technician | **makelila.units** | none external — populated via Build module + Excel imports |
| Returns / refund approvals | **makelila.returns + refund_approvals** | Customer return form (Jotform → makelila) |
| Support tickets | **makelila.service_tickets** | Gmail (auto-import), HubSpot (legacy sync), operator manual entry, Quo (TBD) |
| Email send history | **makelila.email_messages** | Resend (transactional sends, logged back) |
| Marketing email lists | **Klaviyo** (when integrated) | makelila pushes lists to Klaviyo via "Export to Klaviyo" |

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

## How current syncs comply (as of 2026-05-27)

| Sync function | Behavior | Status |
|---|---|---|
| `sync-shopify-orders` | Refresh path freezes contact/address once operator dispositions (status leaves pending/flagged). Always-safe fields refresh unconditionally. | ✅ Compliant (commit 509c1e0) |
| `sync-hubspot-customers` | Insert net-new + **fill blank columns** on existing rows + refresh `last_synced_at` every run. Never overwrites a non-blank (operator-curated) value. | ✅ Compliant — matches "insert + new-field-fill only" rule |
| `sync-calendly-events` | Creates new onboarding tickets; doesn't write back to customers. | ✅ Compliant |
| `sync-gmail-tickets` | Append-only (each email creates a ticket; no overwrites). | ✅ Compliant |
| `sync-hubspot-tickets` | TBD — should verify same insert-only behavior. | ⚠ Audit needed |
| `push-shopify-fulfillments` | Writes OUT (makelila → Shopify). This is push direction, fine. | ✅ Compliant |

## Operator workflow implications

**To correct customer data:** Edit in makelila. Don't touch HubSpot/Shopify for record-keeping; those are now treated as external feeds.

**To pull fresh data from HubSpot for an existing customer:** The default `⟳ Sync from HubSpot` adds net-new customers and **fills any blank columns** on existing rows (e.g. a missing phone), but never overwrites a value that's already populated. To force-overwrite a non-blank field that an operator changed, do it manually via SQL (or a forthcoming "Re-pull from HubSpot" button).

**To push customer-list to Klaviyo:** Use the `↓ Export CSV` buttons today; future Klaviyo integration will replace this with `↑ Push to Klaviyo list`.

**To get a Shopify address fix into a fulfilled order:** Edit in makelila. The push-to-Shopify direction is not built (and likely won't be unless operationally needed).

## Open questions

- HubSpot tickets: should we audit `sync-hubspot-tickets` for the same insert-only behavior? Probably yes — task added to backlog.
- "Re-pull from HubSpot for one customer" button — TBD, only needed if operators report missing updates.
