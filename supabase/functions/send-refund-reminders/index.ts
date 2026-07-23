// send-refund-reminders (FR-9c): emails each role-holder a single digest of the
// refunds that have sat in their ACTION queue for 3+ days. One email per
// recipient (not per card), rendered from the 'refund_reminder_digest' template
// and dispatched via Resend, with an audit row in email_messages.
//
// Action queues (only these are reminded — Completeness / Return & Inspection
// wait on the customer and are excluded, per BR-16):
//   manager_review  → Return Manager
//   finance_review  → Finance Officer
//   refund_queue    → executor: Shopify/Sezzle → Payments Operator, else Finance
//
// Cadence: a card is included once it has been in its current stage >= 3 days
// AND it hasn't been reminded in the last 3 days (last_reminded_at). "Days in
// stage" keys off a per-stage entry timestamp, so the timer resets when a card
// advances. Included cards get last_reminded_at stamped after a successful send.
//
// Body (all optional): { dry_run?: boolean }
// Cron- or operator-callable (authenticate accepts X-Cron-Secret or a user JWT).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const APP_REFUNDS_URL = 'https://lila.vip/post-shipment?tab=refunds';
const REMINDER_DAYS = 3;
const REMINDER_MS = REMINDER_DAYS * 86_400_000;

// Role → holder addresses (env-overridable so swapping a holder needs no code
// change). Mirrors REFUND_EXECUTORS in app/src/lib/postShipment.ts.
const MANAGER_EMAIL  = Deno.env.get('REFUND_MANAGER_EMAIL')  || 'george@virgohome.io';
const FINANCE_EMAIL  = Deno.env.get('REFUND_FINANCE_EMAIL')  || 'yueli@virgohome.io';
const PAYMENTS_EMAIL = Deno.env.get('REFUND_PAYMENTS_EMAIL') || 'pedrum@virgohome.io';

const ACTION_STATUSES = ['manager_review', 'finance_review', 'refund_queue'] as const;
const STAGE_LABEL: Record<string, string> = {
  manager_review: 'Manager review',
  finance_review: 'Finance review',
  refund_queue: 'Refund Queue',
};

type RefundRow = {
  id: string;
  status: string;
  customer_name: string | null;
  customer_email: string | null;
  refund_amount_usd: number | null;
  refund_method: string | null;
  submitted_at: string | null;
  manager_approved_at: string | null;
  finance_approved_at: string | null;
  last_reminded_at: string | null;
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

  const { data: rows, error: qErr } = await admin
    .from('refund_approvals')
    .select('id, status, customer_name, customer_email, refund_amount_usd, refund_method, submitted_at, manager_approved_at, finance_approved_at, last_reminded_at')
    .in('status', ACTION_STATUSES as unknown as string[]);
  if (qErr) return j({ error: `Query failed: ${qErr.message}` }, 500);

  const now = Date.now();

  // Bucket the overdue cards by the recipient responsible for their stage.
  const byRecipient = new Map<string, RefundRow[]>();
  for (const r of (rows ?? []) as RefundRow[]) {
    const entry = stageEntry(r);
    if (!entry) continue;
    const inStageMs = now - Date.parse(entry);
    if (isNaN(inStageMs) || inStageMs < REMINDER_MS) continue;               // < 3 days in stage
    if (r.last_reminded_at && (now - Date.parse(r.last_reminded_at)) < REMINDER_MS) continue; // reminded recently
    const to = recipientFor(r);
    (byRecipient.get(to) ?? byRecipient.set(to, []).get(to)!).push(r);
  }

  const { data: tpl, error: tErr } = await admin
    .from('email_templates')
    .select('key, subject, body, active')
    .eq('key', 'refund_reminder_digest')
    .maybeSingle();
  if (tErr) return j({ error: `Template lookup failed: ${tErr.message}` }, 500);
  if (!tpl || tpl.active === false) return j({ error: 'refund_reminder_digest template missing or inactive' }, 500);

  const testRecipient = Deno.env.get('EMAIL_TEST_RECIPIENT') || null;
  const results: Array<Record<string, unknown>> = [];

  for (const [recipient, cards] of byRecipient) {
    const summary = cards.map(c => summaryLine(c, now)).join('\n');
    const vars = {
      recipient_first_name: firstName(recipient),
      count: String(cards.length),
      refund_summary: summary,
      refund_url: APP_REFUNDS_URL,
    };
    const rSubject = render(tpl.subject, vars);
    const rBody = render(tpl.body, vars);
    const dest = testRecipient || recipient;
    const subject = testRecipient ? `[TEST → ${recipient}] ${rSubject}` : rSubject;
    const emailBody = testRecipient
      ? `*** TEST MODE — would have gone to ${recipient} ***\n\n${rBody}`
      : rBody;

    if (dryRun) {
      results.push({ recipient, count: cards.length, would_send_to: dest, subject });
      continue;
    }

    const { data: msg, error: insErr } = await admin.from('email_messages').insert({
      template_key: tpl.key,
      recipient_email: recipient,
      recipient_name: firstName(recipient),
      subject,
      body: emailBody,
      variables: vars,
      status: 'queued',
      sent_by: null,
    }).select('id').single();
    if (insErr) { results.push({ recipient, error: `log insert failed: ${insErr.message}` }); continue; }
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
      results.push({ recipient, error: `Resend ${resendRes.status}: ${bodyText.slice(0, 200)}` });
      continue;
    }

    const sent = await resendRes.json() as { id: string };
    await admin.from('email_messages').update({
      status: 'sent', resend_id: sent.id, sent_at: new Date().toISOString(),
    }).eq('id', msgId);

    // Stamp the included cards so they aren't re-reminded for another 3 days.
    const ids = cards.map(c => c.id);
    const { error: stampErr } = await admin.from('refund_approvals')
      .update({ last_reminded_at: new Date().toISOString() }).in('id', ids);
    results.push({
      recipient, count: cards.length, message_id: msgId, resend_id: sent.id, sent_to: dest,
      ...(stampErr ? { stamp_error: stampErr.message } : {}),
    });
  }

  return j({ ok: true, dry_run: dryRun, recipients: byRecipient.size, results }, 200);
}

/** The timestamp a card entered its current action stage (proxy from the
 *  existing approval timestamps). manager_review has no explicit entry stamp, so
 *  submitted_at is the closest proxy. */
function stageEntry(r: RefundRow): string | null {
  switch (r.status) {
    case 'manager_review': return r.submitted_at;
    case 'finance_review': return r.manager_approved_at ?? r.submitted_at;
    case 'refund_queue':   return r.finance_approved_at ?? r.submitted_at;
    default: return null;
  }
}

function recipientFor(r: RefundRow): string {
  if (r.status === 'manager_review') return MANAGER_EMAIL;
  if (r.status === 'finance_review') return FINANCE_EMAIL;
  // refund_queue — route to the executor, same rule as the app's refundExecutorEmail.
  return (r.refund_method === 'shopify' || r.refund_method === 'sezzle') ? PAYMENTS_EMAIL : FINANCE_EMAIL;
}

function summaryLine(c: RefundRow, now: number): string {
  const entry = stageEntry(c);
  const days = entry ? Math.floor((now - Date.parse(entry)) / 86_400_000) : 0;
  const amount = c.refund_amount_usd != null ? `$${Number(c.refund_amount_usd).toFixed(2)}` : '$—';
  const who = c.customer_name || c.customer_email || 'Unknown customer';
  return `• ${who} — ${amount} — ${STAGE_LABEL[c.status] ?? c.status} — waiting ${days}d`;
}

function firstName(email: string): string {
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
