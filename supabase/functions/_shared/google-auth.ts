// Mint a short-lived Google OAuth2 access token from a service-account JSON via
// the JWT-bearer grant. Shared by the GA4 + Search Console pulls. Signs the JWT
// with RS256 using Web Crypto (no external deps).
//
// The service account JSON is read from a secret (GOOGLE_SERVICE_ACCOUNT_JSON);
// parse it and pass the object here with the scopes you need.

export type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

export async function getGoogleAccessToken(sa: ServiceAccount, scopes: string[]): Promise<string> {
  if (!sa?.client_email || !sa?.private_key) {
    throw new Error('Service account JSON missing client_email / private_key');
  }
  const tokenUri = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: scopes.join(' '),
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claim}`;

  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${b64urlBytes(new Uint8Array(sig))}`;

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Google token ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.access_token as string;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const b64 = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function b64url(s: string): string {
  return b64urlBytes(new TextEncoder().encode(s));
}

function b64urlBytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
