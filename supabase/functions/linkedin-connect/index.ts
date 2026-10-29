// linkedin-connect: one-time OAuth kickoff. Open in a browser signed in as a
// Page admin; 302-redirects to LinkedIn's consent screen, building the authorize
// URL from LINKEDIN_CLIENT_ID server-side. After consent → linkedin-callback.
//
// Secrets: LINKEDIN_CLIENT_ID, optional LINKEDIN_SCOPES
// (default "r_organization_social r_organization_admin").

const REDIRECT_URI = 'https://txeftbbzeflequvrmjjr.supabase.co/functions/v1/linkedin-callback';
const STATE = 'makelila-linkedin-oauth-v1';

Deno.serve(() => {
  const clientId = Deno.env.get('LINKEDIN_CLIENT_ID');
  if (!clientId) return new Response('LINKEDIN_CLIENT_ID not set', { status: 400 });
  const scopes = Deno.env.get('LINKEDIN_SCOPES') ?? 'r_organization_social r_organization_admin';
  const url = 'https://www.linkedin.com/oauth/v2/authorization?response_type=code'
    + `&client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + `&state=${STATE}`
    + `&scope=${encodeURIComponent(scopes)}`;
  return new Response(null, { status: 302, headers: { Location: url } });
});
