// Confirm an order with the EZ Trans 3PL after it has been booked on
// Goorooship: the shipping label they print and the packing list they pick
// from, merged into one attachment, plus — on a UPS booking — the FIFRA
// pesticide worksheet UPS Supply Chain Solutions needs to broker the entry.
//
// Operator path: Fulfillment > Queue > step 3 (Attach the shipping label).
// The panel only appears when the unit assigned at step 1 is held at EZTrans,
// and it will not send until carrier, tracking number and label are on the
// queue row.
//
// Sent through Gmail as the From address, so the booking lands in that
// person's Sent folder and the reply from the 3PL threads into their inbox —
// a record, from their end, that EZ Trans was told. Resend cannot do that at
// any setting: it has no access to a mailbox, so mail it sends "from" someone
// leaves no trace in their account. Resend stays as the fallback for when the
// Gmail service account isn't configured, and says so rather than going quiet.
//
// The wording comes from the operator's edit for this order, else the
// `eztrans_booking` row in email_templates, else the built-in default in
// _shared/eztransTemplate.ts. The packing list resolves the same way through
// `eztrans_packing_list`. Whichever wording wins, every {{variable}} is
// filled from the DB here — an edited document cannot put a serial, carton or
// tracking number on the wire that the queue row does not say.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';
import { buildTextPdf, toBase64 } from '../_shared/simplePdf.ts';
import { mergePdfs } from '../_shared/pdfMerge.ts';
import { pngToPdfImage } from '../_shared/pngToPdfImage.ts';
import {
  formatWorksheetDate,
  pesticideWorksheetLines,
  SIGNATURE_BUCKET,
  SIGNATURE_PATH,
} from '../_shared/pesticideWorksheet.ts';
import { getGmailAccessToken, type ServiceAccountKey } from '../_shared/gmail-auth.ts';
import { GMAIL_SEND_SCOPE, sendGmailMessage } from '../_shared/gmailSend.ts';
import {
  DEFAULT_EZTRANS_BODY,
  DEFAULT_EZTRANS_PACKING_LIST,
  DEFAULT_EZTRANS_SUBJECT,
  EZTRANS_CC_DEFAULT,
  EZTRANS_FROM_DEFAULT,
  EZTRANS_FROM_FALLBACK,
  EZTRANS_PACKING_LIST_KEY,
  EZTRANS_TEMPLATE_KEY,
  attachmentsNote,
  needsPesticideWorksheet,
  packingListLines,
  renderEzTransTemplate,
} from '../_shared/eztransTemplate.ts';

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

  const body = await req.json() as {
    queue_id?: string; subject?: string; body?: string; packing_list?: string;
  };
  if (!body.queue_id) return json(400, { error: 'queue_id required' });

  // The operator may have edited the wording in the step-3 panel. Both halves
  // must arrive together — a subject with no body (or the reverse) means the
  // caller is confused, and silently filling the gap from the template would
  // send a half-edited email.
  const hasOverride = body.subject !== undefined || body.body !== undefined;
  if (hasOverride) {
    if (typeof body.subject !== 'string' || typeof body.body !== 'string') {
      return json(400, { error: 'subject and body must be sent together' });
    }
    if (!body.subject.trim() || !body.body.trim()) {
      return json(400, { error: 'an edited subject and body cannot be empty' });
    }
    if (body.subject.length > 300) return json(400, { error: 'subject is too long (max 300 characters)' });
    if (body.body.length > 20000) return json(400, { error: 'body is too long (max 20000 characters)' });
  }

  // The packing list is edited independently of the wording, so it is checked
  // on its own terms. An empty one is refused rather than quietly falling back
  // to the default: the operator cleared the document the 3PL picks from, and
  // sending a stock list instead of the one they meant is worse than an error.
  const hasPackingOverride = body.packing_list !== undefined;
  if (hasPackingOverride) {
    if (typeof body.packing_list !== 'string') {
      return json(400, { error: 'packing_list must be a string' });
    }
    if (!body.packing_list.trim()) {
      return json(400, { error: 'an edited packing list cannot be empty' });
    }
    if (body.packing_list.length > 20000) {
      return json(400, { error: 'packing list is too long (max 20000 characters)' });
    }
  }

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

  // Wording, in order of precedence: what the operator typed for this order,
  // the Templates-tab row, then the built-in default. Whichever wins, the
  // variables are filled from the DB here — an edited body still cannot put a
  // serial or carton on the wire that the row does not say.
  const vars: Record<string, string> = {
    customer_name: order.customer_name,
    customer_address: addr.join('\n         '),
    customer_email: email,
    customer_phone: phone,
    product_name: PRODUCT_NAME,
    sku: SKU,
    serial,
    batch_lot: BATCH_LOT,
    master_carton: masterCarton,
    quantity: String(QUANTITY),
    carrier: q.carrier,
    tracking: q.tracking_num,
    order_ref: order.order_ref,
    // The PDF wants the address on its own lines; the email indents
    // continuation lines under "Address: " instead.
    customer_address_block: addr.join('\n'),
    date: new Date().toISOString().slice(0, 10),
    attachments_note: attachmentsNote(q.carrier),
  };

  let tplSubject = DEFAULT_EZTRANS_SUBJECT;
  let tplBody = DEFAULT_EZTRANS_BODY;
  if (!hasOverride) {
    const { data: tpl } = await admin
      .from('email_templates')
      .select('subject, body, active')
      .eq('key', EZTRANS_TEMPLATE_KEY)
      .maybeSingle();
    const row = tpl as { subject: string; body: string; active: boolean } | null;
    if (row?.active && row.subject && row.body) {
      tplSubject = row.subject;
      tplBody = row.body;
    }
  }

  let tplPackingList = DEFAULT_EZTRANS_PACKING_LIST;
  if (!hasPackingOverride) {
    const { data: tpl } = await admin
      .from('email_templates')
      .select('body, active')
      .eq('key', EZTRANS_PACKING_LIST_KEY)
      .maybeSingle();
    const row = tpl as { body: string; active: boolean } | null;
    if (row?.active && row.body) tplPackingList = row.body;
  }

  // An override arrives already rendered by the panel, but it is run through
  // the same substitution anyway: an operator who pastes a {{variable}} in
  // while editing gets it filled rather than mailed out raw.
  const text = renderEzTransTemplate(hasOverride ? body.body as string : tplBody, vars);

  // Same substitution as the email: an edited list still gets its serial,
  // carton and tracking from the rows above, not from what was typed.
  const packingListText = renderEzTransTemplate(
    hasPackingOverride ? body.packing_list as string : tplPackingList, vars);
  const pdfLines = packingListLines(packingListText);

  const packingListPdf = buildTextPdf(pdfLines);
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
  const labelPdf = new Uint8Array(await labelBlob.arrayBuffer());

  // One file, label first: EZ Trans prints the attachment and tapes it to the
  // carton, and two attachments is one chance to print only half of it. A
  // carrier label that pdf-lib cannot parse falls back to two attachments
  // rather than holding the shipment — the warning says which happened.
  let mergeWarning: string | null = null;
  let documents: Array<{ filename: string; bytes: Uint8Array }>;
  try {
    documents = [{
      filename: `shipping-label-and-packing-list-${safeRef}.pdf`,
      bytes: await mergePdfs([labelPdf, packingListPdf]),
    }];
  } catch (e) {
    mergeWarning =
      `The shipping label and the packing list went out as two attachments, not one: ` +
      `the label PDF could not be merged (${(e as Error).message}). Both documents are ` +
      `attached and correct — only the combining failed.`;
    documents = [
      { filename: `shipping-label-${safeRef}.pdf`, bytes: labelPdf },
      { filename: `packing-list-${safeRef}.pdf`, bytes: packingListPdf },
    ];
  }

  // UPS brokers its own US entries and will not act as importer of record
  // without a FIFRA worksheet, so one rides along on every UPS booking. The
  // date on it is today — the day the label was attached and this went out,
  // which is what the worksheets filed by hand carried.
  let worksheetWarning: string | null = null;
  const needsWorksheet = needsPesticideWorksheet(q.carrier);
  if (needsWorksheet) {
    // The signature is a real person's, so it is not in the repo — it is read
    // from a private bucket with the service role, the same way the label is.
    let signature = null;
    try {
      const { data: sigBlob, error: sigErr } = await admin.storage
        .from(SIGNATURE_BUCKET).download(SIGNATURE_PATH);
      if (sigErr || !sigBlob) throw new Error(sigErr?.message ?? 'not found');
      signature = pngToPdfImage(new Uint8Array(await sigBlob.arrayBuffer()));
    } catch (e) {
      // Said out loud rather than quietly sending an unsigned customs form,
      // which the broker would bounce a day later.
      worksheetWarning =
        `The pesticide worksheet went out UNSIGNED: ${SIGNATURE_BUCKET}/${SIGNATURE_PATH} ` +
        `could not be read (${(e as Error).message}). Upload the signature PNG to that path, ` +
        `then resend — or sign the attached worksheet by hand before it reaches the broker.`;
    }
    documents.push({
      filename: `pesticide-worksheet-${safeRef}.pdf`,
      bytes: buildTextPdf(pesticideWorksheetLines({
        trackingNumber: q.tracking_num,
        serial,
        batchLot: BATCH_LOT,
        quantity: QUANTITY,
        orderRef: order.order_ref,
        date: formatWorksheetDate(new Date()),
        signature,
      })),
    });
  }

  const attachments = documents.map(d => ({ filename: d.filename, base64: toBase64(d.bytes) }));

  // Same testing override as send-fulfillment-email: while
  // EMAIL_TEST_RECIPIENT is set nothing reaches the 3PL.
  const testRecipient = Deno.env.get('EMAIL_TEST_RECIPIENT');
  const to = testRecipient || EZTRANS_EMAIL;
  const baseSubject = renderEzTransTemplate(hasOverride ? body.subject as string : tplSubject, vars);
  const subject = testRecipient ? `[TEST → ${EZTRANS_EMAIL}] ${baseSubject}` : baseSubject;
  const emailText = testRecipient
    ? `*** TEST MODE — this email would have been sent to ${EZTRANS_EMAIL} ***\n` +
      `*** EMAIL_TEST_RECIPIENT is set on the edge function; unset to go live ***\n\n` +
      text
    : text;

  // Sender and CC are env-overridable so the address can move without a
  // deploy. The sending domain must be verified in Resend — an unverified one
  // is refused outright, which is called out below rather than left as a 502.
  const from = Deno.env.get('EZTRANS_FROM') || EZTRANS_FROM_DEFAULT;
  const cc = (Deno.env.get('EZTRANS_CC') ?? EZTRANS_CC_DEFAULT.join(','))
    .split(',').map(a => a.trim()).filter(Boolean);
  const replyTo = from.replace(/^.*<|>.*$/g, '');

  const send = (sender: string) => fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: sender,
      // Replies go to the intended sender even when the From had to fall back.
      reply_to: replyTo,
      to: [to],
      // Copied on every booking so there is a second pair of eyes on what the
      // 3PL was told. Suppressed in test mode along with the real recipient.
      ...(cc.length && !testRecipient ? { cc } : {}),
      subject,
      text: emailText,
      attachments: attachments.map(a => ({ filename: a.filename, content: a.base64 })),
    }),
  });

  let usedFrom = from;
  let warning: string | null = null;
  let sentVia: 'gmail' | 'resend' = 'resend';
  let emailId: string | null = null;

  // Gmail first, impersonating the From mailbox. Workspace already owns the
  // domain, so nothing has to be verified with a third party — and the sent
  // message is filed in that mailbox, which is the point of preferring it.
  const saKeyB64 = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY');
  const gmailSender = Deno.env.get('EZTRANS_GMAIL_SENDER') || replyTo;
  let gmailError: string | null = null;
  if (saKeyB64 && gmailSender) {
    try {
      const saKey = JSON.parse(atob(saKeyB64)) as ServiceAccountKey;
      const token = await getGmailAccessToken(saKey, gmailSender, GMAIL_SEND_SCOPE);
      const sent = await sendGmailMessage(token, {
        from,
        to: [to],
        cc: testRecipient ? [] : cc,
        subject,
        text: emailText,
        attachments: attachments.map(a => ({
          filename: a.filename, contentType: 'application/pdf', base64: a.base64,
        })),
      });
      emailId = sent.id;
      sentVia = 'gmail';
      usedFrom = from;
    } catch (e) {
      // Not fatal — fall through to Resend so a shipment is never held up by a
      // credential problem, but carry the reason so it can be reported.
      gmailError = (e as Error).message;
    }
  } else {
    gmailError = saKeyB64
      ? 'EZTRANS_GMAIL_SENDER is not set and the From address has no mailbox to send as'
      : 'GOOGLE_SERVICE_ACCOUNT_KEY is not set on this function';
  }

  // Whatever happened to the documents is reported either way — through
  // Gmail it is the only warning there is, through Resend it joins the one
  // about the sender.
  const documentWarning = [mergeWarning, worksheetWarning].filter(Boolean).join(' ') || null;

  if (emailId) {
    return json(200, {
      email_id: emailId,
      master_carton: masterCarton,
      to,
      cc: testRecipient ? [] : cc,
      from: usedFrom,
      sent_via: sentVia,
      ...(documentWarning ? { warning: documentWarning } : {}),
      attachments: attachments.map(a => a.filename),
      combined: !mergeWarning,
      pesticide_worksheet: needsWorksheet ? (worksheetWarning ? 'unsigned' : 'signed') : 'not-required',
      wording: hasOverride ? 'edited' : 'template',
      packing_list: hasPackingOverride ? 'edited' : 'template',
    });
  }

  warning =
    `Sent through Resend, not Gmail, so there is no copy in ${gmailSender || 'the sender'}'s ` +
    `Sent folder: ${gmailError}. Set GOOGLE_SERVICE_ACCOUNT_KEY on this function and grant the ` +
    `service account the ${GMAIL_SEND_SCOPE} scope for ${gmailSender || 'the sender'} in the ` +
    `Workspace admin console, and the booking will be sent from that mailbox instead.`;

  let resendRes = await send(from);

  // Resend refuses a From on a domain that is not verified for this account.
  // A shipment should not wait on a DNS change, so retry from the address that
  // has always been verified — and say so, rather than letting the operator
  // believe the mail went out as Reina.
  if (!resendRes.ok) {
    const firstError = await resendRes.text();
    const unverified = /not verified|domain_not_verified/i.test(firstError);
    if (unverified && from !== EZTRANS_FROM_FALLBACK) {
      const domain = from.replace(/^.*<|>.*$/g, '').split('@')[1] ?? from;
      resendRes = await send(EZTRANS_FROM_FALLBACK);
      if (resendRes.ok) {
        usedFrom = EZTRANS_FROM_FALLBACK;
        warning =
          `Sent from ${EZTRANS_FROM_FALLBACK} instead of ${from}: ${domain} is not a verified ` +
          `sending domain on this Resend account. Replies still go to ${replyTo}. ` +
          `${warning ?? ''}`;
      } else {
        const secondError = await resendRes.text();
        return json(502, {
          error: `Resend refused both senders. ${from}: ${firstError.slice(0, 200)} — ` +
            `${EZTRANS_FROM_FALLBACK}: ${secondError.slice(0, 200)}`,
        });
      }
    } else {
      return json(502, { error: `Resend ${resendRes.status}: ${firstError.slice(0, 400)}` });
    }
  }
  const sent = await resendRes.json() as { id: string };

  return json(200, {
    email_id: sent.id,
    master_carton: masterCarton,
    to,
    cc: testRecipient ? [] : cc,
    from: usedFrom,
    sent_via: sentVia,
    ...(warning || documentWarning
      ? { warning: [warning, documentWarning].filter(Boolean).join(' ') }
      : {}),
    attachments: attachments.map(a => a.filename),
    combined: !mergeWarning,
    pesticide_worksheet: needsWorksheet ? (worksheetWarning ? 'unsigned' : 'signed') : 'not-required',
    wording: hasOverride ? 'edited' : 'template',
    packing_list: hasPackingOverride ? 'edited' : 'template',
  });
}
