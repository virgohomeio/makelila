# Shopify Order Sync Setup

The "Sync from Shopify" button in Order Review invokes a Supabase Edge Function
(`sync-shopify-orders`) that fetches unfulfilled orders from Shopify's Admin API
and upserts them into the `orders` table.

## Prerequisites

### 1. Create a Shopify custom app

1. Log in to https://admin.shopify.com/store/<your-store-handle>.
2. Go to **Settings → Apps and sales channels → Develop apps**. If prompted,
   click **Allow custom app development**.
3. Click **Create an app**. Name it `Make Lila — Order Sync`. Developer = the
   account you're logged in as.
4. Under **Configuration → Admin API integration**, click **Configure** and
   enable scopes:
   - `read_orders`
   - `read_customers` (needed because the customer payload is nested under
     each order and requires the scope to surface email/phone)
5. Save, then **Install app**. On the resulting page, reveal and copy the
   **Admin API access token** (starts with `shpat_...`). **This is shown only
   once** — store it in your password manager before navigating away.
6. Note your shop domain: `<your-store-handle>.myshopify.com`. This is the
   `SHOPIFY_SHOP_DOMAIN` env var; it's NOT your custom lila.vip domain.

### 2. Set secrets on the remote Supabase project

Run these in PowerShell (replace with real values):

```powershell
cd E:\Claude\makelila
$env:SUPABASE_ACCESS_TOKEN = "<your supabase personal access token>"
.\app\node_modules\.bin\supabase.cmd secrets set `
  SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com `
  SHOPIFY_ADMIN_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxx
```

(`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by
the Supabase runtime — you don't set those.)

### 3. Deploy the function

```powershell
.\app\node_modules\.bin\supabase.cmd functions deploy sync-shopify-orders --project-ref txeftbbzeflequvrmjjr
```

Verify:
```powershell
.\app\node_modules\.bin\supabase.cmd functions list --project-ref txeftbbzeflequvrmjjr
```

Should show `sync-shopify-orders | ACTIVE`.

## Testing

### Local (optional)

Local edge-function serving requires the Shopify token to be in your local
environment:

```bash
export SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com
export SHOPIFY_ADMIN_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxx
./app/node_modules/.bin/supabase functions serve sync-shopify-orders --env-file .env.local
```

Then in the app (served from `npm run dev`), click **Sync from Shopify**. The
app's `supabase.functions.invoke(...)` call goes to `http://127.0.0.1:54321`
which routes to the locally-served function.

### Remote (production)

Click the button on https://lila.vip/ — it invokes the deployed function.

## Behavior

- Fetches up to 50 open + unfulfilled orders per click (Shopify's default page
  size; we don't paginate yet).
- Only imports US/CA orders. Other countries are skipped with a reason.
- Orders missing a customer phone get auto-flagged by the DB trigger.
- `address_verdict` is heuristic (`apt`/`house`). Reviewers can adjust later.
- `quo_thread_url` is always null on import — set it manually if a QUO thread
  exists.
- Idempotent: clicking twice is safe (upsert with ignoreDuplicates).

## Troubleshooting

- **`Shopify 401`**: the admin token is wrong or missing. Re-check secrets.
- **`Shopify 403` / `Not enough permissions`**: the custom app is missing a
  scope. Edit scopes, reinstall, copy new token, re-set the secret.
- **Deploy fails with "Project ref not set"**: pass `--project-ref` explicitly
  as shown above.
- **`Invalid JWT`** in browser console: the app's session expired; sign out,
  sign back in, retry.
