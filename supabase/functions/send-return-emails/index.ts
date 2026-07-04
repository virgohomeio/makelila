import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';

const REINA = 'reina@virgohome.io';
const GEORGE = 'george@virgohome.io';
const FROM = 'VCycene Team <support@lilacomposter.com>';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const resendKey   = Deno.env.get('RESEND_API_KEY')!;
    const admin = createClient(supabaseUrl, serviceKey);

    const { return_id } = await req.json() as { return_id?: string };
    if (!return_id) {
      return json({ error: 'return_id required' }, 400);
    }

    const { data: ret, error: retErr } = await admin
      .from('returns')
      .select('*')
      .eq('id', return_id)
      .single();

    if (retErr || !ret) return json({ error: 'Return not found' }, 404);

    // Only process returns created within the last 2 hours (prevent replay)
    if (Date.now() - new Date(ret.created_at).getTime() > 7_200_000) {
      return json({ error: 'Too old to notify' }, 409);
    }

    // Look up linked order for purchase date + amount
    const { data: order } = await admin
      .from('orders')
      .select('placed_at, total_usd, customer_name, payment_methods')
      .eq('order_ref', ret.original_order_ref)
      .maybeSingle();

    const purchaseDate      = order?.placed_at ? new Date(order.placed_at) : null;
    const daysSincePurchase = purchaseDate
      ? Math.floor((Date.now() - purchaseDate.getTime()) / 86_400_000)
      : null;
    const withinPolicy = daysSincePurchase !== null ? daysSincePurchase <= 30 : null;

    // 7-day signed URL for proof of purchase
    let proofUrl: string | null = null;
    if (ret.purchase_proof) {
      const { data: signed } = await admin.storage
        .from('return-documents')
        .createSignedUrl(ret.purchase_proof, 60 * 60 * 24 * 7);
      proofUrl = signed?.signedUrl ?? null;
    }

    // Extract customer reference from notes (e.g. "Customer reference: CRT-12345")
    const custRef = (ret.notes as string | null)?.match(/CRT-\d+/)?.[0] ?? return_id.slice(0, 8).toUpperCase();

    await Promise.all([
      // 1. Customer confirmation
      postResend(resendKey, {
        from: FROM,
        to: [ret.customer_email],
        subject: `Your Return Application Received — Ref. ${custRef}`,
        html: customerHtml(ret, custRef),
      }),
      // 2. Internal review for Reina + George
      postResend(resendKey, {
        from: FROM,
        reply_to: ret.customer_email,
        to: [REINA, GEORGE],
        subject: `[Return Review] ${ret.original_order_ref} — ${ret.customer_name}` +
          (withinPolicy === false ? ' ⚠ Past 30 Days' : withinPolicy === true ? ' ✓ Within Policy' : ''),
        html: internalHtml(ret, order, daysSincePurchase, withinPolicy, proofUrl, custRef),
      }),
    ]);

    return json({ ok: true });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}

async function postResend(key: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

function fmt(val: unknown): string {
  if (val === null || val === undefined) return '—';
  if (Array.isArray(val)) return (val as unknown[]).join(', ') || '—';
  return String(val);
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });
}

function fmtAmount(usd: number | null | undefined): string {
  if (usd == null) return '—';
  return `$${Number(usd).toFixed(2)} USD`;
}

// ── Customer confirmation email ───────────────────────────────────────────────

function customerHtml(ret: Record<string, unknown>, custRef: string): string {
  const firstName = (ret.customer_name as string).split(' ')[0];
  return `<!DOCTYPE html>
<html><body style="font-family:sans-serif;color:#1a202c;max-width:600px;margin:auto;padding:24px">
<h2 style="color:#2d6a4f">Return Application Received</h2>
<p>Hi ${firstName},</p>
<p>We've received your return application for order <strong>${fmt(ret.original_order_ref)}</strong>.
Our team will review your submission and be in touch within <strong>2 business days</strong>.</p>

<div style="background:#f0fff4;border-left:4px solid #38a169;padding:12px 16px;border-radius:4px;margin:16px 0">
  <strong>Your reference number: ${custRef}</strong><br/>
  <small style="color:#4a5568">Please save this for any follow-up correspondence.</small>
</div>

<h3 style="color:#2d6a4f">What happens next</h3>
<ol style="line-height:2">
  <li><strong>Data verification</strong> — Our customer service team checks your submission against our records (order number, purchase date, proof of purchase).</li>
  <li><strong>Manager approval</strong> — A decision is made to approve or deny the return.</li>
  <li><strong>We'll email you</strong> — You'll receive an email with the outcome and, if approved, next steps for scheduling pickup.</li>
</ol>

<h3 style="color:#2d6a4f">Your submission summary</h3>
<table style="width:100%;border-collapse:collapse;font-size:14px">
  <tr style="background:#f7fafc">
    <td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;width:40%">Order number</td>
    <td style="padding:8px 12px;border:1px solid #e2e8f0">${fmt(ret.original_order_ref)}</td>
  </tr>
  <tr>
    <td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600">Return category</td>
    <td style="padding:8px 12px;border:1px solid #e2e8f0">${fmt(ret.return_category)}</td>
  </tr>
  <tr style="background:#f7fafc">
    <td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600">Reasons</td>
    <td style="padding:8px 12px;border:1px solid #e2e8f0">${fmt(ret.return_reasons)}</td>
  </tr>
  <tr>
    <td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600">Unit condition</td>
    <td style="padding:8px 12px;border:1px solid #e2e8f0">${fmt(ret.condition)}</td>
  </tr>
  <tr style="background:#f7fafc">
    <td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600">Refund preference</td>
    <td style="padding:8px 12px;border:1px solid #e2e8f0">${fmt(ret.refund_method_preference)}</td>
  </tr>
  <tr>
    <td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600">Proof of purchase</td>
    <td style="padding:8px 12px;border:1px solid #e2e8f0">✓ Uploaded</td>
  </tr>
</table>

<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
<p style="color:#4a5568;font-size:14px">Questions? Reply to this email or contact us at
  <a href="mailto:support@lilacomposter.com">support@lilacomposter.com</a>.</p>
<p style="color:#4a5568;font-size:14px">— The VCycene Team</p>
</body></html>`;
}

// ── Internal review email ─────────────────────────────────────────────────────

function internalHtml(
  ret: Record<string, unknown>,
  order: Record<string, unknown> | null,
  daysSincePurchase: number | null,
  withinPolicy: boolean | null,
  proofUrl: string | null,
  custRef: string,
): string {
  const policyBadge = withinPolicy === true
    ? '<span style="background:#c6f6d5;color:#276749;padding:2px 8px;border-radius:4px;font-weight:600">✓ Within 30 days</span>'
    : withinPolicy === false
    ? '<span style="background:#fed7d7;color:#c53030;padding:2px 8px;border-radius:4px;font-weight:600">⚠ Past 30 days — George must decide</span>'
    : '<span style="background:#fefcbf;color:#744210;padding:2px 8px;border-radius:4px;font-weight:600">? Order not found in system</span>';

  const nameMismatch = order?.customer_name &&
    (order.customer_name as string).toLowerCase().trim() !== (ret.customer_name as string).toLowerCase().trim();
  const nameFlag = nameMismatch
    ? `<br/><span style="color:#c53030;font-size:12px">⚠ Order has: "${fmt(order!.customer_name)}" — verify identity</span>`
    : '';

  const r = (label: string, value: string, warn = false) => `
  <tr style="${warn ? 'background:#fffaf0' : ''}">
    <td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;width:36%;vertical-align:top;color:#4a5568">${label}</td>
    <td style="padding:8px 12px;border:1px solid #e2e8f0">${value}</td>
  </tr>`;

  return `<!DOCTYPE html>
<html><body style="font-family:sans-serif;color:#1a202c;max-width:720px;margin:auto;padding:24px">
<h2 style="color:#2b6cb0;margin-bottom:4px">Return Application — Internal Review</h2>
<p style="color:#718096;margin-top:0">Submitted ${fmtDate(ret.created_at as string)} via the Return Application form.</p>

<div style="background:#ebf8ff;border:1px solid #90cdf4;padding:14px 18px;border-radius:6px;margin:16px 0;font-size:14px">
  <strong>Action required:</strong>
  <ol style="margin:6px 0;padding-left:18px;line-height:2">
    <li><strong>Reina:</strong> Verify the data below against the order record. Flag any discrepancies in your reply.</li>
    <li><strong>Reina → George:</strong> Forward with your recommendation (approve / deny / needs info).</li>
    <li><strong>George:</strong> Make the final decision in makeLILA → PostShipment → Refunds.</li>
  </ol>
</div>

<h3 style="border-bottom:2px solid #e2e8f0;padding-bottom:6px;color:#2b6cb0">Policy & Financial Checks</h3>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
  ${r('Reference', custRef)}
  ${r('Order number', fmt(ret.original_order_ref))}
  ${r('30-day policy', `${policyBadge}${daysSincePurchase !== null ? ` &nbsp;—&nbsp; ${daysSincePurchase} days since purchase (${fmtDate(order?.placed_at as string)})` : ''}`, withinPolicy === false)}
  ${r('Sale amount (system)', fmtAmount(order?.total_usd as number), !order)}
  ${r('Payment method', fmt(order?.payment_methods))}
  ${r('Proof of purchase', proofUrl
    ? `<a href="${proofUrl}" target="_blank" style="color:#3182ce;font-weight:600">View document ↗</a> <span style="color:#718096;font-size:12px">(link valid 7 days)</span>`
    : '<span style="color:#c53030">Not available</span>')}
</table>

<h3 style="border-bottom:2px solid #e2e8f0;padding-bottom:6px;color:#2b6cb0">Customer Information</h3>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
  ${r('Name (submitted)', `${fmt(ret.customer_name)}${nameFlag}`, !!nameMismatch)}
  ${r('Email', `<a href="mailto:${ret.customer_email}" style="color:#3182ce">${fmt(ret.customer_email)}</a>`)}
  ${r('Phone', fmt(ret.customer_phone))}
  ${r('Country', fmt(ret.channel))}
  ${r('Unit serial', fmt(ret.unit_serial))}
</table>

<h3 style="border-bottom:2px solid #e2e8f0;padding-bottom:6px;color:#2b6cb0">Return Details</h3>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
  ${r('Return category', fmt(ret.return_category))}
  ${r('Reasons selected', fmt(ret.return_reasons))}
  ${r('Description', `<span style="white-space:pre-wrap;font-size:13px">${fmt(ret.description)}</span>`)}
  ${r('Support contacted?', fmt(ret.support_contacted))}
  ${r('Usage duration', fmt(ret.usage_duration))}
  ${r('Experience rating', fmt(ret.experience_rating) !== '—' ? `${fmt(ret.experience_rating)} / 5` : '—')}
  ${r('Would have changed decision', fmt(ret.would_change_decision))}
  ${r('Future likelihood', fmt(ret.future_likelihood))}
</table>

<h3 style="border-bottom:2px solid #e2e8f0;padding-bottom:6px;color:#2b6cb0">Unit & Logistics</h3>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
  ${r('Unit condition', fmt(ret.condition))}
  ${r('Packaging status', fmt(ret.packaging_status))}
  ${r('Alternative composting plan', fmt(ret.alternative_composting))}
</table>

<h3 style="border-bottom:2px solid #e2e8f0;padding-bottom:6px;color:#2b6cb0">Refund Preference</h3>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
  ${r('Method', fmt(ret.refund_method_preference))}
  ${r('Contact', fmt(ret.refund_contact))}
</table>

${ret.additional_comments
  ? `<h3 style="border-bottom:2px solid #e2e8f0;padding-bottom:6px;color:#2b6cb0">Additional Comments</h3>
     <p style="font-style:italic;color:#4a5568;background:#f7fafc;padding:12px;border-radius:4px;font-size:14px">"${fmt(ret.additional_comments)}"</p>`
  : ''}

<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
<p style="color:#a0aec0;font-size:12px">makeLILA Return Application · ${fmtDate(ret.created_at as string)}</p>
</body></html>`;
}
