import { corsHeaders } from '../_shared/cors.ts';

const VERIFY_TOKEN = Deno.env.get('FACEBOOK_WEBHOOK_VERIFY_TOKEN') ?? '';
const APP_SECRET   = Deno.env.get('FACEBOOK_APP_SECRET') ?? '';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method === 'GET') {
    const url       = new URL(req.url);
    const mode      = url.searchParams.get('hub.mode');
    const token     = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
      return new Response(challenge, { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  if (req.method === 'POST') {
    const sig  = req.headers.get('x-hub-signature-256') ?? '';
    const body = await req.text();

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(APP_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    const expected = 'sha256=' + Array.from(new Uint8Array(mac))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    if (sig !== expected) {
      return new Response('Invalid signature', { status: 401 });
    }

    const payload = JSON.parse(body);
    console.log('Facebook webhook event:', JSON.stringify(payload));

    return new Response('ok', { status: 200 });
  }

  return new Response('Method not allowed', { status: 405 });
});
