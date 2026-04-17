# VirgoSync — Apps Script Sync Layer

Google Apps Script that turns the VirgoHome Operations Hub Google Sheet into a near-real-time operational console, wired to Shopify and HubSpot.

Closes three of the hard architectural limits flagged in `architecture.md`:
1. No real-time sync → Shopify webhook pushes new orders in < 5s.
2. No event-driven triggers → `onEdit` pushes fulfillment + tracking back to Shopify automatically.
3. Manual HubSpot cross-reference → scheduled ticket sync updates the Serial Tracker tab every 15 min.

---

## What it does

| Flow | Direction | Trigger | Latency |
|---|---|---|---|
| New Shopify order → Sales Orders row | Shopify → Sheet | webhook (`orders/create`) | ~1–5 sec |
| Missed-webhook safety net | Shopify → Sheet | time trigger, every 15 min | ≤ 15 min |
| HubSpot ticket cross-reference | HubSpot → Serial Tracker | time trigger, every 15 min | ≤ 15 min |
| Sheet edit (Shipped Date + Tracking #) → Shopify fulfillment + customer email | Sheet → Shopify | `onEdit` | ~2 sec |

Idempotent: webhook replays and backfill runs both upsert by Shopify order number, so no dup rows.

---

## Setup (one time, ~10 minutes)

### 1. Create the Shopify private app
Shopify Admin → Settings → Apps and sales channels → Develop apps → Create app.
Grant scopes: `read_orders`, `write_orders`, `read_fulfillments`, `write_fulfillments`, `read_customers`.
Install the app; copy the **Admin API access token** (starts with `shpat_`).

### 2. Create the HubSpot private app
HubSpot → Settings → Integrations → Private Apps → Create.
Scopes: `tickets` (read), `crm.objects.contacts.read`.
Copy the token (starts with `pat-`).

### 3. Paste the script
- Open the Google Sheet → Extensions → Apps Script.
- Replace `Code.gs` contents with `VirgoSync.gs`.
- Save.

### 4. Run `setCredentials` once
Edit the `setCredentials` function body first — paste in your four values:
- `SHOPIFY_DOMAIN` (e.g. `lilacomposter.myshopify.com`)
- `SHOPIFY_ACCESS_TOKEN`
- `SHOPIFY_WEBHOOK_SECRET` (Shopify Admin → Settings → Notifications → "Webhooks" → your secret)
- `HUBSPOT_TOKEN`

Then: in the Apps Script editor, select `setCredentials` in the function dropdown → Run. Authorize when prompted.

### 5. Deploy as Web App
Deploy → New deployment → Web app.
- Execute as: Me (you)
- Who has access: Anyone (required — Shopify's webhook caller is anonymous; HMAC protects against abuse)

Copy the `/exec` URL it generates.

### 6. Register the webhook
Back in the sheet: `VirgoSync` menu → `3. Register Shopify webhook`. This calls Shopify's Admin API and points `orders/create` at the web-app URL.

### 7. Install triggers
`VirgoSync` menu → `2. Install triggers`. Sets up the 15-min backfill, the HubSpot sync, and the onEdit fulfillment push.

Done. Place a test order in Shopify — a new row should appear in Sales Orders within seconds.

---

## Security notes

- **HMAC verification** runs on every webhook POST. An attacker hitting the `/exec` URL with a forged payload is rejected by `verifyShopifyHmac_`.
- **Credentials live in Script Properties**, never in code. Don't commit a filled-in `setCredentials` to git.
- **Least-privilege scopes** — only grant the Shopify/HubSpot scopes listed above. Never grant `read_all_orders` unless you need historical data.
- **Apps Script quotas**: 20K URL-fetch calls/day on a free Workspace, 100K on paid. At VirgoHome's ~50 SO/month, you'd consume < 1% of quota.

---

## Extending this

The same pattern generalizes to every gap in `architecture.md §5.1`:

| Gap | Add-on approach |
|---|---|
| Inventory auto-decrement | Shopify webhook `inventory_levels/update` → write Inventory!F (Committed Qty) |
| PO auto-create from low stock | Time trigger reads `Inventory!U = "ORDER NOW"` → POST draft PO to QuickBooks |
| Audit trail | `onEdit` logs {user, cell, old, new, timestamp} to a hidden "AuditLog" sheet |
| Return-to-stock | Shopify `refunds/create` webhook → increment `Inventory!E`, set `SO!T = "Returned"` |

Each hook is ~30 lines of Apps Script and uses the same Script Properties + LockService scaffolding.

What Apps Script *still can't* do (the remaining hard limits): barcode scanning, multi-user concurrent writes to the same cell under heavy load, mobile-optimized picker UI, BOM auto-explosion across deep trees, and first-class role-based views. Those remain genuine Katana-class problems.

---

## Files

- `VirgoSync.gs` — the full script (~380 lines, 6 sections: setup, Shopify→Sheet webhook, backfill, HubSpot sync, Sheet→Shopify fulfillment, utilities).
- `README.md` — this file.
