import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const KLAVIYO_KEY = Deno.env.get('KLAVIYO_PRIVATE_KEY') ?? '';
const KLAVIYO_REV = '2024-10-15';

function klaviyoHeaders(): Record<string, string> {
  return {
    'Authorization': `Klaviyo-API-Key ${KLAVIYO_KEY}`,
    'revision': KLAVIYO_REV,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const admin = createClient(supabaseUrl, serviceKey);

  try { await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }

  const { event, email } = await req.json() as { event?: string; email?: string };
  if (!event || !email) {
    return new Response(JSON.stringify({ error: '`event` and `email` are required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // 1. Check if we already have a cached klaviyo_profile_id for this customer.
  const { data: customer } = await admin
    .from('customers')
    .select('id, klaviyo_profile_id')
    .eq('email', email)
    .maybeSingle();

  let profileId = customer?.klaviyo_profile_id as string | null;

  // 2. If not cached, resolve via Klaviyo Profiles API.
  if (!profileId) {
    const url = new URL('https://a.klaviyo.com/api/profiles/');
    url.searchParams.set('filter', `equals(email,"${email}")`);
    const profileRes = await fetch(url.toString(), {
      method: 'GET',
      headers: klaviyoHeaders(),
    });
    if (profileRes.ok) {
      const profileData = await profileRes.json() as { data?: Array<{ id: string }> };
      profileId = profileData.data?.[0]?.id ?? null;
    }
  }

  // 3. If profile found, write back the klaviyo_profile_id to customers table.
  if (profileId && customer?.id && !customer.klaviyo_profile_id) {
    await admin
      .from('customers')
      .update({ klaviyo_profile_id: profileId })
      .eq('id', customer.id);
  }

  // 4. Post the event to Klaviyo Events API.
  const eventPayload = {
    data: {
      type: 'event',
      attributes: {
        metric: { data: { type: 'metric', attributes: { name: event } } },
        profile: profileId
          ? { data: { type: 'profile', id: profileId } }
          : { data: { type: 'profile', attributes: { email } } },
        properties: {},
      },
    },
  };

  const evtRes = await fetch('https://a.klaviyo.com/api/events/', {
    method: 'POST',
    headers: klaviyoHeaders(),
    body: JSON.stringify(eventPayload),
  });

  if (!evtRes.ok) {
    const errText = await evtRes.text();
    console.error('Klaviyo events API error:', errText);
    return new Response(JSON.stringify({ error: 'Klaviyo events API error', detail: errText }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true, event, profile_id: profileId ?? null }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
