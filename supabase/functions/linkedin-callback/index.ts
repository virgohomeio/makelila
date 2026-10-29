// linkedin-callback: OAuth redirect target. LinkedIn sends ?code here after
// consent; we exchange it for access (+ refresh, if the app is approved for it)
// tokens and store them (single row in linkedin_oauth). Public GET (registered
// redirect URI); state guard blocks random hits.
//
// Secrets: LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const REDIRECT_URI = 'https://txeftbbzeflequvrmjjr.supabase.co/functions/v1/linkedin-callback';
const STATE = 'makelila-linkedin-oauth-v1';

Deno.serve(async (req: Request) => {
  const u = new URL(req.url);
  const err = u.searchParams.get('error');
  if (err) return page(`LinkedIn returned an error: ${err} — ${u.searchParams.get('error_description') ?? ''}`);
  if (u.searchParams.get('state') !== STATE) return page('Invalid state parameter — start again from the connect link.');
  const code = u.searchParams.get('code');
  if (!code) return page('No authorization code in the request.');

  const clientId = Deno.env.get('LINKEDIN_CLIENT_ID');
  const clientSecret = Deno.env.get('LINKEDIN_CLIENT_SECRET');
  if (!clientId || !clientSecret) return page('LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET not set.');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
  });
  const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok || !data.access_token) {
    return page(`Token exchange failed: ${JSON.stringify(data).slice(0, 400)}`);
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const now = Date.now();
  const expiresAt = new Date(now + (Number(data.expires_in) || 0) * 1000).toISOString();
  const refreshExpiresAt = data.refresh_token_expires_in
    ? new Date(now + Number(data.refresh_token_expires_in) * 1000).toISOString()
    : null;
  const { error } = await admin.from('linkedin_oauth').upsert({
    id: 1,
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? null,
    expires_at: expiresAt,
    refresh_expires_at: refreshExpiresAt,
    scope: data.scope,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'id' });
  if (error) return page(`Saved token but DB write failed: ${error.message}`);

  const refreshNote = data.refresh_token ? '' : ' (no refresh token issued — token lasts ~60 days, then re-authorize)';
  return page(`LinkedIn connected. Token stored${refreshNote}. You can close this tab and tell Claude to run the sync.`);
});

function page(msg: string): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>LinkedIn connect</title><body style="font-family:system-ui;padding:40px;max-width:620px;margin:auto"><h2>makeLILA · LinkedIn</h2><p>${msg}</p></body>`, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
