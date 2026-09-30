/** The carriers `fulfillment_queue.carrier` will accept, and how to get an
 *  operator's free text into that column safely.
 *
 *  This list is not a UI preference. It is a CHECK constraint on the column
 *  (`fulfillment_queue_carrier_check`, widened to six in the 20260605110000
 *  migration), so a value outside it does not degrade the write — it fails it.
 *
 *  That cost us a shipment. R-0069 was a replacement jumper that went out in an
 *  Amazon box on 2026-09-29, and "Amazon" is what the operator typed into the
 *  free-text Carrier field on Fulfillment › Queue. markPartsReplacementShipped
 *  stamped `orders` (free text, accepted), then hit the constraint on the queue
 *  upsert and threw — leaving the order shipped, its queue row at step 1, the
 *  shipment unlogged and the ticket still tagged "Queued for Replacement". The
 *  order read as shipped everywhere except the one list the picker works from,
 *  where it sat in "Ready to ship" as an invitation to send a second box. And
 *  the retry was blocked by its own half-written state: shipped_at was set, so
 *  the button that would have finished the job refused to run.
 *
 *  So the two columns are treated as the different things they are:
 *    - `orders.carrier` is free text and keeps what the operator said. "Amazon"
 *      is the true answer to "how did this leave?" and is worth keeping.
 *    - `fulfillment_queue.carrier` takes a value from this list or nothing.
 *      An omitted column on an upsert keeps whatever the row already had, so
 *      dropping an unmatched carrier can't blank a label recorded at step 4.
 *
 *  Kept dependency-free so both `lib/orders.ts` and `lib/fulfillment.ts` can
 *  import it — fulfillment already imports orders, and the reverse would close
 *  a runtime cycle.
 */
export const QUEUE_CARRIERS = ['UPS', 'FedEx', 'Purolator', 'Canada Post', 'Canpar', 'GLS'] as const;

export type QueueCarrier = typeof QUEUE_CARRIERS[number];

/** Collapse to letters and digits so spelling and spacing stop mattering:
 *  "canada post", "Canada Post" and "CanadaPost" are one carrier, and the
 *  operator typing the first should not be the difference between a recorded
 *  shipment and a half-written one. */
function key(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The operator's carrier as `fulfillment_queue.carrier` can hold it, or null
 *  when the column would reject it (including blank and undefined). Never
 *  throws: a carrier nobody anticipated is a thing to leave out of one column,
 *  not a reason to lose the shipment. */
export function queueCarrier(raw: string | null | undefined): QueueCarrier | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  return QUEUE_CARRIERS.find(c => key(c) === key(trimmed)) ?? null;
}
