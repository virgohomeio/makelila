// One email to the EZ Trans 3PL carrying every order confirmed for Goorooship
// today.
//
// send-eztrans-booking mails one order at a time, as each box is booked. EZ
// Trans asked for the opposite: a picker working a stack of ten cartons out of
// ten separate emails loses one. So step 3 of the fulfillment queue confirms
// an order into the day's batch (carrier, tracking number, label and packing
// list pinned to the queue row) and the button at the bottom of the queue
// sends the lot.
//
// Per order the documents are what they always were — the shipping label and
// the packing list merged into one PDF, plus the FIFRA worksheet as its own
// file on a UPS booking, because UPS Supply Chain Solutions will not broker a
// US entry for a pesticide device without one. What changed is their names:
// with ten shipments in one message, "packing-list-1184.pdf" does not tell a
// picker which carton a worksheet belongs to, so every file is named for the
// customer and the tracking number.
//
// Sent through Gmail as the From mailbox so the batch lands in that person's
// Sent folder and the 3PL's reply threads into their inbox; Resend is the
// fallback and says so, since mail it sends leaves no trace on the sender's
// side.
//
// The caller passes the queue ids it listed rather than a date, so the email
// carries exactly the shipments the operator saw on screen — a timezone
// disagreement between the browser and this function must not be able to slip
// an eleventh order into an email that promised ten. Every id is still
// re-validated here, and an order that cannot go is reported as skipped
// rather than dropped.
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
  DEFAULT_EZTRANS_PACKING_LIST,
  EZTRANS_CC_DEFAULT,
  EZTRANS_FROM_DEFAULT,
  EZTRANS_FROM_FALLBACK,
  EZTRANS_PACKING_LIST_KEY,
  needsPesticideWorksheet,
  packingListLines,
  renderEzTransTemplate,
  unitVariables,
  type EzTransUnit,
} from '../_shared/eztransTemplate.ts';
import {
  batchAttachmentFilenames,
  batchAttachmentsNote,
  batchOrdersBlock,
  dedupeFilenames,
  DEFAULT_EZTRANS_BATCH_BODY,
  DEFAULT_EZTRANS_BATCH_SUBJECT,
  EZTRANS_BATCH_TEMPLATE_KEY,
  type EzTransBatchLine,
} from '../_shared/eztransBatch.ts';

const EZTRANS_LOCATION = 'EZTrans';
const EZTRANS_EMAIL = 'cs@goorooship.ca';
const PRODUCT_NAME = 'LILA Kitchen Composter';
const SKU = 'LILA-P100X';
const BATCH_LOT = 'P100X';

/** How many orders one email may carry.
 *
 *  Not a business rule — a mail-size one. Every order adds a label plus a
 *  generated page, and a message that exceeds the provider's limit fails as a
 *  whole, taking the nine shipments that would have been fine with it. Above
 *  this the operator is told to send in two passes, which the confirm stamps
 *  already support. */
const MAX_ORDERS_PER_BATCH = 40;

/** Raw attachment bytes allowed in one message. Gmail's ceiling is 25 MB on
 *  the encoded message and base64 costs a third, so stop well short. */
const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;

type QueueRow = {
  id: string;
  order_id: string;
  step: number;
  assigned_serial: string | null;
  carrier: string | null;
  tracking_num: string | null;
  label_pdf_path: string | null;
  eztrans_confirmed_at: string | null;
  eztrans_packing_list: string | null;
  eztrans_batch_sent_at: string | null;
};

type OrderRow = {
  id: string;
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

/** EZ-P01 -> "1". Mirrors masterCartonFromSkid in lib/eztrans.ts and in
 *  send-eztrans-booking: a group that isn't a numbered pallet passes through
 *  as-is rather than being given an invented carton number. */
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

  const body = await req.json() as { queue_ids?: unknown; subject?: string; body?: string };
  const queueIds = Array.isArray(body.queue_ids)
    ? [...new Set(body.queue_ids.filter((v): v is string => typeof v === 'string' && !!v.trim()))]
    : [];
  if (queueIds.length === 0) return json(400, { error: 'queue_ids required' });
  if (queueIds.length > MAX_ORDERS_PER_BATCH) {
    return json(400, {
      error: `${queueIds.length} orders is more than one email can carry — ` +
        `send at most ${MAX_ORDERS_PER_BATCH} at a time.`,
    });
  }

  // Same contract as the per-order send: both halves of the wording travel
  // together, or the caller is confused and half of what goes out is the
  // template's and half is theirs.
  const hasOverride = body.subject !== undefined || body.body !== undefined;
  if (hasOverride) {
    if (typeof body.subject !== 'string' || typeof body.body !== 'string') {
      return json(400, { error: 'subject and body must be sent together' });
    }
    if (!body.subject.trim() || !body.body.trim()) {
      return json(400, { error: 'an edited subject and body cannot be empty' });
    }
    if (body.subject.length > 300) return json(400, { error: 'subject is too long (max 300 characters)' });
    if (body.body.length > 40000) return json(400, { error: 'body is too long (max 40000 characters)' });
  }

  const { data: qRows, error: qErr } = await admin
    .from('fulfillment_queue')
    .select('id, order_id, step, assigned_serial, carrier, tracking_num, label_pdf_path, ' +
            'eztrans_confirmed_at, eztrans_packing_list, eztrans_batch_sent_at')
    .in('id', queueIds);
  if (qErr) {
    // The four eztrans_* columns arrive with 20260929120000_eztrans_daily_batch.sql,
    // and migrations in this repo are applied by hand. Say which file to run
    // rather than returning PostgREST's schema-cache message on its own.
    if (/eztrans_(confirmed_at|packing_list|batch_sent_at|confirmed_by)/.test(qErr.message)) {
      return json(409, {
        error: 'The Goorooship day-batch columns are not in this database yet — run the ' +
          `migration 20260929120000_eztrans_daily_batch.sql. (${qErr.message})`,
      });
    }
    return json(500, { error: `could not read the queue rows: ${qErr.message}` });
  }
  const rows = (qRows as QueueRow[] | null) ?? [];

  const orderIds = [...new Set(rows.map(r => r.order_id))];
  const { data: oRows, error: oErr } = await admin
    .from('orders')
    .select('id, order_ref, customer_name, customer_email, customer_phone, address_line, address_line2, city, region_state, postal_code, country')
    .in('id', orderIds);
  if (oErr) return json(500, { error: `could not read the orders: ${oErr.message}` });
  const orders = new Map(((oRows as OrderRow[] | null) ?? []).map(o => [o.id, o]));

  // Location and carton come from the DB, never from the caller: the packing
  // list is what the 3PL picks from, and a stale browser must not be able to
  // put a different pallet on it.
  // Every machine on every row in the batch, not one per order. An order for
  // three LILA Pros has to reach EZ Trans naming all three.
  const { data: quRows } = await admin
    .from('fulfillment_queue_units')
    .select('queue_id, unit_serial, assigned_at')
    .in('queue_id', rows.map(r => r.id))
    .order('assigned_at', { ascending: true });
  const assignedByQueue = new Map<string, string[]>();
  for (const u of ((quRows as Array<{ queue_id: string; unit_serial: string }> | null) ?? [])) {
    const list = assignedByQueue.get(u.queue_id) ?? [];
    list.push(u.unit_serial);
    assignedByQueue.set(u.queue_id, list);
  }
  // assigned_serial is unioned in, so a database that has not run
  // 20261001130000_fulfillment_queue_units.sql still sends its one unit.
  for (const r of rows) {
    if (!r.assigned_serial) continue;
    const list = assignedByQueue.get(r.id) ?? [];
    if (!list.includes(r.assigned_serial)) list.unshift(r.assigned_serial);
    assignedByQueue.set(r.id, list);
  }

  const serials = [...new Set([...assignedByQueue.values()].flat())];
  const [slotRes, unitRes] = await Promise.all([
    serials.length
      ? admin.from('shelf_slots').select('serial, skid, location').in('serial', serials)
      : Promise.resolve({ data: [] as Array<{ serial: string; skid: string; location: string }> }),
    serials.length
      ? admin.from('units').select('serial, location, pallet').in('serial', serials)
      : Promise.resolve({ data: [] as Array<{ serial: string; location: string | null; pallet: string | null }> }),
  ]);
  const slots = (slotRes.data as Array<{ serial: string; skid: string; location: string }> | null) ?? [];
  const units = new Map(
    (((unitRes.data as Array<{ serial: string; location: string | null; pallet: string | null }> | null) ?? []))
      .map(u => [u.serial, u]),
  );
  // A serial can linger on an old slot after a move, so prefer the row that
  // actually says EZTrans over whichever came back first.
  const ezSlot = new Map<string, string>();
  for (const s of slots) if (s.location === EZTRANS_LOCATION && !ezSlot.has(s.serial)) ezSlot.set(s.serial, s.skid);

  // One template read for the whole batch; the per-order override on the queue
  // row still wins over it, row by row.
  let tplPackingList = DEFAULT_EZTRANS_PACKING_LIST;
  {
    const { data: tpl } = await admin
      .from('email_templates')
      .select('body, active')
      .eq('key', EZTRANS_PACKING_LIST_KEY)
      .maybeSingle();
    const row = tpl as { body: string; active: boolean } | null;
    if (row?.active && row.body) tplPackingList = row.body;
  }

  // The signature is a real person's, so it is not in the repo. Read once for
  // the batch rather than once per UPS shipment.
  let signature: ReturnType<typeof pngToPdfImage> | null = null;
  let signatureError: string | null = null;
  try {
    const { data: sigBlob, error: sigErr } = await admin.storage
      .from(SIGNATURE_BUCKET).download(SIGNATURE_PATH);
    if (sigErr || !sigBlob) throw new Error(sigErr?.message ?? 'not found');
    signature = pngToPdfImage(new Uint8Array(await sigBlob.arrayBuffer()));
  } catch (e) {
    signatureError = (e as Error).message;
  }

  const worksheetDate = formatWorksheetDate(new Date());
  const today = new Date().toISOString().slice(0, 10);

  type Built = {
    row: QueueRow;
    order: OrderRow;
    line: Omit<EzTransBatchLine, 'documents'>;
    worksheet: boolean;
    combinedBytes: Uint8Array;
    worksheetBytes: Uint8Array | null;
    /** Set when the label could not be merged with the packing list and the
     *  two had to travel as separate files. */
    splitPackingList: Uint8Array | null;
  };

  const built: Built[] = [];
  const skipped: Array<{ queue_id: string; order_ref?: string; reason: string }> = [];
  const warnings: string[] = [];
  const unsignedWorksheets: string[] = [];

  // Preserve the caller's order so the numbered list in the email matches the
  // list the operator was looking at when they pressed the button.
  const byId = new Map(rows.map(r => [r.id, r]));
  for (const id of queueIds) {
    const row = byId.get(id);
    if (!row) { skipped.push({ queue_id: id, reason: 'queue row not found' }); continue; }
    const order = orders.get(row.order_id);
    const ref = order?.order_ref;
    if (!order) { skipped.push({ queue_id: id, reason: 'order not found' }); continue; }
    if (row.eztrans_batch_sent_at) {
      skipped.push({ queue_id: id, order_ref: ref, reason: 'already sent in an earlier batch' });
      continue;
    }
    if (!row.eztrans_confirmed_at) {
      skipped.push({ queue_id: id, order_ref: ref, reason: 'not confirmed for a Goorooship batch' });
      continue;
    }
    if (!row.assigned_serial) {
      skipped.push({ queue_id: id, order_ref: ref, reason: 'no unit assigned — finish step 1 first' });
      continue;
    }
    if (row.step < 3) {
      skipped.push({ queue_id: id, order_ref: ref, reason: `at step ${row.step}, must be at or past step 3` });
      continue;
    }
    if (!row.carrier || !row.tracking_num) {
      skipped.push({ queue_id: id, order_ref: ref, reason: 'carrier and tracking number are required' });
      continue;
    }
    if (!row.label_pdf_path) {
      skipped.push({ queue_id: id, order_ref: ref, reason: 'no shipping label attached' });
      continue;
    }
    // Filtered rather than asserted: there is no local type-checker for these
    // functions, so the null is removed in a way that cannot be wrong.
    const assigned = (assignedByQueue.get(id) ?? [row.assigned_serial])
      .filter((s): s is string => !!s);
    const rowUnits: EzTransUnit[] = [];
    const offsite: string[] = [];
    for (const serialNo of assigned) {
      const skid = ezSlot.get(serialNo) ?? null;
      const unit = units.get(serialNo) ?? null;
      if (!skid && unit?.location !== EZTRANS_LOCATION) { offsite.push(serialNo); continue; }
      rowUnits.push({ serial: serialNo, masterCarton: masterCartonFromSkid(skid ?? unit?.pallet ?? null) });
    }
    if (rowUnits.length === 0) {
      skipped.push({
        queue_id: id, order_ref: ref,
        reason: `${assigned.length === 1 ? 'unit' : 'units'} ${assigned.join(', ')} ` +
          `${assigned.length === 1 ? 'is' : 'are'} not held at ${EZTRANS_LOCATION} — ` +
          'book this shipment through Freightcom instead',
      });
      continue;
    }
    // Skipped rather than sent short: the 3PL can only pick what they hold, so
    // a batch line naming two of three machines ships an incomplete order.
    if (offsite.length > 0) {
      skipped.push({
        queue_id: id, order_ref: ref,
        reason: `${offsite.length} of this order's ${assigned.length} units are not held at ` +
          `${EZTRANS_LOCATION} (${offsite.join(', ')}) — move them there, or ship them separately`,
      });
      continue;
    }
    const unitVars = unitVariables(rowUnits);

    const { data: labelBlob, error: labelErr } = await admin.storage
      .from('order-labels').download(row.label_pdf_path);
    if (labelErr || !labelBlob) {
      skipped.push({
        queue_id: id, order_ref: ref,
        reason: `could not read the shipping label (${row.label_pdf_path}): ${labelErr?.message ?? 'not found'}`,
      });
      continue;
    }
    const labelPdf = new Uint8Array(await labelBlob.arrayBuffer());

    const masterCarton = unitVars.master_carton;
    const addr = addressLines(order);
    const vars: Record<string, string> = {
      customer_name: order.customer_name,
      customer_address: addr.join('\n         '),
      customer_email: order.customer_email ?? '—',
      customer_phone: order.customer_phone ?? '—',
      product_name: PRODUCT_NAME,
      sku: SKU,
      batch_lot: BATCH_LOT,
      // serial / master_carton / quantity / units_block over every machine on
      // this order — the same helper the panel previews with.
      ...unitVars,
      carrier: row.carrier,
      tracking: row.tracking_num,
      order_ref: order.order_ref,
      customer_address_block: addr.join('\n'),
      date: today,
    };

    // The operator's edit for this order if there is one, else the saved
    // template, else the built-in default — and either way every {{variable}}
    // is filled from the rows above, so an edit changes what the document says
    // and never which shipment it describes.
    const packingListText = renderEzTransTemplate(
      row.eztrans_packing_list || tplPackingList, vars);
    const packingListPdf = buildTextPdf(packingListLines(packingListText));

    // One file, label first: the 3PL prints the attachment and tapes page one
    // to the carton. A label pdf-lib cannot parse falls back to two files
    // rather than holding the shipment out of the batch.
    let combinedBytes: Uint8Array;
    let splitPackingList: Uint8Array | null = null;
    try {
      combinedBytes = await mergePdfs([labelPdf, packingListPdf]);
    } catch (e) {
      combinedBytes = labelPdf;
      splitPackingList = packingListPdf;
      warnings.push(
        `${order.order_ref} (${order.customer_name}): the shipping label and the packing list ` +
        `went as two files, not one — the label PDF could not be merged (${(e as Error).message}). ` +
        `Both are attached and correct.`);
    }

    const worksheet = needsPesticideWorksheet(row.carrier);
    let worksheetBytes: Uint8Array | null = null;
    if (worksheet) {
      worksheetBytes = buildTextPdf(pesticideWorksheetLines({
        trackingNumber: row.tracking_num,
        // One entry covers the whole shipment, so every machine is declared.
        serial: unitVars.serial,
        batchLot: BATCH_LOT,
        quantity: rowUnits.length,
        orderRef: order.order_ref,
        date: worksheetDate,
        signature,
      }));
      if (!signature) unsignedWorksheets.push(`${order.customer_name} · ${row.tracking_num}`);
    }

    built.push({
      row, order, worksheet, combinedBytes, worksheetBytes, splitPackingList,
      line: {
        orderRef: order.order_ref,
        customerName: order.customer_name,
        address: addr.join(', '),
        serial: unitVars.serial,
        masterCarton,
        carrier: row.carrier,
        tracking: row.tracking_num,
      },
    });
  }

  if (built.length === 0) {
    return json(409, {
      error: 'none of these orders could be sent to EZ Trans',
      skipped,
    });
  }

  if (unsignedWorksheets.length) {
    // Said out loud rather than quietly sending unsigned customs forms, which
    // the broker would bounce a day later.
    warnings.push(
      `${unsignedWorksheets.length} pesticide worksheet(s) went out UNSIGNED — ` +
      `${SIGNATURE_BUCKET}/${SIGNATURE_PATH} could not be read (${signatureError ?? 'not found'}). ` +
      `Affected: ${unsignedWorksheets.join('; ')}. Upload the signature PNG to that path and ` +
      `resend, or sign them by hand before they reach the broker.`);
  }

  // Named for the customer and the tracking number, and deduped across the
  // whole email: two attachments sharing a name can silently become one in
  // some mail clients, and the one lost would be a shipping label.
  const rawNames: string[] = [];
  for (const b of built) {
    const f = batchAttachmentFilenames({
      customerName: b.order.customer_name,
      tracking: b.row.tracking_num as string,
      needsWorksheet: b.worksheet,
    });
    rawNames.push(b.splitPackingList
      ? f.combined.replace('label-and-packing-list-', 'shipping-label-')
      : f.combined);
    if (b.splitPackingList) rawNames.push(f.combined.replace('label-and-packing-list-', 'packing-list-'));
    if (f.worksheet) rawNames.push(f.worksheet);
  }
  const names = dedupeFilenames(rawNames);

  const documents: Array<{ filename: string; bytes: Uint8Array }> = [];
  const lines: EzTransBatchLine[] = [];
  let cursor = 0;
  for (const b of built) {
    const mine: string[] = [];
    documents.push({ filename: names[cursor], bytes: b.combinedBytes });
    mine.push(names[cursor]); cursor++;
    if (b.splitPackingList) {
      documents.push({ filename: names[cursor], bytes: b.splitPackingList });
      mine.push(names[cursor]); cursor++;
    }
    if (b.worksheetBytes) {
      documents.push({ filename: names[cursor], bytes: b.worksheetBytes });
      mine.push(names[cursor]); cursor++;
    }
    lines.push({ ...b.line, documents: mine });
  }

  const totalBytes = documents.reduce((n, d) => n + d.bytes.length, 0);
  if (totalBytes > MAX_ATTACHMENT_BYTES) {
    return json(413, {
      error: `${built.length} orders come to ${(totalBytes / 1048576).toFixed(1)} MB of attachments, ` +
        `over the ${(MAX_ATTACHMENT_BYTES / 1048576).toFixed(0)} MB one email can carry. ` +
        `Send them in two batches — un-confirm some of the orders, send, then confirm them again.`,
      skipped,
    });
  }

  const worksheetCount = built.filter(b => b.worksheet).length;
  const vars: Record<string, string> = {
    date: today,
    order_count: String(built.length),
    orders_block: batchOrdersBlock(lines),
    attachments_note: batchAttachmentsNote(built.length, worksheetCount),
  };

  let tplSubject = DEFAULT_EZTRANS_BATCH_SUBJECT;
  let tplBody = DEFAULT_EZTRANS_BATCH_BODY;
  let wording: 'edited' | 'template' | 'built-in' = 'built-in';
  if (hasOverride) {
    wording = 'edited';
  } else {
    const { data: tpl } = await admin
      .from('email_templates')
      .select('subject, body, active')
      .eq('key', EZTRANS_BATCH_TEMPLATE_KEY)
      .maybeSingle();
    const row = tpl as { subject: string; body: string; active: boolean } | null;
    if (row?.active && row.subject && row.body) {
      tplSubject = row.subject;
      tplBody = row.body;
      wording = 'template';
    }
  }

  // An override arrives already rendered by the panel, but it is run through
  // the same substitution anyway: an operator who leaves {{orders_block}} in
  // while editing gets the real list rather than mailing the placeholder.
  const text = renderEzTransTemplate(hasOverride ? body.body as string : tplBody, vars);
  const baseSubject = renderEzTransTemplate(hasOverride ? body.subject as string : tplSubject, vars);

  // Same testing override as the per-order send: while EMAIL_TEST_RECIPIENT is
  // set nothing reaches the 3PL.
  const testRecipient = Deno.env.get('EMAIL_TEST_RECIPIENT');
  const to = testRecipient || EZTRANS_EMAIL;
  const subject = testRecipient ? `[TEST → ${EZTRANS_EMAIL}] ${baseSubject}` : baseSubject;
  const emailText = testRecipient
    ? `*** TEST MODE — this email would have been sent to ${EZTRANS_EMAIL} ***\n` +
      `*** EMAIL_TEST_RECIPIENT is set on the edge function; unset to go live ***\n\n` +
      text
    : text;

  const from = Deno.env.get('EZTRANS_FROM') || EZTRANS_FROM_DEFAULT;
  const cc = (Deno.env.get('EZTRANS_CC') ?? EZTRANS_CC_DEFAULT.join(','))
    .split(',').map(a => a.trim()).filter(Boolean);
  const replyTo = from.replace(/^.*<|>.*$/g, '');
  const attachments = documents.map(d => ({ filename: d.filename, base64: toBase64(d.bytes) }));

  let usedFrom = from;
  let sentVia: 'gmail' | 'resend' = 'resend';
  let emailId: string | null = null;
  let senderWarning: string | null = null;

  // Gmail first, impersonating the From mailbox, so the batch is filed in that
  // person's Sent folder and the 3PL's reply threads into their inbox. Resend
  // cannot do that at any setting.
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
    } catch (e) {
      // Not fatal — fall through to Resend so a day's shipments are never held
      // up by a credential problem, but carry the reason.
      gmailError = (e as Error).message;
    }
  } else {
    gmailError = saKeyB64
      ? 'EZTRANS_GMAIL_SENDER is not set and the From address has no mailbox to send as'
      : 'GOOGLE_SERVICE_ACCOUNT_KEY is not set on this function';
  }

  if (!emailId) {
    senderWarning =
      `Sent through Resend, not Gmail, so there is no copy in ${gmailSender || 'the sender'}'s ` +
      `Sent folder: ${gmailError}. Set GOOGLE_SERVICE_ACCOUNT_KEY on this function and grant the ` +
      `service account the ${GMAIL_SEND_SCOPE} scope for ${gmailSender || 'the sender'} in the ` +
      `Workspace admin console, and the batch will be sent from that mailbox instead.`;

    const send = (sender: string) => fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: sender,
        reply_to: replyTo,
        to: [to],
        ...(cc.length && !testRecipient ? { cc } : {}),
        subject,
        text: emailText,
        attachments: attachments.map(a => ({ filename: a.filename, content: a.base64 })),
      }),
    });

    let resendRes = await send(from);
    // Resend refuses a From on a domain that is not verified for this account.
    // A day of shipments should not wait on a DNS change, so retry from the
    // address that has always been verified — and say that it happened.
    if (!resendRes.ok) {
      const firstError = await resendRes.text();
      const unverified = /not verified|domain_not_verified/i.test(firstError);
      if (unverified && from !== EZTRANS_FROM_FALLBACK) {
        const domain = from.replace(/^.*<|>.*$/g, '').split('@')[1] ?? from;
        resendRes = await send(EZTRANS_FROM_FALLBACK);
        if (resendRes.ok) {
          usedFrom = EZTRANS_FROM_FALLBACK;
          senderWarning =
            `Sent from ${EZTRANS_FROM_FALLBACK} instead of ${from}: ${domain} is not a verified ` +
            `sending domain on this Resend account. Replies still go to ${replyTo}. ${senderWarning}`;
        } else {
          const secondError = await resendRes.text();
          return json(502, {
            error: `Resend refused both senders. ${from}: ${firstError.slice(0, 200)} — ` +
              `${EZTRANS_FROM_FALLBACK}: ${secondError.slice(0, 200)}`,
            skipped,
          });
        }
      } else {
        return json(502, { error: `Resend ${resendRes.status}: ${firstError.slice(0, 400)}`, skipped });
      }
    }
    const sent = await resendRes.json() as { id: string };
    emailId = sent.id;
  }

  // Stamped only once the mail is away, so a send that failed leaves the day's
  // batch intact and the button can simply be pressed again. A stamp that
  // fails to write is reported rather than swallowed: the alternative is a
  // second press mailing the 3PL the same ten cartons.
  const sentAt = new Date().toISOString();
  const { error: stampErr } = await admin
    .from('fulfillment_queue')
    .update({ eztrans_batch_sent_at: sentAt })
    .in('id', built.map(b => b.row.id));
  if (stampErr) {
    warnings.push(
      `The email went out, but the queue rows could not be marked as sent (${stampErr.message}). ` +
      `They will still be listed as waiting — do not press the button again without checking ` +
      `the sent mail first.`);
  }

  const warning = [senderWarning, ...warnings].filter(Boolean).join(' ') || null;

  return json(200, {
    email_id: emailId,
    to,
    cc: testRecipient ? [] : cc,
    from: usedFrom,
    sent_via: sentVia,
    sent_at: sentAt,
    ...(warning ? { warning } : {}),
    wording,
    orders: built.map((b, i) => ({
      queue_id: b.row.id,
      order_id: b.order.id,
      order_ref: b.order.order_ref,
      customer_name: b.order.customer_name,
      serial: b.row.assigned_serial,
      tracking: b.row.tracking_num,
      documents: lines[i].documents,
    })),
    skipped,
    attachments: documents.map(d => d.filename),
    unsigned_worksheets: unsignedWorksheets,
  });
}
