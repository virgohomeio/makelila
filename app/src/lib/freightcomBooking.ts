// Freightcom (own-floor) fulfillment path — the Freightcom half of step 3.
//
// Two carriers book the machines this queue ships, and until 2026-10-08 only
// one of them had a workflow. Stock held at the EZ Trans 3PL books through
// Goorooship (lib/eztrans.ts) as four moves: open the portal, book the
// shipment, record the label the portal issued — carrier, tracking number and
// the label PDF, all three required — and confirm it, which is what makes the
// pickup real. Stock on our own floor books through Freightcom, and that half
// was a bare card: a carrier dropdown, a tracking field, a label PDF marked
// "(optional)", and the step opened the moment two fields had text in them.
//
// So the label went unattached. Of the 111 rows the queue has carried to step
// 6, 28 have a label PDF on them and 12 of those 28 are EZ Trans rows — the
// ones where it was demanded. A Freightcom shipment that goes wrong is then a
// shipment with no label on file to check a claim against, and the carrier's
// own copy is the only copy.
//
// This module is the data layer for the Freightcom path, written so the two
// are the same four moves. It books nothing itself: the shipment is made on
// the Freightcom portal, exactly as the Goorooship one is made on Goorooship's
// — "confirm" here means the booking is on our record, which is the same thing
// it means in the Goorooship panel.
//
// (Freightcom *can* be booked by API — `bookShipment` in lib/shipping.ts, the
// Shipping module's Book a Label. That is a different door into the same
// carrier and is deliberately left alone here: step 3 records a booking an
// operator made, whichever door they used.)

import { logAction, useActivityForEntity } from './activityLog';
import { REBOOK_ACTION } from './rebookShipment';
import { saveQueueLabel } from './fulfillment';

/** The Freightcom portal, opened at a blank shipment. The account path is
 *  ours; it was inline in StepLabel before this module existed. */
export const FREIGHTCOM_SHIP_URL =
  'https://live.freightcom.com/c/mNyRdnwfdBn2raBkyImG9lemXej03RJB/ship/new';

/** Logged when an operator confirms a Freightcom booking onto a row. The
 *  Goorooship equivalents are EZTRANS_SENT_ACTION and
 *  EZTRANS_BATCH_CONFIRMED_ACTION; this is the third sibling, and it is what
 *  an order's history has to show for a Freightcom carton. */
export const FREIGHTCOM_CONFIRMED_ACTION = 'fq_freightcom_booking_confirmed';

/** The parts of a queue row that are the booking. */
export type FreightcomBookingRow = {
  carrier: string | null;
  tracking_num: string | null;
  label_pdf_path: string | null;
};

/** Is this order's Freightcom booking on the record?
 *
 *  Read off the row rather than stamped into a column of its own. The three
 *  fields *are* the booking — a fourth column claiming the booking is
 *  confirmed could only ever come to disagree with them, and the row is
 *  already the thing every other reader trusts: the pickup rail asks whether
 *  carrier and tracking are on it (lib/pickupQueue.ts), and the dock step asks
 *  for the label PDF by the same path.
 *
 *  It also means no migration stands between this gate and production, which
 *  for a gate is the difference between shipping and shipping-in-principle.
 */
export function freightcomBookingConfirmed(row: FreightcomBookingRow): boolean {
  return !!row.carrier?.trim() && !!row.tracking_num?.trim() && !!row.label_pdf_path;
}

/** Record a Freightcom booking against a queue row, and say so in the order's
 *  history.
 *
 *  Does not advance the step, for the same reason the Goorooship save does
 *  not: the operator is still standing in step 3, and "Pickup scheduled" is a
 *  separate statement about a carton that is now the carrier's problem.
 *
 *  The log line is written against the order, not the queue row, because that
 *  is where the rest of an order's history lives and where the Goorooship
 *  sends put theirs — an operator asking "how did this box get booked?" should
 *  find both answers in one place. */
export async function confirmFreightcomBooking(
  queueId: string,
  input: {
    carrier: string;
    tracking_num: string;
    label_pdf?: File;
    /** For the log line only. */
    order: { id: string; order_ref: string };
    serials: string[];
  },
): Promise<{ label_pdf_path: string | null }> {
  const { label_pdf_path } = await saveQueueLabel(queueId, {
    carrier: input.carrier,
    tracking_num: input.tracking_num,
    ...(input.label_pdf ? { label_pdf: input.label_pdf } : {}),
  });

  const tracking = input.tracking_num.trim();
  await logAction(
    FREIGHTCOM_CONFIRMED_ACTION,
    input.order.order_ref,
    `Freightcom booking confirmed — ${input.carrier} ${tracking}` +
    `${input.serials.length ? ` · ${input.serials.length} unit(s) ${input.serials.join(', ')}` : ''}` +
    ` · label PDF ${label_pdf_path ? 'attached' : 'already on the row'}`,
    {
      entityType: 'order',
      entityId: input.order.id,
      ...(input.serials[0] ? { unitSerial: input.serials[0] } : {}),
    },
  );

  return { label_pdf_path };
}

/** Has this order been booked on Freightcom?
 *
 *  The durable answer to "which carrier is this carton going out with", and
 *  the reason step 3 can remember that choice across a reload without a column
 *  to hold it: the confirm above writes a line to the order's history, and
 *  that line is the record.
 *
 *  Unless the booking it announced has since been torn up. "Rebook Shipment"
 *  is an operator saying the carrier was stood down and a new carton is going
 *  out — it clears the carrier, the tracking number and the label off the row
 *  (lib/rebookShipment.ts), so the Freightcom booking it is describing no
 *  longer exists. Entries arrive newest-first, so the first of each type is
 *  the latest, and a confirm at or before the latest rebook does not count.
 *  Read the same way EzTransPanel reads its own sends, so the two paths agree
 *  about what a rebook retires. */
export function useFreightcomBooked(orderId: string | null | undefined): {
  booked: boolean;
  at: string | null;
  loading: boolean;
} {
  const { entries, loading } = useActivityForEntity({
    entityType: 'order',
    ...(orderId ? { entityId: orderId } : {}),
    limit: 50,
  });
  const confirmed = entries.find(e => e.type === FREIGHTCOM_CONFIRMED_ACTION) ?? null;
  const rebookedAt = entries.find(e => e.type === REBOOK_ACTION)?.ts ?? null;
  const live = confirmed && rebookedAt && Date.parse(confirmed.ts) <= Date.parse(rebookedAt)
    ? null
    : confirmed;
  return { booked: !!live, at: live?.ts ?? null, loading };
}
