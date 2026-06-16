import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const KLAVIYO_KEY = Deno.env.get('KLAVIYO_PRIVATE_KEY') ?? '';
const KLAVIYO_REV = '2024-10-15';

type CustomerRow = {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  stage: string | null;
  has_return: boolean;
  klaviyo_profile_id: string | null;
  last_fulfilled_at: string | null;
  first_order_at: string | null;
  order_count: number;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const authError = await authenticate(req);
  if (authError) return authError;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: customers, error: dbError } = await supabase
    .rpc('get_customers_for_klaviyo_sync');

  if (dbError) {
    console.error('DB error:', dbError);
    return new Response(JSON.stringify({ error: dbError.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const rows = (customers ?? []) as CustomerRow[];
  let profilesSent = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const profiles = batch.map(c => ({
      type: 'profile',
      attributes: {
        email: c.email,
        phone_number: c.phone ?? undefined,
        first_name: c.name?.split(' ')[0] ?? undefined,
        last_name: c.name?.split(' ').slice(1).join(' ') || undefined,
        properties: {
          lila_stage: c.stage,
          lila_has_return: c.has_return,
          lila_last_fulfilled_at: c.last_fulfilled_at,
          lila_first_order_at: c.first_order_at,
          lila_order_count: c.order_count,
        },
      },
      ...(c.klaviyo_profile_id ? { id: c.klaviyo_profile_id } : {}),
    }));

    const res = await fetch('https://a.klaviyo.com/api/profile-bulk-import-jobs/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_KEY}`,
        'revision': KLAVIYO_REV,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: {
          type: 'profile-bulk-import-job',
          attributes: { profiles: { data: profiles } },
        },
      }),
    });

    if (res.ok) {
      profilesSent += batch.length;
    } else {
      const errText = await res.text();
      console.error('Klaviyo batch error:', errText);
      errors += batch.length;
    }
  }

  await supabase.from('klaviyo_sync_log').insert({
    profiles_sent: profilesSent,
    errors,
    detail: errors > 0 ? `${errors} profiles failed` : null,
  });

  return new Response(JSON.stringify({ profiles_sent: profilesSent, errors }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
