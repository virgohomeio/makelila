# Shopify Order Sync Setup

The "Sync from Shopify" button in Order Review invokes a Supabase Edge Function
(`sync-shopify-orders`) that fetches unfulfilled orders from the Shopify Admin
REST API and upserts them into our `orders` table.

## Prerequisites

You need a **Dev Dashboard app** (formerly "custom app" — Shopify deprecated
that path in January 2026) and a **non-expiring offline access token** for the
live store. The token is captured once via an OAuth handshake and stored as a
Supabase secret.

### 1. Create the app in the Dev Dashboard

1. Go to https://dev.shopify.com/dashboard → your organization → **Apps** →
   **Create app**.
2. Name it `Make Lila — Order Sync`.
3. Under **Configuration → Admin API access → Scopes**, grant:
   - `read_orders`
   - `read_customers`
4. Under **Configuration → Allowed redirection URLs**, add:
   `http://localhost:3456/callback`
5. Save.
6. Copy the **Client ID** and **Client Secret** from the app's **Overview** (or
   **API credentials**) page. Keep them in your password manager — treat the
   Client Secret like a password.

### 2. Run the one-time token-grab script

Set the three env vars (PowerShell):

```powershell
cd E:\Claude\makelila
$env:SHOPIFY_SHOP_DOMAIN = "lilacomposter.myshopify.com"
$env:SHOPIFY_CLIENT_ID = "<your client id>"
$env:SHOPIFY_CLIENT_SECRET = "<your client secret>"
node scripts/shopify-token-grab.mjs
```

The script:

- Prints an install URL
- Opens a local listener at `http://localhost:3456/callback`
- Waits for Shopify to redirect after install

Open the printed install URL in a browser where you're logged into the store as
a staff member with install permissions. Approve the permissions dialog. Your
browser redirects to the local callback; the script exchanges the code for an
offline access token and prints it to the terminal. Copy the token.

The token is **non-expiring** — you only run this flow once per store.

### 3. Set Supabase secrets

```powershell
cd E:\Claude\makelila
$env:SUPABASE_ACCESS_TOKEN = "<your supabase personal access token>"
.\app\node_modules\.bin\supabase.cmd secrets set `
  SHOPIFY_SHOP_DOMAIN=lilacomposter.myshopify.com `
  SHOPIFY_ADMIN_TOKEN=<paste the offline access token>
```

(`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by
the Supabase runtime — you don't set those.)

### 4. Deploy the function

```powershell
.\app\node_modules\.bin\supabase.cmd functions deploy sync-shopify-orders --project-ref txeftbbzeflequvrmjjr
```

Verify:
```powershell
.\app\node_modules\.bin\supabase.cmd functions list --project-ref txeftbbzeflequvrmjjr
```

Should show `sync-shopify-orders | ACTIVE`.

## Testing

Click **⟲ Sync from Shopify** at the top of the Order Review sidebar on
https://lila.vip/. The button shows "Syncing…" while the function runs, then
reports `N new · M refreshed · K not imported`. New rows appear via the
existing realtime subscription on `orders`. The button ticks its elapsed
seconds while it runs and gives up after 180s rather than staying disabled.

## Behavior

- A manual click is a **full** sync (every order, `status=any`); the 5-minute
  pg_cron job passes `{"incremental": true}` and looks back 10 minutes.
- Only imports US/CA orders (schema constraint). Everything else is reported
  under "not imported" — see below.
- Orders missing a customer phone get auto-flagged by the `orders` insert
  trigger (QUO — the team's messaging tool — requires a phone).
- `address_verdict` is heuristic (`apt`/`house`). Reviewers can adjust later.
- `quo_thread_url` is always null on import — set it manually if a QUO thread
  exists.
- Idempotent: `on conflict (order_ref) do nothing`.

## "Not imported" is not the same as "failed"

Every order Shopify returns that does not become a row is reported with a
reason, and the count in the header opens the list (ref, date, total, buyer,
line items). Only one of the four reasons is a fault:

| Reason | What it means |
| --- | --- |
| `no_shipping_address` | Shopify has no shipping address for the order at all. This is the normal shape of a **no-ship product** — the `$1.00 LILA Mini Reservation`, a subscription buyout. `orders.country` is `NOT NULL` with a `CHECK ('US','CA')`, so there is nowhere to put one. |
| `international` | Has a shipping address, but outside the US and Canada. |
| `missing_city` | US/CA address with no city — a malformed address in Shopify. |
| `db_error` | **A real failure.** The write was rejected; the detail carries the Postgres message. |

As of 2026-09-10 a full sync reports 31 not imported, 30 of them
`no_shipping_address`: 27 LILA Mini Reservations placed since 2026-08-14, plus
older `Subscription Buyout` orders. **makeLILA has no surface for either.** If
reservations are to be worked as pre-sale leads, that needs a home of its own —
importing them into the Sales queue would need `orders.country` to become
nullable and would put non-shippable $1 rows in a fulfilment queue.

## Rotating the token

If the offline token is leaked or compromised, uninstall the app in the Shopify
admin (Settings → Apps → Installed apps) and re-run the OAuth flow:

```powershell
node scripts/shopify-token-grab.mjs
```

Then `supabase secrets set SHOPIFY_ADMIN_TOKEN=<new token>` and re-deploy.

## Troubleshooting

- **Sync is slow / the button stays disabled**: it should finish in seconds. A
  full sync used to take ~70s because every order cost three DB round-trips
  awaited in turn; the writes are now pooled. If it creeps back up, check
  `DB_CONCURRENCY` in the function and the `function_edge_logs`
  `execution_time_ms` for `sync-shopify-orders`.
- **`Shopify 401`**: the admin token is wrong or the app was uninstalled.
  Re-run the token grab.
- **`Shopify 403` / `Not enough permissions`**: the app is missing a scope.
  Update scopes in the Dev Dashboard, reinstall the app (re-run the grab
  script), and re-set the secret.
- **Install page shows "Redirect URI not allowed"**: the Dev Dashboard's
  "Allowed redirection URLs" list doesn't include `http://localhost:3456/callback`.
  Add it and save.
- **Client credentials grant fails on the live store**: that flow only works
  for dev stores. Use this OAuth-based script for the live store.
