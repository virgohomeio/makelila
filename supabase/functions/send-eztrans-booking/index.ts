// Confirm an order with the EZ Trans 3PL after it has been booked on
// Goorooship: the packing list they pick from and the shipping label they
// print, both attached.
//
// Operator path: Fulfillment > Queue > step 3 (Attach the shipping label).
// The panel only appears when the unit assigned at step 1 is held at EZTrans,
// and it will not send until carrier, tracking number and label are on the
// queue row.
//
// The email body and packing list are mirrored in app/src/lib/eztrans.ts (the
// operator's preview). This copy is the one that goes on the wire — keep them
// in step.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';
import { buildTextPdf, toBase64, type PdfLine } from '../_shared/simplePdf.ts';

const EZTRANS_LOCATION = 'EZTrans';
const EZTRANS_EMAIL = 'cs@goorooship.ca';
const PRODUCT_NAME = 'LILA Kitchen Composter';
const SKU = 'LILA-P100X';
const BATCH_LOT = 'P100X';
const QUANTITY = 1;

type QueueRow = {
  id: string;
  order_id: string;
  step: number;
  assigned_serial: string | null;
  carrier: string | null;
  tracking_num: string | null;
  label_pdf_path: string | null;
};

type OrderRow = {
  order_ref: string;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  address_line: string | null;
  address_line2: string | null;
  city: string;
  region_state: string | null;
  postal_code: string | null;
  country: 'US' | 'CA';
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}

/** EZ-P01 -> "1". A group that isn't a numbered pallet (the un-manifested
 *  EZ-S2 / EZ-S3 shipments) passes through as-is rather than being given an
 *  invented carton number. Mirrors masterCartonFromSkid in lib/eztrans.ts. */
function masterCartonFromSkid(skid: string | null): string | null {
  if (!skid) return null;
  const key = skid.trim();
  if (!key) return null;
  const m = /^(?:[A-Z]{2}-)?P0*(\d+)$/i.exec(key);
  return m ? String(Number(m[1])) : key;
}

function addressLines(o: OrderRow): string[] {
  const lines: string[] = [];
  if (o.address_line) lines.push(o.address_line);
  if (o.address_line2) lines.push(o.address_line2);
  const cityLine = [o.city, o.region_state, o.postal_code].filter(Boolean).join(', ');
  if (cityLine) lines.push(cityLine);
  lines.push(o.country);
  return lines;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  try {
    return await handle(req);
  } catch (err) {
    return json(500, { error: `Uncaught: ${(err as Error)?.message ?? String(err)}` });
  }
});

async function handle(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!supabaseUrl || !serviceKey || !resendKey) {
    return json(500, { error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / RESEND_API_KEY' });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  let caller;
  try { caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  if (caller.kind !== 'user') {
    return json(403, { error: 'This function requires an operator JWT — cron-secret not accepted.' });
  }

  const body = await req.json() as { queue_id?: string };
  if (!body.queue_id) return json(400, { error: 'queue_id required' });

  const { data: q, error: qErr } = await admin
    .from('fulfillment_queue')
    .select('id, order_id, step, assigned_serial, carrier, tracking_num, label_pdf_path')
    .eq('id', body.queue_id)
    .single<QueueRow>();
  if (qErr || !q) return json(404, { error: 'queue row not found' });
  if (!q.assigned_serial) {
    return json(409, { error: 'no unit is assigned to this order yet — finish step 1 first' });
  }
  if (q.step < 3) {
    return json(409, { error: `queue row at step ${q.step}, must be at or past step 3` });
  }
  // EZ Trans cannot ship what they cannot label. The panel disables the button
  // until all three are on the row, but an email that reached the 3PL without
  // a label would cost a day of back-and-forth, so refuse here too.
  if (!q.carrier || !q.tracking_num) {
    return json(409, { error: 'carrier and tracking number are required before EZ Trans can be emailed' });
  }
  if (!q.label_pdf_path) {
    return json(409, { error: 'the shipping label PDF must be attached before EZ Trans can be emailed' });
  }

  const { data: order, error: oErr } = await admin
    .from('orders')
    .select('order_ref, customer_name, customer_email, customer_phone, address_line, address_line2, city, region_state, postal_code, country')
    .eq('id', q.order_id)
    .single<OrderRow>();
  if (oErr || !order) return json(404, { error: 'order not found' });

  // Re-derive the location and carton from the DB rather than trusting the
  // caller: the packing list is what the 3PL picks from, and a stale preview
  // must not be able to put a different pallet on it.
  const [slotRes, unitRes] = await Promise.all([
    admin.from('shelf_slots').select('skid, location').eq('serial', q.assigned_serial),
    admin.from('units').select('location, pallet').eq('serial', q.assigned_serial).maybeSingle(),
  ]);
  const slots = (slotRes.data as Array<{ skid: string; location: string }> | null) ?? [];
  const slot = slots.find(s => s.location === EZTRANS_LOCATION) ?? null;
  const unit = (unitRes.data as { location: string | null; pallet: string | null } | null) ?? null;

  if (!slot && unit?.location !== EZTRANS_LOCATION) {
    return json(409, {
      error: `unit ${q.assigned_serial} is not held at ${EZTRANS_LOCATION} — book this shipment through Freightcom instead`,
    });
  }

  const masterCarton = masterCartonFromSkid(slot?.skid ?? unit?.pallet ?? null) ?? '—';
  const serial = q.assigned_serial;
  const addr = addressLines(order);
  const email = order.customer_email ?? '—';
  const phone = order.customer_phone ?? '—';

  const text =
    `Hello EZ Trans team,\n\n` +
    `We are confirming that an order has been placed and the shipment has been ` +
    `booked on Goorooship. Please fulfill it on your end. The packing list and ` +
    `the shipping label are attached to this email.\n\n` +
    `CUSTOMER\n` +
    `Name: ${order.customer_name}\n` +
    `Address: ${addr.join('\n         ')}\n` +
    `Email: ${email}\n` +
    `Phone: ${phone}\n\n` +
    `SHIPMENT\n` +
    `Product Name: ${PRODUCT_NAME}\n` +
    `SKU: ${SKU}\n` +
    `Serial No: ${serial}\n` +
    `Batch/Lot Number: ${BATCH_LOT}\n` +
    `Master Carton: ${masterCarton}\n` +
    `Quantity: ${QUANTITY}\n\n` +
    `SHIPPING LABEL (attached)\n` +
    `Carrier: ${q.carrier}\n` +
    `Tracking Number: ${q.tracking_num}\n` +
    `Please print the attached label and affix it to the carton.\n\n` +
    `Order reference: ${order.order_ref}\n\n` +
    `Please reply to confirm once the unit is picked and the shipment is on its way.\n\n` +
    `Thank you,\n` +
    `The VCycene Team`;

  const pdfLines: PdfLine[] = [
    { text: 'PACKING LIST', size: 18, bold: true, gap: 4 },
    { text: `Order: ${order.order_ref}`, size: 10 },
    { text: `Date: ${new Date().toISOString().slice(0, 10)}`, size: 10, gap: 14 },

    { text: 'SHIP TO', size: 11, bold: true, gap: 2 },
    { text: order.customer_name, size: 10, bold: true },
    ...addr.map((l): PdfLine => ({ text: l, size: 10 })),
    { text: `Email: ${email}`, size: 10 },
    { text: `Phone: ${phone}`, size: 10, gap: 14 },

    { text: 'CONTENTS', size: 11, bold: true, gap: 2 },
    { text: `Product Name: ${PRODUCT_NAME}`, size: 10 },
    { text: `SKU: ${SKU}`, size: 10 },
    { text: `Serial No: ${serial}`, size: 10 },
    { text: `Batch/Lot Number: ${BATCH_LOT}`, size: 10 },
    { text: `Master Carton: ${masterCarton}`, size: 10 },
    { text: `Quantity: ${QUANTITY}`, size: 10, gap: 14 },

    { text: 'SHIPPING', size: 11, bold: true, gap: 2 },
    { text: `Carrier: ${q.carrier}`, size: 10 },
    { text: `Tracking No: ${q.tracking_num}`, size: 10, gap: 18 },

    { text: 'VCycene Inc. — LILA Composter', size: 9 },
    { text: 'Questions: support@lilacomposter.com', size: 9 },
  ];
  const pdf = toBase64(buildTextPdf(pdfLines));
  const safeRef = order.order_ref.replace(/[^A-Za-z0-9._-]/g, '');

  // The label the operator attached in step 3, straight out of the private
  // bucket. Read with the service role — `order-labels` is not public and the
  // 3PL has no makeLILA login, so a signed URL would be a second thing to
  // expire; the bytes ride along with the email instead.
  const { data: labelBlob, error: labelErr } = await admin.storage
    .from('order-labels')
    .download(q.label_pdf_path);
  if (labelErr || !labelBlob) {
    return json(502, { error: `could not read the shipping label (${q.label_pdf_path}): ${labelErr?.message ?? 'not found'}` });
  }
  const labelPdf = toBase64(new Uint8Array(await labelBlob.arrayBuffer()));

  // Same testing override as send-fulfillment-email: while
  // EMAIL_TEST_RECIPIENT is set nothing reaches the 3PL.
  const testRecipient = Deno.env.get('EMAIL_TEST_RECIPIENT');
  const to = testRecipient || EZTRANS_EMAIL;
  const baseSubject = `Order confirmed — ${order.order_ref} · ${SKU} · Serial ${serial}`;
  const subject = testRecipient ? `[TEST → ${EZTRANS_EMAIL}] ${baseSubject}` : baseSubject;
  const emailText = testRecipient
    ? `*** TEST MODE — this email would have been sent to ${EZTRANS_EMAIL} ***\n` +
      `*** EMAIL_TEST_RECIPIENT is set on the edge function; unset to go live ***\n\n` +
      text
    : text;

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'VCycene Team <support@lilacomposter.com>',
      reply_to: 'support@lilacomposter.com',
      to: [to],
      subject,
      text: emailText,
      attachments: [
        { filename: `shipping-label-${safeRef}.pdf`, content: labelPdf },
        { filename: `packing-list-${safeRef}.pdf`, content: pdf },
      ],
    }),
  });
  if (!resendRes.ok) {
    const bodyText = await resendRes.text();
    return json(502, { error: `Resend ${resendRes.status}: ${bodyText.slice(0, 400)}` });
  }
  const sent = await resendRes.json() as { id: string };

  return json(200, { email_id: sent.id, master_carton: masterCarton, to, attachments: 2 });
}
