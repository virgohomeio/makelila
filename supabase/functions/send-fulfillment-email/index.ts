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

  const firstName = order.customer_name.split(' ')[0] ?? order.customer_name;

  // Carrier-specific pre-filled tracking URL so the customer lands on their shipment.
  function trackingUrl(carrier: string | null, tracking: string | null): string {
    if (!tracking) return 'https://www.ups.com/track?loc=en_US';
    switch (carrier) {
      case 'UPS':          return `https://www.ups.com/track?tracknum=${encodeURIComponent(tracking)}`;
      case 'FedEx':        return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(tracking)}`;
      case 'Purolator':    return `https://www.purolator.com/en/shipping/tracker?pin=${encodeURIComponent(tracking)}`;
      case 'Canada Post':  return `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${encodeURIComponent(tracking)}`;
      default:             return 'https://www.ups.com/track?loc=en_US';
    }
  }

  const starterBlock = order.country === 'US' && q.starter_tracking_num
    ? `\nCompost Starter Kit (ships separately via Amazon)\n\n` +
      `Starter Tracking Number: ${q.starter_tracking_num}\n\n`
    : '';

  const text =
    `Hi ${firstName},\n\n` +
    `Your LILA has officially shipped! 🎉 It's on its way to you. Here are your shipping details:\n\n` +
    `Carrier: ${q.carrier ?? ''}\n\n` +
    `Tracking Number: ${q.tracking_num ?? ''}\n\n` +
    `Tracking Link: ${trackingUrl(q.carrier, q.tracking_num)}\n` +
    starterBlock + `\n` +
    `You can use the link above to check on your delivery progress at any time.\n\n` +
    `Important next steps\n\n` +
    `1. Mandatory onboarding session\n` +
    `Once your unit arrives, you'll need to book a mandatory onboarding session before using LILA. This session is required to ensure your first batches produce high-quality compost, avoid common mistakes, and help you get the best results from day one.\n` +
    `Book a session here: https://calendly.com/lila-ed.\n\n` +
    `2. Please keep the original box\n` +
    `Please do not throw out the original packaging for the first 30 days after delivery. In the rare event of shipping damage or if a return is required during our 30-day refund period, the unit must be returned in its original box.\n\n` +
    `Thank you again for being part of the LILA community and supporting our mission to make composting effortless and sustainable. We can't wait to see the difference your LILA will make in your home.\n\n` +
    `Happy Composting! 🌱\n` +
    `-The VCycene Team`;

  // Send via Resend
  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'VCycene Team <support@lilacomposter.com>',
      reply_to: 'support@lilacomposter.com',
      to: [order.customer_email],
      subject: `Your LILA has officially shipped! 🎉 (${order.order_ref})`,
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
