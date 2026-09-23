// Deno.serve is native on Deno 2 (what Supabase edge runtime uses) — avoids
// pulling in std/http which has caused transient boot errors on the edge
// runtime. createClient is pinned to a recent v2 release.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  try {
    return await handle(req);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }
});

async function handle(req: Request): Promise<Response> {

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!supabaseUrl || !serviceKey || !resendKey) {
    return new Response(
      JSON.stringify({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / RESEND_API_KEY' }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }

  const admin = createClient(supabaseUrl, serviceKey);

  let _caller;
  try { _caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  // Reject cron-secret calls — these functions are operator-triggered only.
  if (_caller.kind !== 'user') {
    return new Response(
      JSON.stringify({ error: 'This function requires an operator JWT — cron-secret not accepted.' }),
      { status: 403, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } },
    );
  }

  // subject_override / body_override carry an operator's per-send edit from
  // Step 5. When present they are sent verbatim — already rendered client-side
  // against the same template this function would otherwise render itself.
  const body = await req.json() as {
    queue_id?: string;
    subject_override?: string;
    body_override?: string;
  };
  if (!body.queue_id) {
    return new Response(JSON.stringify({ error: 'queue_id required' }), {
      status: 400, headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

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
      // Canpar and GLS were missing here while the Step-5 preview had them, so
      // a Canpar shipment previewed a Canpar link and sent a UPS one.
      case 'Canpar':       return `https://www.canpar.com/en/track/TrackingAction.do?reference=${encodeURIComponent(tracking)}`;
      case 'GLS':          return `https://gls-us.com/tracking?trackingNumber=${encodeURIComponent(tracking)}`;
      default:             return 'https://www.ups.com/track?loc=en_US';
    }
  }

  const starterBlock = order.country === 'US' && q.starter_tracking_num
    ? `\nCompost Starter Kit (ships separately via Amazon)\n\n` +
      `Starter Tracking Number: ${q.starter_tracking_num}\n`
    : '';

  // The body used to be hardcoded here AND in the Step-5 preview, two copies
  // that drifted. It now comes from the 'shipment_confirmation' row in
  // email_templates, which the preview renders too and an operator can edit.
  const { data: tpl, error: tplErr } = await admin
    .from('email_templates')
    .select('key, subject, body, active')
    .eq('key', 'shipment_confirmation')
    .maybeSingle<{ key: string; subject: string; body: string; active: boolean }>();
  // Hard-fail rather than falling back to a stale hardcoded copy: a silent
  // fallback would send wording nobody can see or edit in the app.
  if (tplErr || !tpl) {
    return new Response(
      JSON.stringify({ error: "email template 'shipment_confirmation' not found \u2014 run migration 20260923120000" }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }
  if (!tpl.active) {
    return new Response(
      JSON.stringify({ error: "email template 'shipment_confirmation' is inactive \u2014 re-activate it in Templates" }),
      { status: 409, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }

  const vars: Record<string, string> = {
    customer_first_name: firstName,
    order_ref: order.order_ref,
    carrier: q.carrier ?? '',
    tracking_num: q.tracking_num ?? '',
    tracking_url: trackingUrl(q.carrier, q.tracking_num),
    starter_block: starterBlock,
  };

  const renderedSubject = render(tpl.subject, vars);
  const text = render(tpl.body, vars);

  // Testing override: if EMAIL_TEST_RECIPIENT is set, redirect every send to
  // that address instead of the real customer. Subject gets a [TEST → <real>]
  // prefix and the body is prepended with a banner so it's obvious the email
  // was not delivered to the customer. Unset this env var to go live.
  const testRecipient = Deno.env.get('EMAIL_TEST_RECIPIENT');
  const realTo = order.customer_email;
  const to = testRecipient || realTo;
  // An operator's Step-5 edit wins over the rendered template.
  const finalSubject = body.subject_override?.trim() || renderedSubject;
  const finalBody = body.body_override?.trim() || text;
  const subject = testRecipient ? `[TEST → ${realTo}] ${finalSubject}` : finalSubject;
  const emailText = testRecipient
    ? `*** TEST MODE — this email would have been sent to ${realTo} ***\n` +
      `*** EMAIL_TEST_RECIPIENT is set on the edge function; unset to go live ***\n\n` +
      finalBody
    : finalBody;

  // Log the send up front so there is an audit row even if Resend errors.
  // Matters more now the body is operator-editable: the template no longer
  // tells you what a given customer actually received.
  const { data: logRow } = await admin.from('email_messages').insert({
    template_key: tpl.key,
    recipient_email: realTo,
    recipient_name: order.customer_name,
    subject,
    body: emailText,
    variables: { ...vars, edited_by_operator: body.body_override ? 'yes' : 'no' },
    status: 'queued',
    sent_by: _caller.user_id,
  }).select('id').maybeSingle<{ id: string }>();
  const msgId = logRow?.id ?? null;

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
      to: [to],
      subject,
      text: emailText,
    }),
  });
  if (!resendRes.ok) {
    const bodyText = await resendRes.text();
    if (msgId) {
      await admin.from('email_messages').update({
        status: 'failed', error: `Resend ${resendRes.status}: ${bodyText.slice(0, 400)}`,
      }).eq('id', msgId);
    }
    return new Response(
      JSON.stringify({ error: `Resend ${resendRes.status}: ${bodyText.slice(0, 400)}` }),
      { status: 502, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }
  const sent = await resendRes.json() as { id: string };
  if (msgId) {
    await admin.from('email_messages').update({
      status: 'sent', resend_id: sent.id, sent_at: new Date().toISOString(),
    }).eq('id', msgId);
  }

  // Update queue row → step 6 + fulfilled
  const now = new Date().toISOString();
  const userId = _caller.user_id;

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

  // Release the shelf slot back to empty (unit shipped). Flip status only;
  // leave `serial` set because fulfillment_queue.assigned_serial has a FK
  // pointing here. Nullifying it errors and the error used to be silently
  // swallowed (no .error check), which left 74 historical shipped units
  // still showing as 'available' on the picker. The DB trigger
  // sync_shelf_slot_on_unit_status_change (migration 20260603130000) also
  // catches this when units.status flips to 'shipped' via other paths.
  if (q.assigned_serial) {
    const { error: shelfErr } = await admin.from('shelf_slots')
      .update({ status: 'empty', updated_at: now })
      .eq('serial', q.assigned_serial);
    if (shelfErr) {
      console.error(`shelf_slots empty failed for ${q.assigned_serial}: ${shelfErr.message}`);
    }
  }

  return new Response(
    JSON.stringify({ email_id: sent.id }),
    { status: 200, headers: { ...corsHeaders, 'content-type': 'application/json' } },
  );
}

/** Render `{{variable}}` placeholders. A missing or empty value is left as
 *  `{{name}}` so gaps are visible rather than silently blank.
 *
 *  `starter_block` is the one exception: it is legitimately empty on every
 *  non-US order, so its placeholder (and the newline after it) is removed
 *  instead of printed. Keep in sync with renderShipmentEmail() in
 *  app/src/lib/fulfillment.ts. */
function render(template: string, vars: Record<string, string>): string {
  const withBlock = template.replace(
    // No newline is consumed: the placeholder sits alone on its own line, so
    // dropping just the text leaves the blank line that separates the sections.
    /\{\{\s*starter_block\s*\}\}/g,
    () => vars.starter_block || '',
  );
  return withBlock.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => {
    const v = vars[name];
    if (v === undefined || v === null || v === '') return match;
    return String(v);
  });
}
