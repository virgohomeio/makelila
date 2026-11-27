// Ticket panel "Message on Quo": an operator types a free-form SMS on a
// service ticket and it goes out from the Quo (OpenPhone) line. The sent
// text is logged to THIS ticket's ticket_messages so it shows in the
// panel's Conversation thread.
//
// Unlike send-followup-sms this does NOT touch customers.fu1/fu2 — an
// ad-hoc reply is not a follow-up-queue touch.
//
// Destination: `phone` from the request (operator-entered, for tickets with
// nothing on file) → linked customer's phone → ticket.customer_phone. When
// the operator supplies a number and the ticket had none, it is saved back
// to the ticket so the next send doesn't need it again.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { authenticate } from '../_shared/auth.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Input = { ticket_id: string; message: string; phone?: string | null };

/** Normalise a North-American number to E.164; pass through anything already +-prefixed. */
function toE164(raw: string): string | null {
  const s = raw.trim();
  if (s.startsWith('+')) {
    const d = s.slice(1).replace(/\D/g, '');
    return d.length >= 8 ? `+${d}` : null;
  }
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const opApiKey    = Deno.env.get('OPENPHONE_API_KEY');
    const opPhoneIds  = (Deno.env.get('OPENPHONE_PHONE_NUMBER_IDS') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const testPhone   = Deno.env.get('FOLLOWUP_SMS_TEST_PHONE');
    if (!supabaseUrl || !serviceKey) return j({ error: 'Missing SUPABASE_URL / SERVICE_ROLE_KEY' }, 500);
    if (!opApiKey || opPhoneIds.length === 0) {
      return j({ error: 'OPENPHONE_API_KEY or OPENPHONE_PHONE_NUMBER_IDS not configured' }, 500);
    }

    const admin = createClient(supabaseUrl, serviceKey);

    let caller;
    try { caller = await authenticate(req, admin); }
    catch (e) { if (e instanceof Response) return e; throw e; }
    if (caller.kind !== 'user') {
      return j({ error: 'This function requires an operator JWT — cron-secret not accepted.' }, 403);
    }

    const { ticket_id, message, phone } = (await req.json()) as Input;
    const text = message?.trim();
    if (!ticket_id || !text) return j({ error: 'ticket_id + message required' }, 400);
    if (text.length > 1600) return j({ error: 'Message too long (1600 characters max)' }, 400);

    const { data: t, error: tErr } = await admin
      .from('service_tickets')
      .select('id, ticket_number, customer_id, customer_name, customer_phone, message_count')
      .eq('id', ticket_id)
      .maybeSingle();
    if (tErr || !t) return j({ error: `Ticket not found: ${tErr?.message ?? 'no row'}` }, 404);

    let customerPhone: string | null = null;
    if (t.customer_id) {
      const { data: c } = await admin.from('customers').select('phone').eq('id', t.customer_id).maybeSingle();
      customerPhone = c?.phone ?? null;
    }

    const rawDest = (phone && phone.trim()) || customerPhone || t.customer_phone;
    if (!rawDest) return j({ error: 'No phone number on file — enter one to send.' }, 400);
    const dest = toE164(rawDest);
    if (!dest) return j({ error: `"${rawDest}" is not a valid phone number.` }, 400);

    // Double-click guard: same body to the same ticket within 2 minutes.
    const twoMinAgo = new Date(Date.now() - 2 * 60_000).toISOString();
    const { data: dup } = await admin
      .from('ticket_messages')
      .select('id')
      .eq('ticket_id', t.id)
      .eq('direction', 'outbound')
      .eq('body_text', text)
      .gte('sent_at', twoMinAgo)
      .limit(1);
    if (dup && dup.length > 0) return j({ ok: true, duplicate: true, to: dest });

    // FOLLOWUP_SMS_TEST_PHONE redirects every send while set (same switch
    // send-followup-sms honours), with a body prefix naming the real target.
    const to = testPhone || dest;
    const body = testPhone ? `[TEST → ${dest}] ${text}` : text;
    const opRes = await fetch('https://api.openphone.com/v1/messages', {
      method: 'POST',
      headers: { Authorization: opApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: opPhoneIds[0], to: [to], content: body }),
    });
    if (!opRes.ok) {
      const errTxt = await opRes.text();
      return j({ error: `Quo ${opRes.status}: ${errTxt.slice(0, 300)}` }, 502);
    }
    const opJson = await opRes.json() as { data?: { id?: string } };
    const opMessageId = opJson.data?.id ?? crypto.randomUUID();

    const now = new Date().toISOString();
    // 'quo:tkt-' prefix, NOT 'quo:<id>': sync-quo-tickets upserts on
    // gmail_message_id with merge semantics, so sharing its key would let
    // the next sync move this row onto the customer's Quo conversation
    // ticket and out of this one.
    const { error: tmErr } = await admin.from('ticket_messages').insert({
      ticket_id: t.id,
      gmail_message_id: `quo:tkt-${opMessageId}`,
      direction: 'outbound',
      sender: caller.email,
      sent_at: now,
      snippet: text.slice(0, 200),
      body_text: text,
    });
    if (tmErr) return j({ error: `Sent, but logging to the ticket failed: ${tmErr.message}` }, 500);

    const patch: Record<string, unknown> = {
      last_message_at: now,
      message_count: (t.message_count ?? 0) + 1,
    };
    if (!t.customer_phone) patch.customer_phone = dest;
    await admin.from('service_tickets').update(patch).eq('id', t.id);

    await admin.from('activity_log').insert({
      user_id: caller.user_id,
      type: 'ticket_sms_sent',
      entity: t.ticket_number ?? t.id,
      detail: `Quo SMS to ${t.customer_name ?? dest} (${dest}): "${text.slice(0, 100)}"`,
    }).then(() => undefined, (err) => { console.error('activity_log insert failed:', err); });

    return j({ ok: true, to: dest, openphone_message_id: opMessageId, test_redirected: !!testPhone });
  } catch (err) {
    return j({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500);
  }
});

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
