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
reports `N new · M skipped`. New rows appear via the existing realtime
subscription on `orders`.

## Behavior

- Fetches up to 50 open + unfulfilled orders per click.
- Only imports US/CA orders (schema constraint). Others are counted as skipped.
- Orders missing a customer phone get auto-flagged by the `orders` insert
  trigger (QUO — the team's messaging tool — requires a phone).
- `address_verdict` is heuristic (`apt`/`house`). Reviewers can adjust later.
- `quo_thread_url` is always null on import — set it manually if a QUO thread
  exists.
- Idempotent: `on conflict (order_ref) do nothing`.

## Rotating the token

If the offline token is leaked or compromised, uninstall the app in the Shopify
admin (Settings → Apps → Installed apps) and re-run the OAuth flow:

```powershell
node scripts/shopify-token-grab.mjs
```

Then `supabase secrets set SHOPIFY_ADMIN_TOKEN=<new token>` and re-deploy.

## Troubleshooting

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
