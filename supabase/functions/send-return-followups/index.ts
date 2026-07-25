// send-return-followups (BR-16): nudge customers whose return is stuck in the
// "Return Form Submitted" (Intake / New) stage awaiting THEIR action, so a case
// never stalls silently. A return with no refund request yet and status
// 'created':
//   • 7–13 days old  → send the customer a one-off reminder (re-nudge at most
//     once every 7 days), rendered from the 'return_followup_customer' template.
//   • ≥ 14 days old   → stop auto-emailing and stamp followup_escalated_at so the
//     Account Manager sees an "escalate" flag and takes it over (BR-16 second
//     interval → escalation/closure).
//
// This is the customer-waiting counterpart to send-refund-reminders (FR-9c),
// which covers only the internal action queues. Excludes returns already in the
// refund pipeline (they have a linked refund_approvals row).
//
// Body (all optional): { dry_run?: boolean }
// Cron- or operator-callable (authenticate accepts X-Cron-Secret or a user JWT).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const REMIND_DAYS = 7;    // BR-16 first interval — mirrors CUSTOMER_REMIND_DAYS
const ESCALATE_DAYS = 14; // BR-16 second interval — mirrors CUSTOMER_ESCALATE_DAYS
const DAY_MS = 86_400_000;

type ReturnRow = {
  id: string;
  status: string;
  customer_name: string | null;
  customer_email: string | null;
  created_at: string;
  last_customer_reminder_at: string | null;
  followup_escalated_at: string | null;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  try { return await handle(req); }
  catch (err) { return j({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500); }
});

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

  let body: { dry_run?: boolean } = {};
  try { body = (await req.json()) as { dry_run?: boolean }; } catch { /* empty body = defaults */ }
  const dryRun = body.dry_run === true;

  // Candidate returns: still at the intake 'created' stage, no refund request yet.
  const { data: rows, error: qErr } = await admin
    .from('returns')
    .select('id, status, customer_name, customer_email, created_at, last_customer_reminder_at, followup_escalated_at')
    .eq('status', 'created');
  if (qErr) return j({ error: `Query failed: ${qErr.message}` }, 500);

  const { data: refs, error: rErr } = await admin
    .from('refund_approvals')
    .select('return_id');
  if (rErr) return j({ error: `Refund lookup failed: ${rErr.message}` }, 500);
  const hasRefund = new Set((refs ?? []).map(r => (r as { return_id: string | null }).return_id).filter(Boolean));

  const { data: tpl, error: tErr } = await admin
    .from('email_templates')
    .select('key, subject, body, active')
    .eq('key', 'return_followup_customer')
    .maybeSingle();
  if (tErr) return j({ error: `Template lookup failed: ${tErr.message}` }, 500);
  if (!tpl || tpl.active === false) return j({ error: 'return_followup_customer template missing or inactive' }, 500);

  const now = Date.now();
  const testRecipient = Deno.env.get('EMAIL_TEST_RECIPIENT') || null;
  const results: Array<Record<string, unknown>> = [];
  let reminded = 0, escalated = 0;

  for (const r of (rows ?? []) as ReturnRow[]) {
    if (hasRefund.has(r.id)) continue;
    const ageMs = now - Date.parse(r.created_at);
    if (isNaN(ageMs) || ageMs < REMIND_DAYS * DAY_MS) continue;   // < 7 days: still fresh
    const days = Math.floor(ageMs / DAY_MS);

    // ≥ 14 days → escalate to a human, stop auto-emailing.
    if (ageMs >= ESCALATE_DAYS * DAY_MS) {
      if (!r.followup_escalated_at && !dryRun) {
        await admin.from('returns').update({ followup_escalated_at: new Date().toISOString() }).eq('id', r.id);
      }
      escalated++;
      results.push({ return_id: r.id, customer: r.customer_name, days, action: 'escalated' });
      continue;
    }

    // 7–13 days → reminder, at most once per 7 days.
    if (r.last_customer_reminder_at && (now - Date.parse(r.last_customer_reminder_at)) < REMIND_DAYS * DAY_MS) continue;
    const to = (r.customer_email ?? '').trim();
    if (!to) { results.push({ return_id: r.id, days, action: 'skipped_no_email' }); continue; }

    const vars = { customer_first_name: firstName(r.customer_name, to), days_waiting: String(days) };
    const rSubject = render(tpl.subject, vars);
    const rBody = render(tpl.body, vars);
    const dest = testRecipient || to;
    const subject = testRecipient ? `[TEST → ${to}] ${rSubject}` : rSubject;
    const emailBody = testRecipient ? `*** TEST MODE — would have gone to ${to} ***\n\n${rBody}` : rBody;

    if (dryRun) {
      results.push({ return_id: r.id, customer: r.customer_name, days, action: 'would_remind', would_send_to: dest });
      reminded++;
      continue;
    }

    const { data: msg, error: insErr } = await admin.from('email_messages').insert({
      template_key: tpl.key, recipient_email: to, recipient_name: vars.customer_first_name,
      subject, body: emailBody, variables: vars, status: 'queued', sent_by: null,
      related_return_id: r.id,
    }).select('id').single();
    if (insErr) { results.push({ return_id: r.id, error: `log insert failed: ${insErr.message}` }); continue; }
    const msgId = (msg as { id: string }).id;

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'VCycene Team <support@lilacomposter.com>',
        reply_to: 'support@lilacomposter.com',
        to: [dest], subject, text: emailBody,
      }),
    });
    if (!resendRes.ok) {
      const t = await resendRes.text();
      await admin.from('email_messages').update({ status: 'failed', error: `Resend ${resendRes.status}: ${t.slice(0, 400)}` }).eq('id', msgId);
      results.push({ return_id: r.id, error: `Resend ${resendRes.status}: ${t.slice(0, 200)}` });
      continue;
    }
    const sent = await resendRes.json() as { id: string };
    await admin.from('email_messages').update({ status: 'sent', resend_id: sent.id, sent_at: new Date().toISOString() }).eq('id', msgId);
    await admin.from('returns').update({ last_customer_reminder_at: new Date().toISOString() }).eq('id', r.id);
    reminded++;
    results.push({ return_id: r.id, customer: r.customer_name, days, action: 'reminded', resend_id: sent.id, sent_to: dest });
  }

  return j({ ok: true, dry_run: dryRun, reminded, escalated, results }, 200);
}

function firstName(name: string | null, email: string): string {
  const fromName = (name ?? '').trim().split(/\s+/)[0];
  if (fromName) return fromName;
  const local = (email.split('@')[0] ?? email).split(/[._-]/)[0] ?? email;
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : 'there';
}

function render(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => {
    const v = vars[name];
    if (v === undefined || v === null || v === '') return `{{${name}}}`;
    return String(v);
  });
}

function j(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'content-type': 'application/json' } });
}
