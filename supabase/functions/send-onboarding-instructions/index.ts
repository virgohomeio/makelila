// send-onboarding-instructions — the automatic "ACTION NEEDED" email and Quo
// text that follow a shipping email by one day.
//
// send-fulfillment-email stamps fulfillment_queue.onboarding_email_due_at
// (= send time + 24h, sale orders only) when the shipping email goes out. This
// function runs on an hourly cron, picks up every row whose due time has
// passed, and sends the Lovely App sign-in + onboarding-call instructions by
// email (Resend) and by Quo text to the phone on file. Nobody presses a button.
//
// Only rows with a due time are ever considered, so the hundreds of orders
// shipped before this existed are never emailed retroactively.
//
// Body (all optional): { dry_run?: boolean, queue_id?: string }
//   queue_id — send one row now, ignoring its due time (operator use).
// Cron- or operator-callable (authenticate accepts X-Cron-Secret or a user JWT).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';
import { archiveBcc, DEFAULT_ARCHIVE_BCC } from '../_shared/emailArchive.ts';
import { textToEmailHtml } from '../_shared/emailHtml.ts';
import { resolveOrderPhone, sendQuoSms } from '../_shared/quoSms.ts';
import {
  ONBOARDING_EMAIL_DEFAULT,
  ONBOARDING_SMS_DEFAULT,
  ONBOARDING_TEMPLATE_KEY,
  renderPlaceholders,
  unfilledPlaceholders,
} from '../_shared/onboardingEmail.ts';

const BATCH_LIMIT = 50;
const RETRY_MS = 60 * 60 * 1000;   // a failed email is retried an hour later
const MAX_ATTEMPTS = 5;

type QueueRow = {
  id: string;
  order_id: string;
  email_sent_at: string | null;
  onboarding_email_due_at: string | null;
  onboarding_email_attempts: number | null;
};

type OrderRow = {
  order_ref: string;
  customer_name: string;
  customer_email: string | null;
  customer_id: string | null;
  customer_phone: string | null;
  kind: 'sale' | 'replacement';
  status: string;
};

type CustomerRow = { full_name: string | null; email: string | null; primary_user_email: string | null };

type Outcome = { queue_id: string; order_ref?: string; result: string; sms?: string };

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  try { return await handle(req); }
  catch (err) { return j({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500); }
});

async function handle(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!supabaseUrl || !serviceKey || !resendKey) {
    return j({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / RESEND_API_KEY' }, 500);
  }
  const admin = createClient(supabaseUrl, serviceKey);

  let caller;
  try { caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  const userId = caller.kind === 'user' ? caller.user_id : null;

  let body: { dry_run?: boolean; queue_id?: string } = {};
  try { body = await req.json(); } catch { /* empty body = defaults */ }
  const dryRun = body.dry_run === true;

  const nowIso = new Date().toISOString();
  let query = admin
    .from('fulfillment_queue')
    .select('id, order_id, email_sent_at, onboarding_email_due_at, onboarding_email_attempts')
    .is('onboarding_email_sent_at', null)
    .not('onboarding_email_due_at', 'is', null)
    .not('email_sent_at', 'is', null);
  query = body.queue_id
    ? query.eq('id', body.queue_id)
    : query.lte('onboarding_email_due_at', nowIso).order('onboarding_email_due_at').limit(BATCH_LIMIT);
  const { data: rows, error: rErr } = await query;
  if (rErr) return j({ error: `queue read failed: ${rErr.message}` }, 500);

  // Stored override, used only when this function can fill every placeholder.
  const { data: tpl } = await admin
    .from('email_templates')
    .select('subject, body, active')
    .eq('key', ONBOARDING_TEMPLATE_KEY)
    .maybeSingle<{ subject: string; body: string; active: boolean }>();

  const outcomes: Outcome[] = [];
  for (const row of (rows ?? []) as QueueRow[]) {
    outcomes.push(await processRow(admin, row, { resendKey, dryRun, userId, tpl: tpl ?? null }));
  }
  return j({ ok: true, dry_run: dryRun, processed: outcomes.length, outcomes });
}

async function processRow(
  // deno-lint-ignore no-explicit-any
  admin: any,
  row: QueueRow,
  ctx: { resendKey: string; dryRun: boolean; userId: string | null; tpl: { subject: string; body: string; active: boolean } | null },
): Promise<Outcome> {
  const { data: order } = await admin
    .from('orders')
    .select('order_ref, customer_name, customer_email, customer_id, customer_phone, kind, status')
    .eq('id', row.order_id)
    .maybeSingle() as { data: OrderRow | null };

  // Give up for good on a row that should never get this email.
  const stop = async (reason: string): Promise<Outcome> => {
    if (!ctx.dryRun) {
      await admin.from('fulfillment_queue')
        .update({ onboarding_email_due_at: null, onboarding_email_error: reason })
        .eq('id', row.id);
      await log(admin, ctx.userId, 'fq_onboarding_email_skipped', row.id, `${order?.order_ref ?? row.order_id} · ${reason}`);
    }
    return { queue_id: row.id, order_ref: order?.order_ref, result: `skipped: ${reason}` };
  };

  if (!order) return stop('order not found');
  if (order.status === 'cancelled') return stop('order cancelled');

  let linked: CustomerRow | null = null;
  if (!order.customer_email?.trim() && order.customer_id) {
    const { data: c } = await admin.from('customers')
      .select('full_name, email, primary_user_email')
      .eq('id', order.customer_id).maybeSingle();
    linked = (c as CustomerRow | null) ?? null;
  }
  const recipient = resolveRecipient(order, linked);

  const vars: Record<string, string> = {
    customer_first_name: order.customer_name.split(' ')[0] ?? order.customer_name,
    order_ref: order.order_ref,
  };
  let source = ONBOARDING_EMAIL_DEFAULT;
  if (ctx.tpl?.active) {
    const s = renderPlaceholders(ctx.tpl.subject, vars);
    const b = renderPlaceholders(ctx.tpl.body, vars);
    if (unfilledPlaceholders(`${s}\n${b}`).length === 0) source = ctx.tpl;
  }
  const renderedSubject = renderPlaceholders(source.subject, vars);
  const text = renderPlaceholders(source.body, vars);
  const smsText = renderPlaceholders(ONBOARDING_SMS_DEFAULT, vars);

  if (ctx.dryRun) {
    return {
      queue_id: row.id, order_ref: order.order_ref,
      result: recipient ? `would email ${recipient}` : 'would email nobody (no address on file)',
    };
  }

  // Claim the row before sending, so two overlapping runs cannot both send.
  const claimAt = new Date().toISOString();
  const { data: claimed } = await admin.from('fulfillment_queue')
    .update({ onboarding_email_sent_at: claimAt, onboarding_email_attempts: (row.onboarding_email_attempts ?? 0) + 1 })
    .eq('id', row.id)
    .is('onboarding_email_sent_at', null)
    .select('id');
  if (!claimed || claimed.length === 0) return { queue_id: row.id, order_ref: order.order_ref, result: 'already claimed' };

  let emailResult = 'no email on file';
  let emailOk = false;
  if (recipient) {
    const testRecipient = Deno.env.get('EMAIL_TEST_RECIPIENT');
    const to = testRecipient || recipient;
    const subject = testRecipient ? `[TEST → ${recipient}] ${renderedSubject}` : renderedSubject;
    const emailText = testRecipient
      ? `*** TEST MODE — this email would have been sent to ${recipient} ***\n` +
        `*** EMAIL_TEST_RECIPIENT is set on the edge function; unset to go live ***\n\n` + text
      : text;

    const { data: logRow } = await admin.from('email_messages').insert({
      template_key: ONBOARDING_TEMPLATE_KEY,
      recipient_email: recipient,
      recipient_name: order.customer_name,
      subject,
      body: emailText,
      variables: { ...vars, order_ref: order.order_ref },
      status: 'queued',
      sent_by: ctx.userId,
    }).select('id').maybeSingle();
    const msgId = (logRow as { id: string } | null)?.id ?? null;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'VCycene Team <support@lilacomposter.com>',
        reply_to: 'support@lilacomposter.com',
        to: [to],
        bcc: archiveBcc(to, Deno.env.get('EMAIL_ARCHIVE_BCC') ?? DEFAULT_ARCHIVE_BCC),
        subject,
        text: emailText,
        html: textToEmailHtml(emailText),
      }),
    });
    if (res.ok) {
      const sent = await res.json() as { id: string };
      if (msgId) {
        await admin.from('email_messages')
          .update({ status: 'sent', resend_id: sent.id, sent_at: new Date().toISOString() })
          .eq('id', msgId);
      }
      emailOk = true;
      emailResult = `emailed ${recipient}`;
    } else {
      const errTxt = (await res.text()).slice(0, 400);
      if (msgId) {
        await admin.from('email_messages').update({ status: 'failed', error: `Resend ${res.status}: ${errTxt}` }).eq('id', msgId);
      }
      emailResult = `Resend ${res.status}: ${errTxt}`;
    }
  }

  // Resend failure: release the claim and try again later, up to MAX_ATTEMPTS.
  // The text waits for the retry too, so the customer never gets it twice.
  if (recipient && !emailOk) {
    const attempts = (row.onboarding_email_attempts ?? 0) + 1;
    const giveUp = attempts >= MAX_ATTEMPTS;
    await admin.from('fulfillment_queue').update({
      onboarding_email_sent_at: null,
      onboarding_email_error: emailResult,
      onboarding_email_due_at: giveUp ? null : new Date(Date.now() + RETRY_MS).toISOString(),
    }).eq('id', row.id);
    await log(admin, ctx.userId, 'fq_onboarding_email_failed', row.id,
      `${order.order_ref} · ${emailResult}${giveUp ? ' · giving up' : ' · will retry'}`);
    return { queue_id: row.id, order_ref: order.order_ref, result: `failed: ${emailResult}` };
  }

  // Text goes out whether or not there was an email address — a customer with
  // only a phone on file still needs the instructions.
  const phone = await resolveOrderPhone(admin, order);
  const sms = await sendQuoSms(phone, smsText);
  const smsResult = sms.ok ? `texted ${sms.to}` : `text not sent: ${sms.error}`;

  // Neither channel reached the customer: record it and stop.
  if (!emailOk && !sms.ok) {
    await admin.from('fulfillment_queue').update({
      onboarding_email_sent_at: null,
      onboarding_email_due_at: null,
      onboarding_email_error: `no email on file; ${smsResult}`,
    }).eq('id', row.id);
    await log(admin, ctx.userId, 'fq_onboarding_email_skipped', row.id, `${order.order_ref} · no email on file; ${smsResult}`);
    return { queue_id: row.id, order_ref: order.order_ref, result: 'skipped: no email on file', sms: smsResult };
  }

  await admin.from('fulfillment_queue').update({
    onboarding_email_error: emailOk && sms.ok ? null : (emailOk ? smsResult : 'no email on file'),
  }).eq('id', row.id);
  await log(admin, ctx.userId, 'fq_onboarding_email_sent', row.id, `${order.order_ref} · ${emailResult} · ${smsResult}`);
  return { queue_id: row.id, order_ref: order.order_ref, result: emailResult, sms: smsResult };
}

// deno-lint-ignore no-explicit-any
async function log(admin: any, userId: string | null, type: string, entity: string, detail: string) {
  await admin.from('activity_log').insert({ user_id: userId, type, entity, detail })
    .then(() => undefined, (err: unknown) => { console.error('activity_log insert failed:', err); });
}

/** Same rule as send-fulfillment-email: the order's own email, else the
 *  linked customer record when it names the same person. */
function resolveRecipient(order: OrderRow, customer: CustomerRow | null): string | null {
  const trim = (v: string | null | undefined) => (v ?? '').trim() || null;
  const onOrder = trim(order.customer_email);
  if (onOrder) return onOrder;
  const fromDirectory = customer ? trim(customer.primary_user_email) ?? trim(customer.email) : null;
  if (!fromDirectory) return null;
  const norm = (v: string | null | undefined) => (v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const a = norm(order.customer_name);
  if (a === '' || a !== norm(customer?.full_name)) return null;
  return fromDirectory;
}

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
