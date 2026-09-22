// freight-rate-report — emails the Freightcom rate-probe findings on days 2, 4
// and 7 of a campaign.
// Spec: docs/superpowers/specs/2026-09-22-freightcom-rate-probe-design.md
//
// To reina@virgohome.io, cc huayi@ and george@. Sent from
// support@lilacomposter.com because that is the only domain verified in Resend —
// a From on virgohome.io is rejected with a 403.
//
// Runs daily and decides for itself whether today is a reporting day, so the
// cron carries no date arithmetic. On the last day it closes the campaign and
// unschedules both jobs via freight_probe_finish().
//
// Body (all optional): { force?: boolean, dry_run?: boolean, day?: number }
//   force   — send even if today is not day 2/4/7
//   dry_run — render and return the report without sending or logging

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';
import {
  WEEKDAYS, WARN_CAD, CRITICAL_CAD,
  dedupe, averageByWeekday, bestRatePerOrder, driftSince, isCalifornia,
  money, signed, pctBelow,
} from '../_shared/freightRateReport.ts';
import type { BestRate, Drift } from '../_shared/freightRateReport.ts';

const TO      = 'reina@virgohome.io';
const CC      = ['huayi@virgohome.io', 'george@virgohome.io'];
const FROM    = 'VCycene Team <support@lilacomposter.com>';
const APP_URL = 'https://lila.vip/order-review';

const REPORT_DAYS = [2, 4, 7];

type ProbeRow = {
  order_id: string; order_ref: string; customer_name: string;
  dest_postal: string; dest_country: string;
  ship_date: string; ship_weekday: number;
  run_index: number; run_at: string;
  carrier: string; service_level: string;
  rate_cad: number | null; transit_days: number | null;
  package_count: number; flag_level: string;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  try { return await handle(req); }
  catch (err) {
    if (err instanceof Response) return err;
    return json({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
  await authenticate(req, admin);

  const body = await req.json().catch(() => ({})) as
    { force?: boolean; dry_run?: boolean; day?: number };

  const { data: job } = await admin
    .from('freight_rate_probe_jobs')
    .select('*').eq('status', 'active')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!job) return json({ ok: true, idle: true, reason: 'no active probe job' });

  const dayIndex = body.day
    ?? (daysBetween(job.started_on as string, utcToday()) + 1);
  const isReportDay = REPORT_DAYS.includes(dayIndex);
  if (!isReportDay && !body.force) {
    return json({ ok: true, idle: true, day_index: dayIndex, reason: 'not a reporting day (2, 4, 7)' });
  }

  // is_cheapest is set by the probe on the best CAD rate per (order, ship date,
  // run), which is the only rate anyone would act on. Every carrier option is
  // still in the table if a question needs it.
  const { data: rows, error: rowsErr } = await admin
    .from('freight_rate_probes')
    .select('order_id, order_ref, customer_name, dest_postal, dest_country, ship_date, ship_weekday, run_index, run_at, carrier, service_level, rate_cad, transit_days, package_count, flag_level')
    .eq('job_id', job.id).eq('is_cheapest', true)
    .order('run_index', { ascending: true }).limit(20000);
  if (rowsErr) return json({ error: `Probe read failed: ${rowsErr.message}` }, 500);

  const probes = dedupe((rows ?? []) as ProbeRow[]);
  if (probes.length === 0) {
    return json({ ok: true, idle: true, day_index: dayIndex, reason: 'no probe rows yet' });
  }

  const report   = buildReport(probes, dayIndex, job.days as number);
  const subject  = `Freight rate probe — day ${dayIndex} of ${job.days}: ${report.headline}`;

  if (body.dry_run) return json({ ok: true, dry_run: true, day_index: dayIndex, subject, text: report.text });

  const sent = await send(admin, subject, report.text, report.html);
  if ('error' in sent) return json({ error: sent.error, day_index: dayIndex }, 502);

  // Day 7 is the end of the campaign: close it and take both schedules down, so
  // the job stops costing anything the moment it stops being useful.
  let finished = false;
  if (dayIndex >= (job.days as number)) {
    const { error } = await admin.rpc('freight_probe_finish', { job: job.id });
    finished = !error;
  }

  return json({
    ok: true, day_index: dayIndex, subject,
    to: TO, cc: CC, message_id: sent.message_id, resend_id: sent.resend_id,
    runs_covered: report.runCount, orders: report.orderCount,
    campaign_closed: finished,
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function buildReport(probes: ProbeRow[], dayIndex: number, totalDays: number) {
  const runs    = [...new Set(probes.map(p => p.run_index))].sort((a, b) => a - b);
  const firstRun = runs[0];
  const lastRun  = runs[runs.length - 1];
  const latest   = probes.filter(p => p.run_index === lastRun);
  const orders   = [...new Map(latest.map(p => [p.order_id, p])).values()];

  // --- cheapest weekday, all destinations -------------------------------
  // Averaged across customers: the absolute rates differ by an order of
  // magnitude between a Toronto and a rural Newfoundland delivery, so a raw
  // minimum would just re-find the nearest customer. What matters is whether a
  // given weekday is systematically cheaper than the others.
  const byWeekday = averageByWeekday(latest);
  const bestDay   = byWeekday[0];
  const worstDay  = byWeekday[byWeekday.length - 1];

  // --- California --------------------------------------------------------
  const califOrders = latest.filter(p => isCalifornia(p));
  const califByDay  = averageByWeekday(califOrders);

  // --- drift -------------------------------------------------------------
  const drift = driftSince(probes, firstRun, lastRun);

  // --- flags -------------------------------------------------------------
  // Flagged on each customer's BEST achievable rate across the week. A customer
  // whose cheapest possible day still costs over $200 is a different problem
  // from one who is merely expensive on a Friday.
  const bestPerOrder = bestRatePerOrder(latest);
  const critical = bestPerOrder.filter(b => b.rate > CRITICAL_CAD);
  const warn     = bestPerOrder.filter(b => b.rate > WARN_CAD && b.rate <= CRITICAL_CAD);

  const headline = bestDay && worstDay && bestDay.day !== worstDay.day
    ? `${WEEKDAYS[bestDay.day]} cheapest, ${pctBelow(bestDay.avg, worstDay.avg)} under ${WEEKDAYS[worstDay.day]}`
    : 'no weekday spread yet';

  const spreadNote = bestDay && worstDay && worstDay.avg > bestDay.avg
    ? `Shipping everything on ${WEEKDAYS[bestDay.day]} rather than ${WEEKDAYS[worstDay.day]} saves about ${money(worstDay.avg - bestDay.avg)} per order across the ${orders.length} confirmed orders — roughly ${money((worstDay.avg - bestDay.avg) * orders.length)} for the batch.`
    : 'Not enough spread between weekdays to call one cheaper yet.';

  // ------------------------------------------------------------------ text
  const text = [
    `FREIGHT RATE PROBE — DAY ${dayIndex} OF ${totalDays}`,
    `${runs.length} run(s) so far, ${orders.length} confirmed orders, ${probes.length} cheapest-rate samples.`,
    `All figures CAD. Freightcom quotes CAD for US destinations too, so nothing is converted.`,
    '',
    'CHEAPEST DAY TO SHIP',
    ...byWeekday.map(w => `  ${WEEKDAYS[w.day].padEnd(10)} ${money(w.avg).padStart(10)}   (${w.n} orders)`),
    '',
    `  ${spreadNote}`,
    '',
    'CALIFORNIA',
    califByDay.length
      ? califByDay.map(w => `  ${WEEKDAYS[w.day].padEnd(10)} ${money(w.avg).padStart(10)}   (${w.n} orders)`).join('\n')
      : '  No California orders in this cohort.',
    califByDay.length ? `  Cheapest for California: ${WEEKDAYS[califByDay[0].day]} at ${money(califByDay[0].avg)} average.` : '',
    '',
    `FLAGGED — over ${money(CRITICAL_CAD)} (critical)`,
    critical.length
      ? critical.map(f => `  !! ${f.order_ref.padEnd(10)} ${f.customer_name.padEnd(22)} ${money(f.rate).padStart(10)}  best day ${WEEKDAYS[f.weekday]}  ${f.postal}`).join('\n')
      : '  None.',
    '',
    `FLAGGED — over ${money(WARN_CAD)} (warn)`,
    warn.length
      ? warn.map(f => `  !  ${f.order_ref.padEnd(10)} ${f.customer_name.padEnd(22)} ${money(f.rate).padStart(10)}  best day ${WEEKDAYS[f.weekday]}  ${f.postal}`).join('\n')
      : '  None.',
    '',
    `RATE DRIFT SINCE RUN ${firstRun}`,
    drift.length
      ? drift.slice(0, 15).map(d => `  ${d.order_ref.padEnd(10)} ${d.customer_name.padEnd(22)} ${money(d.first).padStart(10)} -> ${money(d.last).padStart(10)}  ${signed(d.pct)}%`).join('\n')
      : '  Only one run so far — nothing to compare.',
    '',
    `Sales: ${APP_URL}`,
  ].filter(l => l !== '').join('\n');

  // ------------------------------------------------------------------ html
  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.5;max-width:720px">
  <h2 style="margin:0 0 4px;font-size:18px">Freight rate probe — day ${dayIndex} of ${totalDays}</h2>
  <p style="margin:0 0 16px;color:#666;font-size:13px">
    ${runs.length} run(s), ${orders.length} confirmed orders, ${probes.length} cheapest-rate samples.
    All figures CAD — Freightcom quotes CAD for US destinations too, so nothing is converted.
  </p>

  <h3 style="font-size:15px;margin:20px 0 6px">Cheapest day to ship</h3>
  ${weekdayTable(byWeekday)}
  <p style="margin:10px 0 0;color:#444">${spreadNote}</p>

  <h3 style="font-size:15px;margin:22px 0 6px">California</h3>
  ${califByDay.length ? weekdayTable(califByDay) : '<p style="margin:0;color:#666">No California orders in this cohort.</p>'}

  <h3 style="font-size:15px;margin:22px 0 6px">Flagged</h3>
  ${flagTable('Over ' + money(CRITICAL_CAD), critical, '#b3261e')}
  ${flagTable('Over ' + money(WARN_CAD), warn, '#9a6700')}

  <h3 style="font-size:15px;margin:22px 0 6px">Rate drift since run ${firstRun}</h3>
  ${drift.length ? driftTable(drift.slice(0, 15)) : '<p style="margin:0;color:#666">Only one run so far — nothing to compare.</p>'}

  <p style="margin:24px 0 0;font-size:13px">
    <a href="${APP_URL}" style="color:#1a56db">Open Sales</a>
  </p>
</div>`.trim();

  return { text, html, headline, runCount: runs.length, orderCount: orders.length };
}

// ---------------------------------------------------------------------------
// HTML bits
// ---------------------------------------------------------------------------

const TH = 'style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd;font-size:12px;color:#666;font-weight:600"';
const TD = 'style="padding:6px 10px;border-bottom:1px solid #eee"';

function weekdayTable(rows: Array<{ day: number; avg: number; n: number }>): string {
  return `<table style="border-collapse:collapse;width:100%;max-width:420px">
    <tr><th ${TH}>Ship day</th><th ${TH}>Avg cheapest</th><th ${TH}>Orders</th></tr>
    ${rows.map((w, i) => `<tr>
      <td ${TD}>${WEEKDAYS[w.day]}${i === 0 ? ' <span style="color:#1e7a34;font-size:11px">cheapest</span>' : ''}</td>
      <td ${TD}><strong>${money(w.avg)}</strong></td>
      <td ${TD} >${w.n}</td></tr>`).join('')}
  </table>`;
}

function flagTable(title: string, rows: BestRate[], color: string): string {
  if (!rows.length) return `<p style="margin:0 0 10px;color:#666"><strong>${title}:</strong> none.</p>`;
  return `<p style="margin:12px 0 4px"><strong style="color:${color}">${title}</strong> — ${rows.length} order(s), at their cheapest day:</p>
  <table style="border-collapse:collapse;width:100%">
    <tr><th ${TH}>Order</th><th ${TH}>Customer</th><th ${TH}>Best rate</th><th ${TH}>Best day</th><th ${TH}>Destination</th></tr>
    ${rows.map(f => `<tr>
      <td ${TD}>${esc(f.order_ref)}</td><td ${TD}>${esc(f.customer_name)}</td>
      <td ${TD}><strong style="color:${color}">${money(f.rate)}</strong></td>
      <td ${TD}>${WEEKDAYS[f.weekday]}</td><td ${TD}>${esc(f.postal)}</td></tr>`).join('')}
  </table>`;
}

function driftTable(rows: Drift[]): string {
  return `<table style="border-collapse:collapse;width:100%">
    <tr><th ${TH}>Order</th><th ${TH}>Customer</th><th ${TH}>First run</th><th ${TH}>Latest</th><th ${TH}>Change</th></tr>
    ${rows.map(d => `<tr>
      <td ${TD}>${esc(d.order_ref)}</td><td ${TD}>${esc(d.customer_name)}</td>
      <td ${TD}>${money(d.first)}</td><td ${TD}>${money(d.last)}</td>
      <td ${TD} style="padding:6px 10px;border-bottom:1px solid #eee;color:${d.pct > 0 ? '#b3261e' : '#1e7a34'}">${signed(d.pct)}%</td>
    </tr>`).join('')}
  </table>`;
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

async function send(
  admin: SupabaseClient, subject: string, text: string, html: string,
): Promise<{ message_id: string; resend_id: string } | { error: string }> {
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) return { error: 'RESEND_API_KEY not configured' };

  // Same convention as the other digests: when this is set, everything is
  // redirected so a test run cannot reach the team.
  const testRecipient = Deno.env.get('EMAIL_TEST_RECIPIENT') || null;
  const to = testRecipient ?? TO;
  const cc = testRecipient ? [] : CC;
  const finalSubject = testRecipient ? `[TEST → ${TO}] ${subject}` : subject;

  const { data: msg, error: insErr } = await admin.from('email_messages').insert({
    template_key: 'freight_rate_probe_report',
    recipient_email: to,
    recipient_name: 'Reina',
    subject: finalSubject,
    body: text,
    variables: { cc, day_report: true },
    status: 'queued',
    sent_by: null,
  }).select('id').single();
  if (insErr) return { error: `log insert failed: ${insErr.message}` };
  const msgId = (msg as { id: string }).id;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM, reply_to: 'support@lilacomposter.com',
      to: [to], ...(cc.length ? { cc } : {}),
      subject: finalSubject, text, html,
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text();
    await admin.from('email_messages').update({
      status: 'failed', error: `Resend ${res.status}: ${bodyText.slice(0, 400)}`,
    }).eq('id', msgId);
    return { error: `Resend ${res.status}: ${bodyText.slice(0, 200)}` };
  }

  const sent = await res.json() as { id: string };
  await admin.from('email_messages').update({
    status: 'sent', resend_id: sent.id, sent_at: new Date().toISOString(),
  }).eq('id', msgId);
  return { message_id: msgId, resend_id: sent.id };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}
function utcToday(): string { return new Date().toISOString().slice(0, 10); }
function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
