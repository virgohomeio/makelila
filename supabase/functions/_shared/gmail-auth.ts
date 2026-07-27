// Extracted from sync-gmail-tickets/index.ts so a second consumer
// (sync-hiring-applications) doesn't duplicate the JWT-bearer token mint.
// Mirrors the precedent set by _shared/google-calendar.ts (originally
// inlined in sync-calendly-events, extracted for the same reason).

import { SignJWT, importPKCS8 } from 'https://esm.sh/jose@5.9.6';

export type ServiceAccountKey = {
  client_email: string;
  private_key: string;
  token_uri: string;
};

export async function getGmailAccessToken(
  saKey: ServiceAccountKey, delegatedSubject: string, scopes: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const privateKey = await importPKCS8(saKey.private_key, 'RS256');
  const assertion = await new SignJWT({ scope: scopes })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(saKey.client_email)
    .setSubject(delegatedSubject)
    .setAudience(saKey.token_uri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const res = await fetch(saKey.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = await res.json() as { access_token?: string };
  if (!json.access_token) throw new Error('Google token endpoint returned no access_token');
  return json.access_token;
}
