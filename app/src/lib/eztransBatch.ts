// The Goorooship day batch: confirm an order in step 3, send them all at once.
//
// EZ Trans asked for one email a day rather than one per box, so the per-order
// send (lib/eztrans.ts) is no longer the normal path. An operator now confirms
// carrier, tracking number, label and packing list on the queue row — that is
// all "adding it to today's batch" is — and the button at the bottom of the
// Fulfillment queue mails every order confirmed that day in a single message.
//
// A batch has no identity of its own. It is the local date of
// eztrans_confirmed_at, which means an order can be pulled back out of one by
// clearing that stamp and nothing has to be reconciled. eztrans_batch_sent_at
// is what stops a second press from double-booking the 3PL.
//
// The documents are built on the server, as they always were: the label and
// the packing list merged into one PDF per order, the FIFRA worksheet beside
// it on a UPS booking. Only their names changed — ten shipments in one email
// means every file has to say which carton it belongs to.

import { useEffect, useMemo, useState } from 'react';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';
import { needsPesticideWorksheet } from './eztrans';
import {
  batchAttachmentFilenames,
  batchAttachmentSlug,
  batchAttachmentsNote,
  batchOrdersBlock,
  dedupeFilenames,
  DEFAULT_EZTRANS_BATCH_BODY,
  DEFAULT_EZTRANS_BATCH_SUBJECT,
  EZTRANS_BATCH_CONFIRMED_ACTION,
  EZTRANS_BATCH_SENT_ACTION,
  EZTRANS_BATCH_TEMPLATE_KEY,
  type EzTransBatchLine,
} from '../../../supabase/functions/_shared/eztransBatch';

export {
  batchAttachmentFilenames,
  batchAttachmentSlug,
  batchAttachmentsNote,
  batchOrdersBlock,
  dedupeFilenames,
  DEFAULT_EZTRANS_BATCH_BODY,
  DEFAULT_EZTRANS_BATCH_SUBJECT,
  EZTRANS_BATCH_CONFIRMED_ACTION,
  EZTRANS_BATCH_SENT_ACTION,
  EZTRANS_BATCH_TEMPLATE_KEY,
};
export type { EzTransBatchLine };

/** The four columns 20260929120000_eztrans_daily_batch.sql adds. They are read
 *  off a `select('*')` row, so an environment that has not applied the
 *  migration yet simply has them undefined and shows an empty batch rather
 *  than throwing. */
export type EzTransBatchFields = {
  eztrans_confirmed_at?: string | null;
  eztrans_confirmed_by?: string | null;
  eztrans_packing_list?: string | null;
  eztrans_batch_sent_at?: string | null;
};

/** What buildDailyBatch actually reads off a queue row. Structural rather
 *  than the whole FulfillmentQueueRow so a test can state one in five lines. */
export type EzTransBatchQueueRow = EzTransBatchFields & {
  id: string;
  order_id: string;
  assigned_serial: string | null;
  carrier: string | null;
  tracking_num: string | null;
};

/** Enough of an order to name a box and address it. */
export type EzTransBatchOrder = {
  id: string;
  order_ref: string;
  customer_name: string;
};

/** One confirmed order as the footer panel lists it. */
export type EzTransBatchItem = {
  queueId: string;
  orderId: string;
  orderRef: string;
  customerName: string;
  serial: string | null;
  carrier: string;
  tracking: string;
  confirmedAt: string;
  sentAt: string | null;
  /** What this order contributes to the email, by filename. */
  documents: string[];
  /** True when this order's carrier means a FIFRA worksheet rides along. */
  worksheet: boolean;
  /** True when the packing list was edited for this order rather than taken
   *  from the saved template. */
  packingListEdited: boolean;
};

/** The local calendar day a timestamp falls on, as YYYY-MM-DD.
 *
 *  Local, not UTC: an operator in Toronto confirming an order at 20:30 on the
 *  29th is working the 29th's batch, and a UTC day would have filed it under
 *  the 30th and left it out of the email they were about to send. */
export function localDayKey(ts: string | Date): string {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Is this queue row confirmed and still owed to the 3PL? */
export function isAwaitingBatch(row: EzTransBatchQueueRow): boolean {
  return !!row.eztrans_confirmed_at && !row.eztrans_batch_sent_at;
}

/** Everything confirmed on one local day, split into what still has to go and
 *  what already went.
 *
 *  Pure so the footer can be tested without a database, and because the panel
 *  is fed the queue rows the page already holds rather than re-reading them.
 *  Filenames are deduped across the whole day, not per order: two attachments
 *  sharing a name in one email can silently become one in some mail clients,
 *  and the one that would be lost is a shipping label. */
export function buildDailyBatch(
  rows: EzTransBatchQueueRow[],
  orders: Map<string, EzTransBatchOrder>,
  day: string = localDayKey(new Date()),
): { pending: EzTransBatchItem[]; sent: EzTransBatchItem[] } {
  const today = day;
  const onToday = rows
    .filter(r => r.eztrans_confirmed_at && localDayKey(r.eztrans_confirmed_at) === today)
    .filter(r => !!r.carrier && !!r.tracking_num && !!orders.get(r.order_id))
    .sort((a, b) => (a.eztrans_confirmed_at ?? '').localeCompare(b.eztrans_confirmed_at ?? ''));

  // Named across the day so a resend of the afternoon's batch cannot reuse a
  // filename the morning's already spent.
  const names = dedupeFilenames(onToday.flatMap(r => {
    const order = orders.get(r.order_id)!;
    const f = batchAttachmentFilenames({
      customerName: order.customer_name,
      tracking: r.tracking_num!,
      needsWorksheet: needsPesticideWorksheet(r.carrier),
    });
    return f.worksheet ? [f.combined, f.worksheet] : [f.combined];
  }));

  let cursor = 0;
  const items: EzTransBatchItem[] = onToday.map(r => {
    const order = orders.get(r.order_id)!;
    const worksheet = needsPesticideWorksheet(r.carrier);
    const documents = names.slice(cursor, cursor + (worksheet ? 2 : 1));
    cursor += documents.length;
    return {
      queueId: r.id,
      orderId: r.order_id,
      orderRef: order.order_ref,
      customerName: order.customer_name,
      serial: r.assigned_serial,
      carrier: r.carrier!,
      tracking: r.tracking_num!,
      confirmedAt: r.eztrans_confirmed_at!,
      sentAt: r.eztrans_batch_sent_at ?? null,
      documents,
      worksheet,
      packingListEdited: !!r.eztrans_packing_list,
    };
  });

  return {
    pending: items.filter(i => !i.sentAt),
    sent: items.filter(i => !!i.sentAt),
  };
}

/** React wrapper over buildDailyBatch, recomputed at midnight-ish.
 *
 *  The clock is re-read every minute rather than once on mount: a warehouse
 *  leaves this tab open, and a batch that still says "today" at 00:05 would
 *  offer to mail yesterday's orders under tomorrow's date. */
export function useDailyBatch(
  rows: EzTransBatchQueueRow[],
  orders: Map<string, EzTransBatchOrder>,
): { pending: EzTransBatchItem[]; sent: EzTransBatchItem[]; day: string } {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  // Keyed on the calendar date, not the minute, so the footer re-renders when
  // the day turns over and not sixty times an hour in between.
  const day = localDayKey(now);
  return useMemo(() => ({ ...buildDailyBatch(rows, orders, day), day }), [rows, orders, day]);
}

/** The migration adds four columns; an environment that has not run it yet
 *  fails the write with PostgREST's schema-cache error rather than anything
 *  an operator could act on. Say which file to run instead. */
function isMissingBatchColumn(e: unknown): boolean {
  const msg = (e as { message?: string })?.message ?? String(e);
  return /eztrans_confirmed_at|eztrans_packing_list|eztrans_batch_sent_at|eztrans_confirmed_by/.test(msg);
}

function describeWriteError(e: unknown): Error {
  const msg = (e as { message?: string })?.message ?? String(e);
  if (isMissingBatchColumn(e)) {
    return new Error(
      'The Goorooship day-batch columns are not in this database yet — run the ' +
      'migration 20260929120000_eztrans_daily_batch.sql, then confirm again. ' +
      `(${msg})`,
    );
  }
  return e instanceof Error ? e : new Error(msg);
}

/** Add an order to today's Goorooship batch.
 *
 *  Confirming is the whole of "it is scheduled for today": carrier, tracking
 *  number and the label go onto the queue row exactly where the per-order send
 *  put them, the packing list joins them so the end-of-day send can build the
 *  PDF from a row rather than from the browser that typed it, and the stamp
 *  says which day's email it belongs in.
 *
 *  `packing_list` is the operator's edit or null. Null is not "no packing
 *  list" — it means the saved template, resolved at send time, which is the
 *  same precedence the per-order path has always used. Passing a copy of the
 *  rendered template instead would freeze today's wording into the row and
 *  quietly beat a later edit in the Templates tab.
 *
 *  Deliberately does not advance the step. The operator is still standing in
 *  step 3 with the panel open, and moving the row would unmount it. */
export async function confirmEzTransOrder(
  queueId: string,
  input: {
    carrier: string;
    tracking_num: string;
    label_pdf?: File;
    packing_list?: string | null;
  },
): Promise<{ confirmed_at: string; label_pdf_path: string | null }> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('eztrans batch: not authenticated');

  let label_pdf_path: string | null = null;
  if (input.label_pdf) {
    // Same bucket and path convention as confirmLabel and saveEzTransLabel —
    // a label is a label wherever it was attached from.
    const path = `${queueId}/label-${Date.now()}.pdf`;
    const { error: upErr } = await supabase.storage
      .from('order-labels')
      .upload(path, input.label_pdf, { contentType: 'application/pdf' });
    if (upErr) throw upErr;
    label_pdf_path = path;
  }

  const confirmed_at = new Date().toISOString();
  const { error } = await supabase
    .from('fulfillment_queue')
    .update({
      carrier: input.carrier,
      tracking_num: input.tracking_num.trim(),
      ...(label_pdf_path ? { label_pdf_path } : {}),
      eztrans_packing_list: input.packing_list ?? null,
      eztrans_confirmed_at: confirmed_at,
      eztrans_confirmed_by: auth.user.id,
      // Re-confirming a row that was already mailed starts it over rather than
      // leaving it marked sent and invisible. Clearing here is what makes
      // "correct the tracking number and send it again" work at all.
      eztrans_batch_sent_at: null,
    })
    .eq('id', queueId);
  if (error) throw describeWriteError(error);
  return { confirmed_at, label_pdf_path };
}

/** Take an order back out of today's batch.
 *
 *  Clears the stamp only. Carrier, tracking and the label stay on the row —
 *  the operator is pulling the shipment from today's email, not undoing the
 *  booking. */
export async function unconfirmEzTransOrder(queueId: string): Promise<void> {
  const { error } = await supabase
    .from('fulfillment_queue')
    .update({ eztrans_confirmed_at: null, eztrans_confirmed_by: null })
    .eq('id', queueId);
  if (error) throw describeWriteError(error);
}

/** Mark a confirmed order as already mailed, without a batch.
 *
 *  The per-order send (lib/eztrans.ts) still exists for a rush shipment that
 *  cannot wait for the end of the day. An order mailed that way must not also
 *  ride along in the evening's batch, so the same stamp the batch send writes
 *  is written here — which is all "it is no longer owed to the 3PL" means.
 *  A row that was never confirmed is not in any batch to begin with, so this
 *  is a no-op for it and the caller need not check. Nor is there a batch at
 *  all in a database that has not run the migration yet, so a missing column
 *  is silence rather than a warning hung off every rush send. */
export async function markEzTransSentOutsideBatch(queueId: string): Promise<void> {
  const { error } = await supabase
    .from('fulfillment_queue')
    .update({ eztrans_batch_sent_at: new Date().toISOString() })
    .eq('id', queueId)
    .not('eztrans_confirmed_at', 'is', null);
  if (error && !isMissingBatchColumn(error)) throw describeWriteError(error);
}

/** One order as the server reported it after a batch send. */
export type EzTransBatchSentOrder = {
  queue_id: string;
  order_id: string;
  order_ref: string;
  customer_name: string;
  serial: string | null;
  tracking: string;
  documents: string[];
};

/** An order the server refused to include, and why. Reported rather than
 *  dropped — an operator who pressed a button expecting nine shipments has to
 *  be told which one did not go. */
export type EzTransBatchSkipped = {
  queue_id: string;
  order_ref?: string;
  reason: string;
};

export type EzTransBatchSendResult = {
  email_id: string;
  to: string;
  cc: string[];
  from?: string;
  sent_via?: 'gmail' | 'resend';
  warning?: string;
  wording?: 'edited' | 'template' | 'built-in';
  orders: EzTransBatchSentOrder[];
  skipped: EzTransBatchSkipped[];
  attachments: string[];
  /** Worksheets that were built but could not be signed. */
  unsigned_worksheets: string[];
};

/** Send today's batch.
 *
 *  The queue ids come from the panel rather than being recomputed server-side
 *  from a date, so what the operator saw listed is exactly what is sent — a
 *  timezone disagreement between the browser and the edge function must not be
 *  able to slip an eleventh shipment into an email that promised ten. Every id
 *  is still re-validated against the row before its documents are built. */
export async function sendEzTransDailyBatch(
  queueIds: string[],
  override?: { subject?: string; body?: string },
): Promise<EzTransBatchSendResult> {
  if (queueIds.length === 0) throw new Error('nothing is confirmed for today yet');
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-eztrans-daily-batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
    },
    // Presence, not truthiness — same contract as the per-order send: the edge
    // function reads a missing subject/body as "use the saved template", so an
    // edit the operator cleared has to reach it as the empty string it is.
    body: JSON.stringify({
      queue_ids: queueIds,
      ...(override?.subject !== undefined ? { subject: override.subject } : {}),
      ...(override?.body !== undefined ? { body: override.body } : {}),
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) detail = parsed.error;
    } catch { /* keep raw */ }
    throw new Error(`Goorooship batch email failed (${res.status}): ${detail}`);
  }
  try { return JSON.parse(text) as EzTransBatchSendResult; }
  catch { throw new Error('Goorooship batch email: response was not JSON'); }
}

/** The numbered shipment list as the email will carry it, for the preview in
 *  the footer. Built from the same helper the edge function uses, so the panel
 *  cannot promise a different list than the one that goes out — the server
 *  fills in the address and the master carton, which this does not have. */
export function previewOrdersBlock(items: EzTransBatchItem[]): string {
  return batchOrdersBlock(items.map((i): EzTransBatchLine => ({
    orderRef: i.orderRef,
    customerName: i.customerName,
    address: '(filled from the order on send)',
    serial: i.serial ?? '—',
    masterCarton: '(filled from the shelf on send)',
    carrier: i.carrier,
    tracking: i.tracking,
    documents: i.documents,
  })));
}

