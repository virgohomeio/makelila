import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const PIXEL_ID  = Deno.env.get('FACEBOOK_PIXEL_ID') ?? '';
const FB_TOKEN  = Deno.env.get('FACEBOOK_SYSTEM_USER_TOKEN') ?? '';
const API_VER   = 'v19.0';
const TEST_CODE = Deno.env.get('FACEBOOK_TEST_EVENT_CODE') ?? '';

type CAPIPayload = {
  event_name: string;
  event_time: number;
  email?: string;
  phone?: string;
  name?: string;
  value?: number;
  currency?: string;
  order_id?: string;
  event_id?: string;
};

async function sha256(value: string): Promise<string> {
  const normalized = value.trim().toLowerCase();
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(normalized),
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const admin = createClient(supabaseUrl, serviceKey);

  try { await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }

  const body = await req.json() as CAPIPayload;

  const userData: Record<string, string> = {};
  if (body.email) userData['em'] = await sha256(body.email);
  if (body.phone) userData['ph'] = await sha256(body.phone.replace(/\D/g, ''));
  if (body.name) {
    const parts = body.name.trim().split(' ');
    if (parts[0]) userData['fn'] = await sha256(parts[0]);
    if (parts.length > 1) userData['ln'] = await sha256(parts.slice(1).join(' '));
  }

  const event: Record<string, unknown> = {
    event_name:    body.event_name,
    event_time:    body.event_time,
    action_source: 'system_generated',
    user_data:     userData,
    event_id:      body.event_id,
  };

  if (body.value != null && body.currency) {
    event['custom_data'] = {
      value:    body.value.toFixed(2),
      currency: body.currency.toUpperCase(),
      order_id: body.order_id,
    };
  }

  const url = new URL(`https://graph.facebook.com/${API_VER}/${PIXEL_ID}/events`);
  url.searchParams.set('access_token', FB_TOKEN);

  const fbBody: Record<string, unknown> = { data: [event] };
  if (TEST_CODE) fbBody['test_event_code'] = TEST_CODE;

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fbBody),
  });

  const result = await res.json();

  if (!res.ok) {
    console.error('Facebook CAPI error:', JSON.stringify(result));
    return new Response(JSON.stringify({ error: result }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify(result), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
