// tiktok-callback: OAuth redirect target. TikTok sends ?code here after consent;
// we exchange it for access + refresh tokens and store them (single row in
// tiktok_oauth) for sync-tiktok-organic to use + refresh. Shows a plain page.
//
// Public GET endpoint (verify_jwt=false) — it's the registered redirect URI.
// The `state` guard blocks random hits; a bad code just fails the exchange.
// Secrets: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET (+ auto SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const REDIRECT_URI = 'https://txeftbbzeflequvrmjjr.supabase.co/functions/v1/tiktok-callback';
const STATE = 'makelila-tiktok-oauth-v1';

Deno.serve(async (req: Request) => {
  const u = new URL(req.url);
  const err = u.searchParams.get('error');
  if (err) return page(`TikTok returned an error: ${err} — ${u.searchParams.get('error_description') ?? ''}`);
  if (u.searchParams.get('state') !== STATE) return page('Invalid state parameter — start again from the connect link.');
  const code = u.searchParams.get('code');
  if (!code) return page('No authorization code in the request.');

  const clientKey = Deno.env.get('TIKTOK_CLIENT_KEY');
  const clientSecret = Deno.env.get('TIKTOK_CLIENT_SECRET');
  if (!clientKey || !clientSecret) return page('TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET not set.');

  const body = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  });
  const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok || data.error || !data.access_token) {
    return page(`Token exchange failed: ${JSON.stringify(data).slice(0, 400)}`);
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const expiresAt = new Date(Date.now() + (Number(data.expires_in) || 0) * 1000).toISOString();
  const { error } = await admin.from('tiktok_oauth').upsert({
    id: 1,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: expiresAt,
    open_id: data.open_id,
    scope: data.scope,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'id' });
  if (error) return page(`Saved token but DB write failed: ${error.message}`);

  return page('TikTok connected. Token stored. You can close this tab and tell Claude to run the sync.');
});

function page(msg: string): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>TikTok connect</title><body style="font-family:system-ui;padding:40px;max-width:620px;margin:auto"><h2>makeLILA · TikTok</h2><p>${msg}</p></body>`, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
