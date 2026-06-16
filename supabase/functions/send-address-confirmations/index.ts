// send-address-confirmations: cron-callable function that queries new orders
// needing an address confirmation email and dispatches them via Resend.
// Schedule: every 30 minutes via pg_cron.
// Stamps address_confirmation_sent_at after each successful send.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { authenticate } from '../_shared/auth.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function j(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  });
}

function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const supabaseUrl  = Deno.env.get('SUPABASE_URL');
  const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const resendKey    = Deno.env.get('RESEND_API_KEY');
  const appBaseUrl   = Deno.env.get('APP_BASE_URL') ?? 'https://lila.vip';

  if (!supabaseUrl || !serviceKey || !resendKey) {
    return j({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / RESEND_API_KEY' }, 500);
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  try { await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }

  // Fetch the address_confirmation template once.
  const { data: tpl, error: tplErr } = await admin
    .from('email_templates')
    .select('subject, body')
    .eq('key', 'address_confirmation')
    .maybeSingle();
  if (tplErr || !tpl) return j({ error: tplErr?.message ?? 'Template not found' }, 500);

  // Query orders that: have a customer email, were placed in the last 48h,
  // and haven't had a confirmation email sent yet.
  const cutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const { data: orders, error: ordErr } = await admin
    .from('orders')
    .select('id, order_ref, customer_name, customer_email, address_line, city, region_state, address_customer_postal, country')
    .is('address_confirmation_sent_at', null)
    .not('customer_email', 'is', null)
    .gte('placed_at', cutoff)
    .in('status', ['pending', 'approved', 'flagged'])
    .order('placed_at', { ascending: true })
    .limit(50);

  if (ordErr) return j({ error: ordErr.message }, 500);
  if (!orders || orders.length === 0) return j({ sent: 0 });

  const fromAddress = 'LILA Team <hello@lila.vip>';
  const results: { order_ref: string; ok: boolean; error?: string }[] = [];

  for (const o of orders) {
    const vars = {
      customer_first_name: (o.customer_name as string).split(' ')[0] || 'there',
      order_ref: o.order_ref as string,
      address_line: (o.address_line as string | null) ?? '',
      city: (o.city as string | null) ?? '',
      region_state: (o.region_state as string | null) ?? '',
      postal: (o.address_customer_postal as string | null) ?? '',
      country: (o.country as string | null) ?? '',
      confirm_url: `${appBaseUrl}/confirm-address?order_id=${o.id}`,
    };

    const subject = renderTemplate(tpl.subject as string, vars);
    const body    = renderTemplate(tpl.body as string, vars);

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromAddress,
        to: [o.customer_email as string],
        subject,
        text: body,
      }),
    });

    if (!resendRes.ok) {
      const err = await resendRes.text();
      results.push({ order_ref: o.order_ref as string, ok: false, error: err.slice(0, 200) });
      continue;
    }

    // Stamp sent_at regardless of whether the customer confirms later.
    await admin.from('orders')
      .update({ address_confirmation_sent_at: new Date().toISOString() })
      .eq('id', o.id);

    results.push({ order_ref: o.order_ref as string, ok: true });
  }

  const sent = results.filter(r => r.ok).length;
  return j({ sent, results });
});
