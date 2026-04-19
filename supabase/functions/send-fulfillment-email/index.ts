import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';

type QueueRow = {
  id: string;
  order_id: string;
  step: number;
  assigned_serial: string | null;
  carrier: string | null;
  tracking_num: string | null;
  starter_tracking_num: string | null;
  email_sent_at: string | null;
};

type OrderRow = {
  order_ref: string;
  customer_name: string;
  customer_email: string | null;
  country: 'US' | 'CA';
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!supabaseUrl || !serviceKey || !resendKey) {
    return new Response(
      JSON.stringify({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / RESEND_API_KEY' }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }

  const body = await req.json() as { queue_id?: string };
  if (!body.queue_id) {
    return new Response(JSON.stringify({ error: 'queue_id required' }), {
      status: 400, headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  // Fetch queue row + joined order
  const { data: q, error: qErr } = await admin
    .from('fulfillment_queue')
    .select('*')
    .eq('id', body.queue_id)
    .single<QueueRow>();
  if (qErr || !q) {
    return new Response(JSON.stringify({ error: 'queue row not found' }), {
      status: 404, headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }
  if (q.email_sent_at) {
    return new Response(JSON.stringify({ error: 'email already sent' }), {
      status: 409, headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }
  if (q.step !== 5) {
    return new Response(JSON.stringify({ error: `queue row at step ${q.step}, must be 5` }), {
      status: 409, headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

  const { data: order, error: oErr } = await admin
    .from('orders')
    .select('order_ref, customer_name, customer_email, country')
    .eq('id', q.order_id)
    .single<OrderRow>();
  if (oErr || !order || !order.customer_email) {
    return new Response(JSON.stringify({ error: 'order missing or has no customer_email' }), {
      status: 404, headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

  if (order.country === 'US' && !q.starter_tracking_num) {
    return new Response(JSON.stringify({ error: 'US orders require starter_tracking_num' }), {
      status: 409, headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

  const firstName = order.customer_name.split(' ')[0] ?? order.customer_name;
  const starterLine = order.country === 'US'
    ? `\nStarter kit · ${q.carrier}: ${q.starter_tracking_num}`
    : '';
  const text =
    `Hi ${firstName},\n\n` +
    `Your LILA Pro is on the way. Here are your tracking details:\n\n` +
    `LILA Pro · ${q.carrier}: ${q.tracking_num}` + starterLine + `\n\n` +
    `Expected delivery in 3–7 business days.\n\n` +
    `Questions? Just reply to this email.\n\n` +
    `Thanks for your order —\n` +
    `Team Lila\n` +
    `support@lilacomposter.com`;

  // Send via Resend
  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Team Lila <support@lilacomposter.com>',
      reply_to: 'support@lilacomposter.com',
      to: [order.customer_email],
      subject: `Your LILA Pro has shipped! (${order.order_ref})`,
      text,
    }),
  });
  if (!resendRes.ok) {
    const bodyText = await resendRes.text();
    return new Response(
      JSON.stringify({ error: `Resend ${resendRes.status}: ${bodyText.slice(0, 400)}` }),
      { status: 502, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }
  const sent = await resendRes.json() as { id: string };

  // Update queue row → step 6 + fulfilled
  const now = new Date().toISOString();
  // user_id from the JWT is available via req.headers; simplest: parse sub claim.
  const authz = req.headers.get('authorization') ?? '';
  const jwt = authz.replace(/^Bearer\s+/i, '');
  let userId: string | null = null;
  try {
    const [, payload] = jwt.split('.');
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    userId = decoded.sub ?? null;
  } catch { /* leave null */ }

  const { error: upErr } = await admin
    .from('fulfillment_queue')
    .update({
      step: 6,
      email_sent_at: now,
      email_sent_by: userId,
      fulfilled_at: now,
      fulfilled_by: userId,
    })
    .eq('id', body.queue_id);
  if (upErr) {
    return new Response(JSON.stringify({ error: `db update failed: ${upErr.message}` }), {
      status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

  // Release the shelf slot back to empty (unit shipped)
  if (q.assigned_serial) {
    await admin.from('shelf_slots')
      .update({ serial: null, batch: null, status: 'empty', updated_at: now })
      .eq('serial', q.assigned_serial);
  }

  return new Response(
    JSON.stringify({ email_id: sent.id }),
    { status: 200, headers: { ...corsHeaders, 'content-type': 'application/json' } },
  );
});
