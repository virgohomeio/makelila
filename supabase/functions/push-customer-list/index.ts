// push-customer-list: send a filtered customer list to a Klaviyo list.
//
// Alpha P3 #9. Replaces the CSV-download flow with direct Klaviyo push so
// Pedrum's webinar/marketing invites don't need manual upload.
//
// Body shape:
//   {
//     list_id:  "RabcDef",
//     filter:   "all_purchasers" | "minus_refunds"
//   }
//
// Env (all required):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   KLAVIYO_CLIENT_ID, KLAVIYO_CLIENT_SECRET, KLAVIYO_REFRESH_TOKEN
//
// makelila is the system of record (docs/system-of-record.md); Klaviyo is
// a downstream destination. This function is one-way push — we never pull
// profile data BACK from Klaviyo into makelila.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';

type PushInput = {
  list_id: string;
  filter: 'all_purchasers' | 'minus_refunds';
};

type CustomerRow = {
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  address_line: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  onboard_date: string | null;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  try { return await handle(req); }
  catch (err) {
    return j({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const clientId    = Deno.env.get('KLAVIYO_CLIENT_ID');
  const clientSecret = Deno.env.get('KLAVIYO_CLIENT_SECRET');
  const refreshToken = Deno.env.get('KLAVIYO_REFRESH_TOKEN');
  if (!supabaseUrl || !serviceKey) return j({ error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' }, 500);
  if (!clientId || !clientSecret || !refreshToken) {
    return j({
      error: 'Klaviyo not configured. Set KLAVIYO_CLIENT_ID + KLAVIYO_CLIENT_SECRET + KLAVIYO_REFRESH_TOKEN via supabase secrets set. See scripts/klaviyo-token-grab.mjs.',
    }, 500);
  }

  const { list_id, filter } = (await req.json()) as PushInput;
  if (!list_id) return j({ error: 'list_id required' }, 400);
  if (filter !== 'all_purchasers' && filter !== 'minus_refunds') {
    return j({ error: `invalid filter: ${filter}` }, 400);
  }

  const admin = createClient(supabaseUrl, serviceKey);

  // 1. Build the same "purchasers" set the CSV export uses.
  const [{ data: orderEmails }, { data: unitNames }] = await Promise.all([
    admin.from('orders').select('customer_email').not('customer_email', 'is', null),
    admin.from('units').select('customer_name').eq('status', 'shipped'),
  ]);
  const purchaserEmails = new Set<string>();
  const purchaserNames  = new Set<string>();
  for (const r of (orderEmails ?? []) as { customer_email: string | null }[]) {
    if (r.customer_email) purchaserEmails.add(r.customer_email.toLowerCase().trim());
  }
  for (const r of (unitNames ?? []) as { customer_name: string | null }[]) {
    if (r.customer_name) purchaserNames.add(r.customer_name.toLowerCase().trim());
  }

  const refundedEmails = new Set<string>();
  const refundedNames  = new Set<string>();
  if (filter === 'minus_refunds') {
    const { data: refunds } = await admin
      .from('refund_approvals')
      .select('returns(customer_email, customer_name)')
      .eq('status', 'refunded');
    const arr = (refunds ?? []) as Array<{
      returns: Array<{ customer_email: string | null; customer_name: string | null }>
              | { customer_email: string | null; customer_name: string | null } | null;
    }>;
    for (const r of arr) {
      const rets = Array.isArray(r.returns) ? r.returns : r.returns ? [r.returns] : [];
      for (const ret of rets) {
        if (ret.customer_email) refundedEmails.add(ret.customer_email.toLowerCase().trim());
        if (ret.customer_name)  refundedNames.add(ret.customer_name.toLowerCase().trim());
      }
    }
  }

  const { data: customers, error: cErr } = await admin
    .from('customers')
    .select('email, first_name, last_name, full_name, phone, address_line, city, region, postal_code, country, onboard_date')
    .order('full_name', { ascending: true });
  if (cErr) return j({ error: `Customer load: ${cErr.message}` }, 500);

  let excluded = 0;
  const rows: CustomerRow[] = [];
  for (const c of (customers ?? []) as Array<CustomerRow & { full_name: string | null }>) {
    if (!c.email) continue;  // Klaviyo requires email
    const emailKey = c.email.toLowerCase().trim();
    const nameKey  = c.full_name?.toLowerCase().trim() ?? '';
    const isPurchaser =
      purchaserEmails.has(emailKey) ||
      (nameKey && purchaserNames.has(nameKey));
    if (!isPurchaser) continue;
    if (filter === 'minus_refunds') {
      const refunded =
        refundedEmails.has(emailKey) ||
        (nameKey && refundedNames.has(nameKey));
      if (refunded) { excluded++; continue; }
    }
    rows.push(c);
  }

  const diag = {
    order_emails_loaded:     purchaserEmails.size,
    shipped_unit_names_loaded: purchaserNames.size,
    customers_loaded:        (customers ?? []).length,
    customers_with_email:    (customers ?? []).filter((c: { email: string | null }) => !!c.email).length,
    matched_purchasers:      rows.length,
    excluded_refunded:       excluded,
  };

  if (rows.length === 0) {
    return j({ pushed: 0, excluded, diag, message: 'No purchaser customers matched the filter.' });
  }

  // 2. Mint a fresh access token via refresh_token grant.
  const basic = btoa(`${clientId}:${clientSecret}`);
  const tokenRes = await fetch('https://a.klaviyo.com/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    return j({ error: `Klaviyo /oauth/token ${tokenRes.status}: ${body.slice(0, 400)}` }, 502);
  }
  const tokens = await tokenRes.json() as { access_token: string };

  // 3. Bulk subscribe profiles to the list. Klaviyo API JSON:API spec:
  //    POST /api/profile-subscription-bulk-create-jobs/
  //    Body: { data: { type: 'profile-subscription-bulk-create-job',
  //                    attributes: { profiles: { data: [...] },
  //                                  custom_source: 'makelila push' },
  //                    relationships: { list: { data: { type: 'list', id: '...' } } } } }
  //
  // Each profile entry under attributes.profiles.data[*]:
  //    { type: 'profile', attributes: { email, phone_number, first_name, last_name, location:{...} } }
  //
  // Klaviyo caps each job at 1000 profiles; chunk if needed.
  const CHUNK = 1000;
  let pushedTotal = 0;
  const failures: Array<{ chunk: number; error: string }> = [];

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const profilesData = chunk.map(r => ({
      type: 'profile',
      attributes: {
        email:        r.email,
        phone_number: r.phone ?? undefined,
        first_name:   r.first_name ?? undefined,
        last_name:    r.last_name ?? undefined,
        location:     (r.address_line || r.city || r.region || r.postal_code || r.country) ? {
          address1:    r.address_line ?? undefined,
          city:        r.city ?? undefined,
          region:      r.region ?? undefined,
          zip:         r.postal_code ?? undefined,
          country:     r.country ?? undefined,
        } : undefined,
        properties: {
          ...(r.onboard_date ? { onboard_date: r.onboard_date } : {}),
          source: 'makelila',
        },
      },
    }));

    const pushBody = {
      data: {
        type: 'profile-subscription-bulk-create-job',
        attributes: {
          profiles: { data: profilesData },
          custom_source: 'makelila push-customer-list',
        },
        relationships: {
          list: { data: { type: 'list', id: list_id } },
        },
      },
    };

    const pushRes = await fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`,
        'Content-Type':  'application/json',
        'revision':      '2024-10-15',
        'Accept':        'application/json',
      },
      body: JSON.stringify(pushBody),
    });

    if (pushRes.status === 202 || pushRes.status === 201) {
      pushedTotal += chunk.length;
    } else {
      const body = await pushRes.text();
      failures.push({ chunk: i / CHUNK, error: `${pushRes.status}: ${body.slice(0, 300)}` });
    }
  }

  return j({
    pushed:    pushedTotal,
    excluded:  excluded,
    failures:  failures.length > 0 ? failures : undefined,
    diag,
    list_id,
    filter,
  });
}

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
