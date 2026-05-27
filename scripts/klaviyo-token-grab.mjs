#!/usr/bin/env node
// One-time OAuth helper: captures a Klaviyo refresh token for the makelila
// app. Mirror of scripts/shopify-token-grab.mjs.
//
// Klaviyo OAuth (2024+) requires authorization code flow with PKCE for any
// app that calls their public API. Once captured, the refresh token doesn't
// expire (unless explicitly revoked). Access tokens are short-lived; the
// edge functions exchange the refresh token for fresh access tokens on
// each invocation.
//
// Setup:
//   1. In the Klaviyo app settings (https://www.klaviyo.com/oauth/apps), add
//      `http://localhost:3457/callback` to the app's "Redirect URIs" list.
//   2. Export:
//        KLAVIYO_CLIENT_ID=c5c591eb-5bb1-4091-90e9-b28410a46796
//        KLAVIYO_CLIENT_SECRET=<paste your ROTATED secret here>
//        KLAVIYO_SCOPES=accounts:read profiles:read profiles:write lists:read lists:write
//             (default scopes cover the customer-list-push use case; add
//              campaigns:read campaigns:write if you want transactional later)
//   3. Run: node scripts/klaviyo-token-grab.mjs
//   4. Open the printed install URL in a browser logged in as a Klaviyo admin.
//   5. Approve. The script captures the code, exchanges it, prints the
//      refresh_token, and exits.
//   6. Set the secret on Supabase:
//        supabase secrets set KLAVIYO_REFRESH_TOKEN=<refresh_token>
//      (along with KLAVIYO_CLIENT_ID and KLAVIYO_CLIENT_SECRET)

import { createServer } from 'node:http';
import { URL } from 'node:url';
import crypto from 'node:crypto';

const PORT = 3457;
const CB_PATH = '/callback';

const clientId     = process.env.KLAVIYO_CLIENT_ID;
const clientSecret = process.env.KLAVIYO_CLIENT_SECRET;
const scopes       = process.env.KLAVIYO_SCOPES
  || 'accounts:read profiles:read profiles:write lists:read lists:write';

if (!clientId || !clientSecret) {
  console.error('Missing env vars:');
  if (!clientId)     console.error('  KLAVIYO_CLIENT_ID');
  if (!clientSecret) console.error('  KLAVIYO_CLIENT_SECRET');
  process.exit(1);
}

// PKCE: generate verifier + challenge
const verifier = crypto.randomBytes(64).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const state = crypto.randomBytes(16).toString('base64url');
const redirectUri = `http://localhost:${PORT}${CB_PATH}`;

const installUrl =
  `https://www.klaviyo.com/oauth/authorize?` +
  new URLSearchParams({
    client_id:             clientId,
    redirect_uri:          redirectUri,
    response_type:         'code',
    scope:                 scopes,
    state,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  }).toString();

console.log('\n────────────────────────────────────────────────────────────');
console.log('1. Open this URL in a browser logged into Klaviyo as admin:');
console.log('\n' + installUrl + '\n');
console.log('2. Approve the requested scopes.');
console.log('3. The script will capture the redirect and exit.');
console.log('────────────────────────────────────────────────────────────\n');
console.log(`Listening on ${redirectUri} …`);

const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (u.pathname !== CB_PATH) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }
  const code      = u.searchParams.get('code');
  const gotState  = u.searchParams.get('state');
  const err       = u.searchParams.get('error');

  if (err) {
    res.statusCode = 400;
    res.end(`Klaviyo error: ${err}. Check the terminal.`);
    console.error(`\nKlaviyo authorization error: ${err}`);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.statusCode = 400;
    res.end('Missing code in callback.');
    return;
  }
  if (gotState !== state) {
    res.statusCode = 400;
    res.end('State mismatch — possible CSRF. Re-run the script.');
    console.error('\nState mismatch:', { gotState, expected: state });
    server.close();
    process.exit(1);
  }

  // Exchange code for tokens. Klaviyo expects Basic auth with client creds.
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    redirect_uri:  redirectUri,
    code_verifier: verifier,
  }).toString();

  const tokenRes = await fetch('https://a.klaviyo.com/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basic}`,
    },
    body,
  });

  const text = await tokenRes.text();
  if (!tokenRes.ok) {
    res.statusCode = 502;
    res.end(`Token exchange failed (${tokenRes.status}). See terminal.`);
    console.error(`\nKlaviyo /oauth/token ${tokenRes.status}: ${text.slice(0, 500)}`);
    server.close();
    process.exit(1);
  }

  const tokens = JSON.parse(text);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<h1>Klaviyo authorized.</h1><p>You can close this window. Check the terminal for the refresh token.</p>');

  console.log('\n────────────────────────────────────────────────────────────');
  console.log('Authorization successful.');
  console.log('Refresh token (save this — set as KLAVIYO_REFRESH_TOKEN secret):');
  console.log('\n  ' + tokens.refresh_token);
  console.log('\nAccess token (short-lived; just for verification):');
  console.log('  ' + tokens.access_token);
  console.log('\nExpires in (seconds):', tokens.expires_in);
  console.log('Scopes granted:', tokens.scope);
  console.log('────────────────────────────────────────────────────────────\n');
  console.log('Next step:\n  supabase secrets set KLAVIYO_REFRESH_TOKEN=<paste> KLAVIYO_CLIENT_ID=' + clientId + ' KLAVIYO_CLIENT_SECRET=<your-secret> --project-ref txeftbbzeflequvrmjjr\n');

  server.close();
  // Give the response a moment to flush before exiting on Windows
  setTimeout(() => process.exit(0), 500);
});

server.listen(PORT);
