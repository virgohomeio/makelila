// tiktok-connect: one-time OAuth kickoff. Open this URL in a browser (signed in
// as the target TikTok account) and it 302-redirects to TikTok's consent screen,
// building the authorize URL from TIKTOK_CLIENT_KEY server-side (the key never
// leaves the function). After consent, TikTok redirects to tiktok-callback.
//
// Public GET endpoint (verify_jwt=false): it only forwards to TikTok and leaks
// nothing. Secrets: TIKTOK_CLIENT_KEY.

const REDIRECT_URI = 'https://txeftbbzeflequvrmjjr.supabase.co/functions/v1/tiktok-callback';
const SCOPE = 'user.info.basic,user.info.stats,video.list';
const STATE = 'makelila-tiktok-oauth-v1';

Deno.serve(() => {
  const clientKey = Deno.env.get('TIKTOK_CLIENT_KEY');
  if (!clientKey) return new Response('TIKTOK_CLIENT_KEY not set', { status: 400 });
  const url = 'https://www.tiktok.com/v2/auth/authorize/'
    + `?client_key=${encodeURIComponent(clientKey)}`
    + `&scope=${encodeURIComponent(SCOPE)}`
    + '&response_type=code'
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + `&state=${STATE}`;
  return new Response(null, { status: 302, headers: { Location: url } });
});
