// "To be picked up" — the third column of the Fulfillment queue.
//
// Ready to ship used to run all the way from "nobody has touched this" to "the
// carton is on the dock with a label on it and the 3PL has been told". Those
// are two different jobs. Everything up to step 3 is work the warehouse still
// owes: pick a machine, test it, book a label. Step 4 is work somebody else
// owes us — the carrier has to turn up. Mixed into one rail, a picker reading
// it to decide what to pack next has to open each row to find out which kind
// it is, and nine of twenty-two rows on 2026-09-30 were the second kind.
//
// A row belongs in "To be picked up" when all three are true:
//
//   1. it is at the dock handoff or past it — step 4 or step 5;
//   2. its label is confirmed — carrier and tracking number are on the row;
//   3. if it ships out of EZ Trans, the Goorooship email carrying it has
//      actually gone out.
//
// (3) gained its condition on 2026-10-05. It was written when the rail held
// only EZ Trans cartons, and read flatly it kept every Freightcom box — stock
// picked off our own floor, which no 3PL is ever emailed about — in Ready to
// ship for ever after its label was confirmed. Step 3 now refuses to confirm
// an EZ Trans label until that email has gone, so for the rows the condition
// applies to it is true by the time the row arrives.
//
// (1) was step 4 exactly until 2026-10-01, on the reasoning that step 5 is the
// customer's shipping email and by then the carrier has been and gone. That
// put #1194 and #1266 back under Ready to ship after the dock was confirmed —
// both boxes gone, both rows sitting in the picker's work list with nothing to
// pack. Whatever step 5 is, it is not warehouse work, and Ready to ship is
// read to decide what to pack next. So the rail runs from the handoff to
// fulfilment: once the carton is labelled and the 3PL has it, the row is out
// of the packer's hands whether or not the customer has been emailed yet.
//
// The third is the one that needs care, because the app has mailed the 3PL two
// different ways and only one of them leaves a mark on the queue row:
//
//   the day batch    stamps eztrans_batch_sent_at (20260929120000). Read
//                    straight off the row.
//   the per-order    (lib/eztrans.ts, the normal path until 2026-09-29)
//   booking send     writes an fq_eztrans_booking_sent line to the activity
//                    log and stamps the row only when it was also confirmed
//                    into a batch — which pre-batch sends never were. Five of
//                    the nine rows at step 4 are in exactly that state, so
//                    reading the column alone would have left them behind.
//
// So the log is the complete signal and the column is the fast one; a row
// qualifies on either.
//
// A send can also be retired. "Rebook Shipment" (lib/rebookShipment.ts) is an
// operator saying the carrier booking was cancelled and a new one is being
// made, which is exactly as true of the email that announced it: the row goes
// back to step 3 and belongs under Ready to ship until the 3PL is told about
// the replacement carton. So a send at or before an order's latest rebook does
// not count, the same way a send older than the row does not.

import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { EZTRANS_SENT_ACTION } from './eztrans';
import { EZTRANS_BATCH_SENT_ACTION } from './eztransBatch';
import { REBOOK_ACTION } from './rebookShipment';

/** The dock-handoff step, where the pickup rail starts. Named because "4"
 *  appears nowhere else as a fact. */
export const PICKUP_STEP = 4;

/** Step 6, where the queue is done with a row. The pickup rail stops below it:
 *  a fulfilled row belongs to Shipped. The queue hands this function only
 *  rows under step 6, so this is a guard rather than a filter — but the
 *  function is exported and the bound should be stated, not assumed. */
export const FULFILLED_STEP = 6;

/** The two activity-log types that mean "Goorooship has this shipment". */
export const GOOROOSHIP_SENT_TYPES: readonly string[] = [
  EZTRANS_SENT_ACTION,
  EZTRANS_BATCH_SENT_ACTION,
];

/** Every log type this module reads. A rebook is not a send — it is the thing
 *  that retires one, so it has to be fetched alongside them or the rail would
 *  go on believing in a collection that was cancelled. */
export const GOOROOSHIP_LOG_TYPES: readonly string[] = [
  ...GOOROOSHIP_SENT_TYPES,
  REBOOK_ACTION,
];

/** When the 3PL was told about a shipment, and by which of the two paths. */
export type GoorooshipSend = {
  at: string;
  via: 'batch' | 'booking';
};

/** What deciding this needs off a queue row. Structural rather than the whole
 *  FulfillmentQueueRow so a test can state one in four lines. */
export type PickupQueueRow = {
  id: string;
  order_id: string;
  step: number;
  label_confirmed_at: string | null;
  /** Added by 20260929120000; undefined on a database without it. */
  eztrans_batch_sent_at?: string | null;
  /** When this queue row was created — what dates a log send against it. */
  created_at?: string | null;
};

/** Has the 3PL been told about this row's carton, and when? Null if not.
 *
 *  The column wins over the log when both exist: it is the row's own record of
 *  the send that is holding it out of later batches.
 *
 *  The log is keyed by ORDER, not by queue row, and an order can outlive its
 *  row — "Shipment Not Ready" deletes the row, and re-confirming mints a new
 *  one. #1189 was booked to Goorooship on 2026-09-22, shipped, then sent back to
 *  be reshipped and re-confirmed on 2026-10-01. That September email was about
 *  the first carton, which has long since been collected. Read onto the new row
 *  it would park the reship under "To be picked up" the moment a label was
 *  confirmed, badged GOOROOSHIP NOTIFIED, with nobody having told the 3PL a
 *  thing about the second box.
 *
 *  So a log send older than the row is about a carton that is no longer this
 *  one. The row's own stamp is never date-checked — it is about this row by
 *  construction — and a row whose created_at is unknown keeps the old
 *  behaviour, since an absent date is not grounds to drop a real send. #1189 is
 *  the only live row where a send predates the row; every other one was mailed
 *  after its row existed, which is the normal order of events. */
export function goorooshipSend(
  row: PickupQueueRow,
  sends: Map<string, GoorooshipSend>,
): GoorooshipSend | null {
  if (row.eztrans_batch_sent_at) return { at: row.eztrans_batch_sent_at, via: 'batch' };
  const send = sends.get(row.order_id);
  if (!send) return null;
  if (predatesRow(send.at, row.created_at)) return null;
  return send;
}

/** Did `sentAt` happen strictly before the row existed? False whenever either
 *  date is missing or unparseable — this only ever discards a send, so an
 *  unknown date must not be read as grounds to discard one. */
function predatesRow(sentAt: string, rowCreatedAt: string | null | undefined): boolean {
  if (!rowCreatedAt) return false;
  const sent = Date.parse(sentAt);
  const created = Date.parse(rowCreatedAt);
  if (!Number.isFinite(sent) || !Number.isFinite(created)) return false;
  return sent < created;
}

/** Does this row ship out of EZ Trans — i.e. is the Goorooship email part of
 *  its handoff at all?
 *
 *  Unknown counts as yes. The caller's answer comes off a query that has to
 *  return before it means anything, and the two wrong answers are not
 *  symmetric: calling an EZ Trans row ours holds a labelled carton in Ready to
 *  ship for a moment, while calling one of ours EZ Trans's would park it in
 *  the pickup rail with no email behind it. */
export type IsEzTransRow = (row: PickupQueueRow) => boolean;
const ALWAYS_EZTRANS: IsEzTransRow = () => true;

/** Is this row out of the packer's hands — with the carrier, or already gone?
 *
 *  Named for the rail rather than literally: a step-5 row has usually been
 *  collected already. What the two steps share is that no one in the warehouse
 *  has anything left to pack.
 *
 *  The Goorooship email is the third condition only for the rows it exists
 *  for. Stock picked off our own floor is booked through Freightcom and EZ
 *  Trans is never emailed about it, so requiring a send there would leave
 *  every Freightcom carton sitting in Ready to ship after the label was
 *  confirmed, which is the one rail a picker reads to decide what to pack
 *  next. For an EZ Trans row the send is still the whole point: the 3PL does
 *  not touch a box it has not been told about, so until the email goes the
 *  carton is still ours to chase. Step 3 gates the confirm on exactly the same
 *  fact (queue/StepLabel.tsx), so the two cannot drift. */
export function isAwaitingPickup(
  row: PickupQueueRow,
  sends: Map<string, GoorooshipSend>,
  isEzTrans: IsEzTransRow = ALWAYS_EZTRANS,
): boolean {
  if (row.step < PICKUP_STEP || row.step >= FULFILLED_STEP) return false;
  // Step 4 implies a confirmed label today, but a row can be rewound and the
  // operator's rule names the label explicitly, so it is checked rather than
  // assumed. A carton with no tracking number is not waiting on anyone.
  if (!row.label_confirmed_at) return false;
  if (!isEzTrans(row)) return true;
  return goorooshipSend(row, sends) !== null;
}

/** Split the Ready rail in two, preserving the order it came in.
 *
 *  Moved, not copied: a row is in exactly one of the two rails, so the counts
 *  on the tabs still add up to the work outstanding. A row at step 4 that the
 *  3PL has *not* been told about stays under Ready to ship on purpose — it is
 *  still ours to chase, and that is the only place anyone would look for it. */
export function splitAwaitingPickup<T extends PickupQueueRow>(
  rows: T[],
  sends: Map<string, GoorooshipSend>,
  isEzTrans: IsEzTransRow = ALWAYS_EZTRANS,
): { ready: T[]; pickup: T[] } {
  const ready: T[] = [];
  const pickup: T[] = [];
  for (const r of rows) (isAwaitingPickup(r, sends, isEzTrans) ? pickup : ready).push(r);
  return { ready, pickup };
}

/** Badge text for a row in the pickup rail. */
export const PICKUP_BADGE_LABEL = '✉ GOOROOSHIP NOTIFIED';

/** The hover explanation behind that badge — which email, when, and what the
 *  row is actually waiting on.
 *
 *  The rail now holds both halves of the handoff, so the closing sentence has
 *  to come off the step rather than being the same for everything on it:
 *  telling an operator a step-5 carton is "waiting on the carrier to collect"
 *  when the dock was confirmed days ago is the kind of small lie that makes
 *  people stop reading the badge. */
export function pickupBadgeTitle(send: GoorooshipSend, step: number = PICKUP_STEP): string {
  const when = Number.isNaN(Date.parse(send.at))
    ? send.at
    : new Date(send.at).toLocaleString();
  const how = send.via === 'batch'
    ? `Sent to Goorooship in the day batch on ${when}.`
    : `Sent to Goorooship as its own booking email on ${when}.`;
  const waiting = step > PICKUP_STEP
    ? 'Collected — the shipment-confirmation email to the customer is still to send.'
    : 'Waiting on the carrier to collect.';
  return `${how} ${waiting}`;
}

/** One activity_log row, narrowed to what identifies a send. */
export type GoorooshipSendLogRow = {
  ts: string;
  type: string;
  entity_id: string | null;
};

/** Index the log rows by order id, latest send winning.
 *
 *  Pure, so the mapping can be tested without a database — and so the rule
 *  that a resend supersedes an earlier one is stated once. */
export function indexGoorooshipSends(rows: GoorooshipSendLogRow[]): Map<string, GoorooshipSend> {
  // Pass one: when each order's booking was last torn up. A rebook says the
  // carrier booking before it was cancelled, so every send at or before it is
  // about a carton that is no longer coming — the operator is back at step 3
  // booking a fresh label, and the 3PL has been told nothing about that one.
  const rebookedAt = new Map<string, string>();
  for (const r of rows) {
    if (r.type !== REBOOK_ACTION || !r.entity_id) continue;
    const prev = rebookedAt.get(r.entity_id);
    if (prev && !isBefore(prev, r.ts)) continue;
    rebookedAt.set(r.entity_id, r.ts);
  }

  const m = new Map<string, GoorooshipSend>();
  for (const r of rows) {
    if (!r.entity_id) continue;
    if (!GOOROOSHIP_SENT_TYPES.includes(r.type)) continue;
    const cancelled = rebookedAt.get(r.entity_id);
    if (cancelled && !isBefore(cancelled, r.ts)) continue;
    const prev = m.get(r.entity_id);
    if (prev && Date.parse(prev.at) >= Date.parse(r.ts)) continue;
    m.set(r.entity_id, {
      at: r.ts,
      via: r.type === EZTRANS_BATCH_SENT_ACTION ? 'batch' : 'booking',
    });
  }
  return m;
}

/** Did `a` happen strictly before `b`? False when either is unparseable, so an
 *  unreadable timestamp can never silently retire a real send. */
function isBefore(a: string, b: string): boolean {
  const at = Date.parse(a);
  const bt = Date.parse(b);
  return Number.isFinite(at) && Number.isFinite(bt) && at < bt;
}

/** Every Goorooship send on record, by order id.
 *
 *  Fetched once and re-read on demand rather than subscribed to: the two
 *  things that add a row here — the day-batch button and the per-order send —
 *  both already call back into the queue to refresh it, and `refresh` is
 *  wired to the same callbacks. A realtime-only hook on this would go stale
 *  the first time the socket dropped and strand a carton in the wrong rail.
 */
export function useGoorooshipSends(): {
  sends: Map<string, GoorooshipSend>;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [sends, setSends] = useState<Map<string, GoorooshipSend>>(new Map());
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { data, error } = await supabase
      .from('activity_log')
      .select('ts, type, entity_id')
      .in('type', GOOROOSHIP_LOG_TYPES)
      .order('ts', { ascending: true })
      .limit(5000);
    if (error) { console.error('Goorooship sends fetch failed:', error); return; }
    setSends(indexGoorooshipSends((data ?? []) as GoorooshipSendLogRow[]));
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      await refresh();
      if (live) setLoading(false);
    })();
    return () => { live = false; };
  }, [refresh]);

  return { sends, loading, refresh };
}
