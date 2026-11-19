// Rebooking a cancelled shipment.
//
// A carton gets a Freightcom label, the dock hands it over, Goorooship is told
// to collect it and the customer is emailed a tracking number. Then the pickup
// is cancelled — the carrier never came, the quote was wrong, the pallet moved
// — and the whole booking has to be made again from scratch, against the same
// order and the same machines.
//
// Nothing in the queue could say that. "← Back" steps one square and keeps
// every field, which is right for a mis-click and wrong here: the carrier and
// tracking number it preserves belong to a shipment that no longer exists, and
// re-confirming the step would mail the customer a number the carrier has
// already voided. The other two exits — Cancel Order and Shipment Not Ready —
// both delete the queue row, which throws away the pick, the test report and
// the order's place in the queue to re-book one label.
//
// So: one button that puts the row back at step 3 with the booking erased, and
// nothing else touched. The pick stands, the test report stands, the order
// stays confirmed. What goes is everything that described the cancelled
// shipment:
//
//   carrier / tracking / label PDF   the next booking writes its own
//   the dock checklist               the carton is back on our floor
//   the Goorooship stamps            so it can ride the next day's batch
//   the customer email + fulfilled   so both can be sent again
//
// Two things beyond the row itself have to move with it, or the rebooked order
// lands somewhere no one will look for it:
//
//   units       step 6 stamps every assigned machine 'shipped' (the
//               sync_unit_on_fulfillment trigger). They did not ship. Left
//               alone they are a lie in Stock, and shippedOrders.ts reads
//               exactly that stamp to file the row under Shipped with an
//               ALREADY SHIPPED — DO NOT PACK banner over the step UI.
//   the order   `reconcile_outcome = 'open'` is the existing, documented way
//               an operator says "this order still owes the customer a
//               machine", and it is what keeps the inference in
//               markShippedForOrder (a shipments row booked against the order)
//               from re-filing the row the same way. Same verdict a reship
//               gets from returnOrderToReview, for the same reason.
//
// And the Goorooship rail is decided from the activity log, not from the row
// (lib/pickupQueue.ts), so clearing eztrans_batch_sent_at is not enough on its
// own: the September email about the old carton is still on record. The rebook
// writes its own log line against the order, and a send older than the latest
// rebook is a send about a carton that has been and gone.

import { supabase } from './supabase';
import { logAction } from './activityLog';
import { assignedSerials } from './fulfillment';

/** The activity_log type a rebook writes, against the ORDER — the same entity
 *  the two Goorooship sends are logged against, which is what lets
 *  indexGoorooshipSends tell a live send from a cancelled one. */
export const REBOOK_ACTION = 'fq_shipment_rebooked';

/** Where a rebooked row lands: step 3, "Attach the shipping label details". */
export const LABEL_STEP = 3;

/** Is there a booking on this row to redo?
 *
 *  Step 3 is where the label is booked, so a row at or below it has nothing
 *  cancelled to undo — it is already sitting on the form this button exists to
 *  send people back to. */
export function canRebookShipment(row: { step: number }): boolean {
  return row.step > LABEL_STEP;
}

/** What the cancelled booking was, and what the rebook had to put right. */
export type RebookedShipment = {
  order_ref: string;
  /** The carrier and tracking number that have just been cleared off the row. */
  previous: { carrier: string | null; tracking_num: string | null };
  /** Machines taken back off 'shipped' and reserved against the order again. */
  restored: string[];
};

type QueueRowForRebook = {
  id: string;
  order_id: string;
  step: number;
  assigned_serial: string | null;
  carrier: string | null;
  tracking_num: string | null;
};

type UnitStateRow = { serial: string; status: string; backfilled_at: string | null };

/** The booking fields, blanked. The row keeps its pick, its test report, its
 *  due date and its priority — none of those were cancelled.
 *
 *  starter_tracking_num stays too: the US compost starter ships from Amazon on
 *  its own label and is not part of the freight booking that fell through. */
const CLEARED_BOOKING = {
  step: LABEL_STEP,
  carrier: null,
  tracking_num: null,
  label_pdf_path: null,
  label_confirmed_at: null,
  label_confirmed_by: null,
  dock_printed: false,
  dock_affixed: false,
  dock_docked: false,
  dock_notified: false,
  dock_picked_up: false,
  dock_confirmed_at: null,
  dock_confirmed_by: null,
  email_sent_at: null,
  email_sent_by: null,
  fulfilled_at: null,
  fulfilled_by: null,
} as const;

/** The four columns 20260929120000_eztrans_daily_batch.sql adds. Written in the
 *  same UPDATE when they exist and dropped when they don't — migrations here
 *  are applied by hand, and a database without them has no batch to come out
 *  of anyway. */
const CLEARED_BATCH = {
  eztrans_confirmed_at: null,
  eztrans_confirmed_by: null,
  eztrans_packing_list: null,
  eztrans_batch_sent_at: null,
} as const;

function isMissingBatchColumn(e: unknown): boolean {
  const msg = (e as { message?: string })?.message ?? String(e);
  return /eztrans_confirmed_at|eztrans_confirmed_by|eztrans_packing_list|eztrans_batch_sent_at/.test(msg);
}

/** Blank the booking on the queue row.
 *
 *  First of the three writes on purpose: it is the one that can fail for a
 *  reason the operator cannot see coming, and failing it before anything else
 *  moves leaves the shipment exactly as it was. */
async function clearTheBooking(queueId: string): Promise<void> {
  const { error } = await supabase
    .from('fulfillment_queue')
    .update({ ...CLEARED_BOOKING, ...CLEARED_BATCH })
    .eq('id', queueId);
  if (!error) return;
  if (!isMissingBatchColumn(error)) {
    throw new Error(`Could not clear the booking on this shipment: ${error.message}`);
  }
  const { error: retry } = await supabase
    .from('fulfillment_queue')
    .update(CLEARED_BOOKING)
    .eq('id', queueId);
  if (retry) throw new Error(`Could not clear the booking on this shipment: ${retry.message}`);
}

/** Put every machine the step-6 trigger marked 'shipped' back to 'reserved'.
 *
 *  A unit carrying `backfilled_at` is skipped: it was paired with the order
 *  having already shipped months ago (the Backlog #57 flow), so it is 'shipped'
 *  on its own account and not because of this booking. */
async function restoreShippedUnits(queueId: string, fallback: string | null): Promise<string[]> {
  const serials = await assignedSerials(queueId, fallback);
  if (serials.length === 0) return [];

  const { data, error } = await supabase
    .from('units')
    .select('serial, status, backfilled_at')
    .in('serial', serials);
  if (error) throw new Error(`Could not read the machines on this shipment: ${error.message}`);

  const restored: string[] = [];
  for (const unit of (data ?? []) as UnitStateRow[]) {
    if (unit.status !== 'shipped' || unit.backfilled_at) continue;
    const { error: uErr } = await supabase
      .from('units')
      .update({ status: 'reserved', shipped_at: null })
      .eq('serial', unit.serial);
    if (uErr) {
      throw new Error(
        `The booking was cleared, but unit ${unit.serial} is still marked shipped `
        + `(${uErr.message}). Click Rebook Shipment again to finish putting it back.`,
      );
    }
    const { error: sErr } = await supabase
      .from('shelf_slots')
      .update({ status: 'reserved', updated_at: new Date().toISOString() })
      .eq('serial', unit.serial);
    if (sErr) throw new Error(`Failed to reserve the shelf slot for ${unit.serial}: ${sErr.message}`);
    restored.push(unit.serial);
  }
  return restored;
}

/** Rebook a shipment whose carrier booking and pickup were cancelled.
 *
 *  Returns the row to step 3 with the booking erased so a new label can be
 *  attached, confirmed and mailed to Goorooship and the customer exactly as the
 *  first one was. Not transactional, as with the rest of this module: the
 *  recovery is the activity log, and re-running it is safe — every write here
 *  is idempotent. */
export async function rebookShipment(queueId: string, note?: string): Promise<RebookedShipment> {
  const { data, error } = await supabase
    .from('fulfillment_queue')
    .select('id, order_id, step, assigned_serial, carrier, tracking_num')
    .eq('id', queueId)
    .single();
  if (error || !data) throw new Error(`Queue row not found: ${error?.message ?? 'no row'}`);
  const row = data as QueueRowForRebook;

  if (!canRebookShipment(row)) {
    throw new Error(
      'Nothing is booked on this shipment yet — it is already at the label step, '
      + 'where a new booking is attached.',
    );
  }

  const { data: order, error: oErr } = await supabase
    .from('orders')
    .select('id, order_ref, kind')
    .eq('id', row.order_id)
    .single();
  if (oErr || !order) throw new Error(`Order not found: ${oErr?.message ?? 'no row'}`);
  const { order_ref, kind } = order as { order_ref: string; kind: string | null };

  const previous = { carrier: row.carrier, tracking_num: row.tracking_num };
  const booking = [previous.carrier, previous.tracking_num].filter(Boolean).join(' · ') || 'no carrier recorded';

  await clearTheBooking(queueId);
  const restored = await restoreShippedUnits(queueId, row.assigned_serial);

  // A sale's own verdict that the customer is still owed a machine — see the
  // header note. A replacement is decided on its support ticket instead
  // (markShippedForOrder), so there is nothing to say here for one.
  if (kind !== 'replacement') {
    const { error: vErr } = await supabase
      .from('orders')
      .update({ reconcile_outcome: 'open' })
      .eq('id', row.order_id);
    // Non-fatal: the shipment has already been reopened by this point, and
    // making the operator click a finished action again helps nobody. Worst
    // case the row reads ALREADY SHIPPED off an old shipments row, which the
    // banner itself explains.
    if (vErr) console.warn('Rebook: could not mark the order still open (non-fatal):', vErr.message);
  }

  await logAction(
    REBOOK_ACTION,
    order_ref,
    `Shipment rebooked — ${booking} cancelled, back at step ${LABEL_STEP} (Label) for a new booking`
    + `${restored.length > 0 ? ` · ${restored.join(', ')} back on the shelf, reserved` : ''}`
    + `${note?.trim() ? ` · ${note.trim()}` : ''}`,
    {
      entityType: 'order',
      entityId: row.order_id,
      ...(row.assigned_serial ? { unitSerial: row.assigned_serial } : {}),
    },
  );

  return { order_ref, previous, restored };
}
