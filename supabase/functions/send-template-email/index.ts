// send-template-email: render an email_templates row with provided variables
// and dispatch via Resend. Logs every send to email_messages with the
// rendered subject/body for full audit.
//
// Body shape:
//   {
//     template_key: 'return_received',
//     to: 'customer@example.com',
//     to_name: 'Ron Russell',
//     variables: { customer_first_name: 'Ron', return_ref: 'CRT-44511', ... },
//     related_return_id?: uuid,
//     related_refund_id?: uuid,
//     related_cancellation_id?: uuid,
//     test_override?: true  // route to EMAIL_TEST_RECIPIENT instead of real to
//   }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  try { return await handle(req); }
  catch (err) {
    return new Response(
      JSON.stringify({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }
});

type SendInput = {
  template_key: string;
  to: string;
  to_name?: string;
  variables?: Record<string, string | number | null | undefined>;
  related_return_id?: string;
  related_refund_id?: string;
  related_cancellation_id?: string;
};

async function handle(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const resendKey   = Deno.env.get('RESEND_API_KEY');
  if (!supabaseUrl || !serviceKey || !resendKey) {
    return j({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / RESEND_API_KEY' }, 500);
  }

  const body = (await req.json()) as SendInput;
  if (!body.template_key) return j({ error: 'template_key required' }, 400);
  if (!body.to)           return j({ error: 'to required' }, 400);

  const admin = createClient(supabaseUrl, serviceKey);

  // Fetch template
  const { data: tpl, error: tplErr } = await admin
    .from('email_templates')
    .select('key, subject, body, active')
    .eq('key', body.template_key)
    .single();
  if (tplErr || !tpl) return j({ error: `template '${body.template_key}' not found` }, 404);
  if (!tpl.active)    return j({ error: `template '${body.template_key}' is inactive` }, 409);

  // Render
  const vars = body.variables ?? {};
  const rSubject = render(tpl.subject, vars);
  const rBody    = render(tpl.body, vars);

  // Test recipient override (same env var as send-fulfillment-email)
  const testRecipient = Deno.env.get('EMAIL_TEST_RECIPIENT');
  const realTo  = body.to;
  const dest    = testRecipient || realTo;
  const subject = testRecipient ? `[TEST → ${realTo}] ${rSubject}` : rSubject;
  const emailBody = testRecipient
    ? `*** TEST MODE — this email would have been sent to ${realTo} ***\n` +
      `*** EMAIL_TEST_RECIPIENT is set on the edge function; unset to go live ***\n\n${rBody}`
    : rBody;

  // Caller's user id from JWT (best effort, no verification — gateway has verify_jwt=false)
  const authz = req.headers.get('authorization') ?? '';
  const jwt = authz.replace(/^Bearer\s+/i, '');
  let userId: string | null = null;
  try {
    const [, payload] = jwt.split('.');
    if (payload) {
      const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
      userId = decoded.sub ?? null;
    }
  } catch { /* ignore */ }

  // Log message in 'queued' state up front so we always have an audit row
  // even if Resend errors out.
  const { data: msg, error: insErr } = await admin.from('email_messages').insert({
    template_key: tpl.key,
    recipient_email: realTo,
    recipient_name: body.to_name ?? null,
    subject,
    body: emailBody,
    variables: vars,
    status: 'queued',
    sent_by: userId,
    related_return_id: body.related_return_id ?? null,
    related_refund_id: body.related_refund_id ?? null,
    related_cancellation_id: body.related_cancellation_id ?? null,
  }).select('id').single();
  if (insErr) return j({ error: `log insert failed: ${insErr.message}` }, 500);
  const msgId = (msg as { id: string }).id;

  // Send via Resend
  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'VCycene Team <support@lilacomposter.com>',
      reply_to: 'support@lilacomposter.com',
      to: [dest],
      subject,
      text: emailBody,
    }),
  });

  if (!resendRes.ok) {
    const bodyText = await resendRes.text();
    await admin.from('email_messages').update({
      status: 'failed',
      error: `Resend ${resendRes.status}: ${bodyText.slice(0, 400)}`,
    }).eq('id', msgId);
    return j({ error: `Resend ${resendRes.status}: ${bodyText.slice(0, 400)}` }, 502);
  }

  const sent = await resendRes.json() as { id: string };
  await admin.from('email_messages').update({
    status: 'sent',
    resend_id: sent.id,
    sent_at: new Date().toISOString(),
  }).eq('id', msgId);

  return j({ message_id: msgId, resend_id: sent.id, subject, recipient: dest, rendered_body_chars: emailBody.length }, 200);
}

// Render {{variable}} placeholders, preserving any that aren't supplied
// (so the operator sees what's missing in the preview).
function render(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => {
    const v = vars[name];
    if (v === undefined || v === null || v === '') return `{{${name}}}`;
    return String(v);
  });
}

function j(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
