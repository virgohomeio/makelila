// Cancellation-side twin of send-return-emails: a cancellation form is a
// refund request the moment it's submitted, so it lands on the Refunds board's
// Cancellation Requests column immediately — and Reina, who owns that column,
// has to hear about it without watching the board.
//
// Internal notification only. The customer already gets their reference number
// on the success screen; nothing here emails them.
//
// Invoked fire-and-forget from the public /cancel-order form (no user JWT).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';

const REINA = 'reina@virgohome.io';
const FROM = 'VCycene Team <support@lilacomposter.com>';
const BOARD_URL = 'https://lila.vip/fulfillment/refunds';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const resendKey   = Deno.env.get('RESEND_API_KEY')!;
    const admin = createClient(supabaseUrl, serviceKey);

    const { cancellation_id } = await req.json() as { cancellation_id?: string };
    if (!cancellation_id) return json({ error: 'cancellation_id required' }, 400);

    const { data: c, error: cErr } = await admin
      .from('order_cancellations')
      .select('*')
      .eq('id', cancellation_id)
      .single();

    if (cErr || !c) return json({ error: 'Cancellation not found' }, 404);

    // Only notify on fresh submissions (prevents replay against old rows).
    if (Date.now() - new Date(c.created_at).getTime() > 7_200_000) {
      return json({ error: 'Too old to notify' }, 409);
    }

    const order = await findOrder(admin, c.order_ref as string | null);

    // The one question that decides what this case even is: if the unit has
    // shipped, it can't be cancelled and belongs in Returns instead. Our own
    // shipping record is the authority; what the customer ticked is the
    // cross-check, and the two disagreeing is itself worth flagging.
    const shipped = !!(order?.shipped_at) || !!(order?.delivered_at);
    const claimsReceived = c.product_received === true;

    // The reference the customer was told to quote (form writes it into
    // ops_notes as "Customer reference: CCR-12345").
    const custRef = (c.ops_notes as string | null)?.match(/CCR-\d+/)?.[0]
      ?? (cancellation_id as string).slice(0, 8).toUpperCase();

    const flag = shipped || claimsReceived ? ' ⚠ Already shipped' : '';

    await postResend(resendKey, {
      from: FROM,
      // Reina works these by replying to the customer, so reply hits them
      // directly rather than the shared support inbox.
      reply_to: c.customer_email,
      to: [REINA],
      subject: `[Cancellation Request] ${c.order_ref ?? 'no order #'} — ${c.customer_name}${flag}`,
      html: internalHtml(c, order, shipped, claimsReceived, custRef),
    });

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

/** Customers type "1183"; our orders table stores "#1183". Matching literally
 *  would report "not in system" for almost every real submission, so try the
 *  form as given and the other spelling of it. */
async function findOrder(
  admin: ReturnType<typeof createClient>,
  orderRef: string | null,
): Promise<Record<string, unknown> | null> {
  const raw = orderRef?.trim();
  if (!raw) return null;
  const bare = raw.replace(/^#/, '');
  const candidates = [...new Set([raw, `#${bare}`, bare])];

  const { data } = await admin
    .from('orders')
    .select('order_ref, status, placed_at, total_usd, payment_methods, financial_status, shipped_at, delivered_at, tracking_num, carrier, customer_name')
    .in('order_ref', candidates)
    .limit(1);

  return (data?.[0] as Record<string, unknown> | undefined) ?? null;
}

async function postResend(key: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

function esc(val: unknown): string {
  if (val === null || val === undefined || val === '') return '—';
  const s = Array.isArray(val) ? (val as unknown[]).join(', ') : String(val);
  return s === ''
    ? '—'
    : s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtDate(iso: unknown): string {
  if (!iso) return '—';
  return new Date(String(iso)).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });
}

function fmtAmount(usd: unknown): string {
  if (usd === null || usd === undefined) return '—';
  return `$${Number(usd).toFixed(2)}`;
}

// ── Internal notification email ──────────────────────────────────────────────

function internalHtml(
  c: Record<string, unknown>,
  order: Record<string, unknown> | null,
  shipped: boolean,
  claimsReceived: boolean,
  custRef: string,
): string {
  const r = (label: string, value: string, warn = false) => `
  <tr style="${warn ? 'background:#fffaf0' : ''}">
    <td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;width:36%;vertical-align:top;color:#4a5568">${label}</td>
    <td style="padding:8px 12px;border:1px solid #e2e8f0">${value}</td>
  </tr>`;

  const shippingBadge = shipped
    ? `<span style="background:#fed7d7;color:#c53030;padding:2px 8px;border-radius:4px;font-weight:600">⚠ Already shipped — cannot cancel, route to Returns</span>`
    : order
    ? `<span style="background:#c6f6d5;color:#276749;padding:2px 8px;border-radius:4px;font-weight:600">✓ Not yet shipped — cancellable</span>`
    : `<span style="background:#fefcbf;color:#744210;padding:2px 8px;border-radius:4px;font-weight:600">? Order not found in makeLILA — verify the number</span>`;

  // Our record and the customer's answer disagreeing is the case most likely
  // to be worked the wrong way, so it gets called out rather than buried.
  const mismatch = shipped !== claimsReceived && !!order
    ? `<div style="background:#fffaf0;border:1px solid #f6ad55;padding:10px 14px;border-radius:6px;margin:12px 0;font-size:13px;color:#744210">
         <strong>Heads up:</strong> our shipping record says
         ${shipped ? 'this order has shipped' : 'this order has not shipped'},
         but the customer answered
         "${claimsReceived ? 'Yes' : 'No'}" to already having the product. Confirm before acting.
       </div>`
    : '';

  const nameMismatch = order?.customer_name &&
    String(order.customer_name).toLowerCase().trim() !== String(c.customer_name).toLowerCase().trim()
    ? `<br/><span style="color:#c53030;font-size:12px">⚠ Order is under "${esc(order.customer_name)}" — verify identity</span>`
    : '';

  return `<!DOCTYPE html>
<html><body style="font-family:sans-serif;color:#1a202c;max-width:720px;margin:auto;padding:24px">
<h2 style="color:#b7791f;margin-bottom:4px">Cancellation Request — Action Required</h2>
<p style="color:#718096;margin-top:0">Submitted ${fmtDate(c.created_at)} via the Order Cancellation form.</p>

<div style="background:#fffbeb;border:1px solid #f6e05e;padding:14px 18px;border-radius:6px;margin:16px 0;font-size:14px">
  <strong>This is already a card on your board.</strong>
  It's waiting in <strong>Refunds → Cancellation Requests</strong>. Compile it into a
  refund request, or close it as "No refund needed" if nothing was ever charged.
  <div style="margin-top:12px">
    <a href="${BOARD_URL}" style="background:#b7791f;color:#fff;text-decoration:none;padding:9px 18px;border-radius:5px;font-weight:700;display:inline-block">Open the Refunds board ↗</a>
  </div>
</div>

${mismatch}

<h3 style="border-bottom:2px solid #e2e8f0;padding-bottom:6px;color:#b7791f">Can this still be cancelled?</h3>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
  ${r('Shipping status', shippingBadge, shipped || !order)}
  ${r('Customer already has it?', c.product_received === null || c.product_received === undefined ? '—' : claimsReceived ? 'Yes' : 'No', claimsReceived)}
  ${r('Tracking', order?.tracking_num ? `${esc(order.tracking_num)} (${esc(order.carrier)})` : '—')}
</table>

<h3 style="border-bottom:2px solid #e2e8f0;padding-bottom:6px;color:#b7791f">Order</h3>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
  ${r('Reference', esc(custRef))}
  ${r('Order number (as typed)', esc(c.order_ref), !order)}
  ${r('Order in makeLILA', order ? `${esc(order.order_ref)} · status ${esc(order.status)}` : '<span style="color:#c53030">Not found</span>', !order)}
  ${r('Order date', `${fmtDate(c.order_date)}${order?.placed_at ? ` <span style="color:#718096;font-size:12px">(system: ${fmtDate(order.placed_at)})</span>` : ''}`)}
  ${r('Product / Service', esc(c.product_name))}
  ${r('Amount (as stated)', c.order_amount_usd == null ? '—' : fmtAmount(c.order_amount_usd))}
  ${r('Amount (system)', fmtAmount(order?.total_usd))}
  ${r('Payment method', esc(order?.payment_methods))}
  ${r('Financial status', esc(order?.financial_status))}
  ${r('Purchase channel', esc(c.purchase_channel))}
</table>

<h3 style="border-bottom:2px solid #e2e8f0;padding-bottom:6px;color:#b7791f">Customer</h3>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
  ${r('Name', `${esc(c.customer_name)}${nameMismatch}`, !!nameMismatch)}
  ${r('Email', `<a href="mailto:${esc(c.customer_email)}" style="color:#3182ce">${esc(c.customer_email)}</a>`)}
  ${r('Phone', c.customer_phone ? `<a href="tel:${esc(c.customer_phone)}" style="color:#3182ce">${esc(c.customer_phone)}</a>` : '—')}
  ${r('Prefers to be reached by', esc(c.preferred_contact))}
</table>

<h3 style="border-bottom:2px solid #e2e8f0;padding-bottom:6px;color:#b7791f">What they asked for</h3>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
  ${r('Reason', esc(c.reason))}
  ${r('Desired resolution', esc(c.desired_resolution))}
  ${r('Explanation', `<span style="white-space:pre-wrap;font-size:13px">${esc(c.description)}</span>`)}
</table>

<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
<p style="color:#718096;font-size:13px">Replying to this email goes straight to the customer.</p>
</body></html>`;
}
