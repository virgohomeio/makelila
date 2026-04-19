#!/usr/bin/env node
// One-time OAuth helper: captures a permanent offline Shopify Admin API access
// token for a Dev Dashboard app installed on a live store. Run once per store.
//
// Setup:
//   1. In the Dev Dashboard, add http://localhost:3456/callback to the app's
//      "Allowed redirection URLs" and save.
//   2. Export:
//        SHOPIFY_SHOP_DOMAIN=<handle>.myshopify.com
//        SHOPIFY_CLIENT_ID=<client id>
//        SHOPIFY_CLIENT_SECRET=<client secret>
//        SHOPIFY_SCOPES=read_orders,read_customers   (optional; this is the default)
//   3. Run: node scripts/shopify-token-grab.mjs
//   4. Open the printed install URL in a browser (must be logged in as a
//      staff member with install rights on the store).
//   5. Approve the permissions dialog. The script captures the code,
//      exchanges it for a token, prints the token, and exits.

import { createServer } from 'node:http';
import { URL } from 'node:url';
import crypto from 'node:crypto';

const PORT = 3456;
const CB_PATH = '/callback';

const shop = process.env.SHOPIFY_SHOP_DOMAIN;
const clientId = process.env.SHOPIFY_CLIENT_ID;
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
const scopes = process.env.SHOPIFY_SCOPES || 'read_orders,read_customers';

if (!shop || !clientId || !clientSecret) {
  console.error('Missing env vars. Required:');
  console.error('  SHOPIFY_SHOP_DOMAIN (e.g. lilacomposter.myshopify.com)');
  console.error('  SHOPIFY_CLIENT_ID');
  console.error('  SHOPIFY_CLIENT_SECRET');
  process.exit(1);
}

const state = crypto.randomBytes(16).toString('hex');
const redirectUri = `http://localhost:${PORT}${CB_PATH}`;
const installUrl =
  `https://${shop}/admin/oauth/authorize` +
  `?client_id=${encodeURIComponent(clientId)}` +
  `&scope=${encodeURIComponent(scopes)}` +
  `&redirect_uri=${encodeURIComponent(redirectUri)}` +
  `&state=${state}`;

console.log('\n── Shopify offline-token grab ──');
console.log(`Shop:   ${shop}`);
console.log(`Scopes: ${scopes}`);
console.log(`Listening on ${redirectUri}`);
console.log('\nOpen this URL in your browser (must be logged into the store as staff):\n');
console.log(installUrl);
console.log('\nWaiting for Shopify to redirect back to the callback …\n');

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== CB_PATH) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const code = url.searchParams.get('code');
  const gotState = url.searchParams.get('state');
  const gotShop = url.searchParams.get('shop');

  if (!code || gotState !== state) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('Missing code or state mismatch. Re-run the script.');
    server.close();
    process.exit(1);
    return;
  }
  if (gotShop !== shop) {
    console.warn(`Warning: callback shop=${gotShop} does not match SHOPIFY_SHOP_DOMAIN=${shop}`);
  }

  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });
    const body = await tokenRes.text();
    if (!tokenRes.ok) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`Token exchange failed (${tokenRes.status}):\n${body}`);
      console.error(`\nToken exchange failed (${tokenRes.status}):\n${body}`);
      server.close();
      process.exit(1);
      return;
    }
    const parsed = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      '<!doctype html><meta charset=utf-8>' +
      '<title>Shopify token captured</title>' +
      '<body style="font-family:sans-serif;padding:40px;max-width:640px">' +
      '<h1 style="color:#276749">✓ Token captured</h1>' +
      '<p>Check the terminal. You can close this tab.</p>' +
      '</body>'
    );

    console.log('\n── Offline access token ──');
    console.log(parsed.access_token);
    console.log('\nScopes granted:', parsed.scope);
    console.log('\nNext step: set it as a Supabase secret (PowerShell):');
    console.log('');
    console.log('  cd E:\\Claude\\makelila');
    console.log('  $env:SUPABASE_ACCESS_TOKEN = "<your supabase PAT>"');
    console.log('  .\\app\\node_modules\\.bin\\supabase.cmd secrets set `');
    console.log(`    SHOPIFY_SHOP_DOMAIN=${shop} \``);
    console.log(`    SHOPIFY_ADMIN_TOKEN=${parsed.access_token}`);
    console.log('');
    console.log('Then deploy:');
    console.log('  .\\app\\node_modules\\.bin\\supabase.cmd functions deploy sync-shopify-orders --project-ref txeftbbzeflequvrmjjr');
    console.log('');
    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`Error: ${err.message}`);
    console.error('\nError during token exchange:', err);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {});
