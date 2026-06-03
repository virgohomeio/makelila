// Auto follow-up queue Phase 2: send an LLM-drafted SMS via OpenPhone,
// log to ticket_messages, flip the customer's fu1/fu2 status. See
// docs/superpowers/specs/2026-06-03-auto-followup-queue-design.md.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Input = { customer_id: string; message: string };

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

    // TODO(security-pass): swap to _shared/auth.ts authenticate()
    const authz = req.headers.get('authorization') ?? '';
    const jwt = authz.replace(/^Bearer\s+/i, '');
    if (!jwt) return j({ error: 'Missing Authorization header' }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return j({ error: 'Invalid token' }, 401);
    const { data: callerProfile } = await admin.from('profiles').select('is_internal').eq('id', userData.user.id).maybeSingle();
    if (!callerProfile?.is_internal) return j({ error: 'Not authorized' }, 403);
    const callerUserId = userData.user.id;

    const { customer_id, message } = (await req.json()) as Input;
    if (!customer_id || !message?.trim()) return j({ error: 'customer_id + message required' }, 400);

    // Fetch customer
    const { data: c, error: cErr } = await admin
      .from('customers')
      .select('id, full_name, email, phone, fu1_status, fu2_status, fu_notes')
      .eq('id', customer_id)
      .maybeSingle();
    if (cErr || !c) return j({ error: `Customer not found: ${cErr?.message ?? 'no row'}` }, 404);
    if (!c.phone) return j({ error: 'Customer has no phone on file' }, 400);

    // Idempotency: matching body in this customer's Quo thread in the last 5 min?
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const { data: recentDup } = await admin
      .from('ticket_messages')
      .select('id, sent_at, service_tickets!inner(customer_id, source)')
      .eq('service_tickets.customer_id', c.id)
      .eq('service_tickets.source', 'quo')
      .eq('direction', 'outbound')
      .eq('body_text', message)
      .gte('sent_at', fiveMinAgo)
      .limit(1);
    if (recentDup && recentDup.length > 0) {
      return j({ ok: true, duplicate: true, ticket_message_id: recentDup[0].id });
    }

    // Send via OpenPhone
    const to = testPhone || c.phone;
    const body = testPhone
      ? `[TEST → ${c.phone}] ${message}`
      : message;
    const opRes = await fetch('https://api.openphone.com/v1/messages', {
      method: 'POST',
      headers: {
        Authorization: opApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: opPhoneIds[0],
        to: [to],
        content: body,
      }),
    });
    if (!opRes.ok) {
      const txt = await opRes.text();
      return j({ error: `OpenPhone ${opRes.status}: ${txt.slice(0, 300)}` }, 502);
    }
    const opJson = await opRes.json() as { data?: { id?: string } };
    const opMessageId = opJson.data?.id ?? `auto-${crypto.randomUUID()}`;

    // Find-or-create the Quo ticket for this customer
    const { data: existingTicket } = await admin
      .from('service_tickets')
      .select('id, message_count')
      .eq('customer_id', c.id)
      .eq('source', 'quo')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    const now = new Date().toISOString();
    let ticketId: string;
    if (existingTicket) {
      ticketId = existingTicket.id;
      await admin.from('service_tickets').update({
        last_message_at: now,
        message_count: (existingTicket.message_count ?? 0) + 1,
      }).eq('id', existingTicket.id);
    } else {
      const { data: newTicket, error: insErr } = await admin
        .from('service_tickets')
        .insert({
          source: 'quo',
          kind: 'conversation',
          category: 'support',
          status: 'new',
          priority: 'normal',
          subject: `Follow-up SMS to ${c.full_name ?? c.phone}`,
          description: message.slice(0, 200),
          customer_id: c.id,
          customer_name: c.full_name,
          customer_phone: c.phone,
          customer_email: c.email,
          first_message_at: now,
          last_message_at: now,
          message_count: 1,
        })
        .select('id')
        .single();
      if (insErr || !newTicket) return j({ error: `Ticket create failed: ${insErr?.message}` }, 500);
      ticketId = newTicket.id;
    }

    // Insert ticket_message
    const { error: tmErr } = await admin.from('ticket_messages').insert({
      ticket_id: ticketId,
      gmail_message_id: `quo:auto-fu-${opMessageId}`,
      direction: 'outbound',
      sender: opPhoneIds[0],
      sent_at: now,
      snippet: message.slice(0, 200),
      body_text: message.slice(0, 50_000),
    });
    if (tmErr) return j({ error: `ticket_messages insert: ${tmErr.message}` }, 500);

    // Flip fu1 / fu2 + append fu_notes
    const tagLine = `[Makelila ${now.slice(0,10)}] Auto FU SMS sent (text: "${message.slice(0, 80)}${message.length > 80 ? '…' : ''}")`;
    const newFuNotes = c.fu_notes ? `${c.fu_notes}\n${tagLine}` : tagLine;
    const patch: Record<string, string> = { fu_notes: newFuNotes };
    if (!c.fu1_status) patch.fu1_status = 'messaged';
    else if (!c.fu2_status) patch.fu2_status = 'messaged';

    const { error: upErr } = await admin.from('customers').update(patch).eq('id', c.id);
    if (upErr) return j({ error: `customer update: ${upErr.message}` }, 500);

    // Activity log (best-effort)
    await admin.from('activity_log').insert({
      user_id: callerUserId,
      type: 'auto_followup_sent',
      entity: c.id,
      detail: `${c.full_name ?? c.phone}: "${message.slice(0, 100)}"`,
    }).then(() => undefined, () => undefined);

    return j({
      ok: true,
      openphone_message_id: opMessageId,
      ticket_id: ticketId,
      test_redirected: !!testPhone,
    });
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
