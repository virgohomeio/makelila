// send-assignment-digests: emails each operator a single digest of how many
// OPEN support tickets are currently assigned to them. One email per owner
// (not per ticket), rendered from the 'assigned_tickets_digest' template and
// dispatched via Resend, with an audit row in email_messages.
//
// "Open support ticket" is defined exactly as the Support tab defines it:
//   category = 'support' AND kind = 'ticket' AND status <> 'closed'.
// (kind='conversation' rows are Inbox threads and are intentionally excluded.)
//
// Body shape (all optional):
//   {
//     owners?: string[],   // restrict to these owner_emails; default = all owners
//     dry_run?: boolean,   // compute + return the plan without sending anything
//   }
//
// Operator- or cron-callable (authenticate accepts a user JWT or the
// X-Cron-Secret header). Idempotency is the caller's responsibility — invoking
// twice sends twice — so trigger it deliberately.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const APP_TICKETS_URL = 'https://lila.vip/service';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  try { return await handle(req); }
  catch (err) {
    return j({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500);
  }
});

type Body = { owners?: string[]; dry_run?: boolean };

async function handle(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const resendKey   = Deno.env.get('RESEND_API_KEY');
  if (!supabaseUrl || !serviceKey || !resendKey) {
    return j({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / RESEND_API_KEY' }, 500);
  }
  const admin = createClient(supabaseUrl, serviceKey);

  try { await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }

  let body: Body = {};
  try { body = (await req.json()) as Body; } catch { /* empty body = defaults */ }
  const dryRun = body.dry_run === true;
  const ownerFilter = Array.isArray(body.owners)
    ? body.owners.map(o => o.toLowerCase())
    : null;

  // Count open support tickets per owner, the same way the Support tab does.
  const { data: rows, error: qErr } = await admin
    .from('service_tickets')
    .select('owner_email')
    .eq('category', 'support')
    .eq('kind', 'ticket')
    .neq('status', 'closed')
    .not('owner_email', 'is', null);
  if (qErr) return j({ error: `Query failed: ${qErr.message}` }, 500);

  const counts = new Map<string, number>();
  for (const r of (rows ?? []) as { owner_email: string }[]) {
    const owner = r.owner_email;
    if (ownerFilter && !ownerFilter.includes(owner.toLowerCase())) continue;
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }

  // Load the digest template once.
  const { data: tpl, error: tErr } = await admin
    .from('email_templates')
    .select('key, subject, body, active')
    .eq('key', 'assigned_tickets_digest')
    .maybeSingle();
  if (tErr) return j({ error: `Template lookup failed: ${tErr.message}` }, 500);
  if (!tpl || tpl.active === false) return j({ error: 'assigned_tickets_digest template missing or inactive' }, 500);

  const testRecipient = Deno.env.get('EMAIL_TEST_RECIPIENT') || null;
  const results: Array<Record<string, unknown>> = [];

  for (const [owner, count] of counts) {
    const summary = `${count} open support ticket${count === 1 ? '' : 's'}`;
    const vars = {
      assignee_first_name: ownerFirstName(owner),
      ticket_summary: summary,
      ticket_url: APP_TICKETS_URL,
    };
    const rSubject = render(tpl.subject, vars);
    const rBody = render(tpl.body, vars);
    const dest = testRecipient || owner;
    const subject = testRecipient ? `[TEST → ${owner}] ${rSubject}` : rSubject;
    const emailBody = testRecipient
      ? `*** TEST MODE — would have gone to ${owner} ***\n\n${rBody}`
      : rBody;

    if (dryRun) {
      results.push({ owner, count, would_send_to: dest, subject });
      continue;
    }

    // Audit row up front so a Resend failure still leaves a trace.
    const { data: msg, error: insErr } = await admin.from('email_messages').insert({
      template_key: tpl.key,
      recipient_email: owner,
      recipient_name: ownerFirstName(owner),
      subject,
      body: emailBody,
      variables: vars,
      status: 'queued',
      sent_by: null, // cron/system-initiated
    }).select('id').single();
    if (insErr) { results.push({ owner, count, error: `log insert failed: ${insErr.message}` }); continue; }
    const msgId = (msg as { id: string }).id;

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
      results.push({ owner, count, error: `Resend ${resendRes.status}: ${bodyText.slice(0, 200)}` });
      continue;
    }

    const sent = await resendRes.json() as { id: string };
    await admin.from('email_messages').update({
      status: 'sent',
      resend_id: sent.id,
      sent_at: new Date().toISOString(),
    }).eq('id', msgId);
    results.push({ owner, count, message_id: msgId, resend_id: sent.id, sent_to: dest });
  }

  return j({ ok: true, dry_run: dryRun, owners: counts.size, results }, 200);
}

/** Capitalized first token of an email local-part ('reina@…' → 'Reina'). */
function ownerFirstName(email: string): string {
  const local = (email.split('@')[0] ?? email).split(/[._-]/)[0] ?? email;
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : email;
}

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
