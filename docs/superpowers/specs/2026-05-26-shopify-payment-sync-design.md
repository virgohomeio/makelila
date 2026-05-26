# Shopify Payment Summary Sync — Design

> Alpha-feedback P1 #4. Source: Pedrum (May 26 email thread).

**Goal:** Sync the full Shopify payment breakdown into `orders` so OrderReview can display Subtotal / Discount / Tax / Shipping / Total + payment method + financial status. Read-only; no refund tracking (that's P1 #2's job).

## Schema

New nullable columns on `public.orders`:

| Column                | Type           | Source (Shopify REST 2024-10)              |
|-----------------------|----------------|--------------------------------------------|
| `subtotal_usd`        | numeric(10,2)  | `subtotal_price`                           |
| `tax_usd`             | numeric(10,2)  | `total_tax`                                |
| `discount_total_usd`  | numeric(10,2)  | `total_discounts`                          |
| `discount_codes`      | text[]         | `discount_codes[].code`                    |
| `payment_methods`     | text[]         | `payment_gateway_names`                    |
| `financial_status`    | text           | `financial_status` (paid/refunded/etc)     |

Shipping (`freight_estimate_usd`) and total (`total_usd`) already exist — no new columns.

## Edge function

`supabase/functions/sync-shopify-orders/index.ts`:
- Extend `ShopifyOrder` type with the 6 source fields
- Extend `MappedOrder` + `mapOrder()` with the 6 destination fields
- **Backfill**: extend the "refresh existing rows" update branch with the 6 new fields, so clicking ⟲ Sync repopulates historical orders

No new Shopify scopes required — all fields ship under existing `read_orders`.

## Frontend

`app/src/lib/orders.ts`:
- Extend `Order` type with 6 nullable fields

`app/src/modules/OrderReview/detail/LineItemsCard.tsx`:
- Replace the single Total row in `<tfoot>` with the full breakdown: Subtotal, Discount (with codes), Tax, Shipping, Total
- Hide rows where the value is null/zero (so older orders without backfilled data don't show empty lines)
- Add a small payment-method + status chip line below the table

No new component file; no other modules touched.

## Out of scope

- Refund amount tracking (belongs to P1 #2 Returns & Refunds Overhaul)
- Multi-currency display (Shopify returns USD for our shop)
- Per-line-item discount allocation
