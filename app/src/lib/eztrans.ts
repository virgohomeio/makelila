// EZ Trans (Goorooship) fulfillment path.
//
// Most machines ship from our own floor and are booked through Freightcom.
// Stock held at the EZTrans 3PL is booked through Goorooship instead, and the
// 3PL only picks the box once we email them a confirmation with a packing
// list. This module is the data + text layer for that second path; the UI
// lives in Fulfillment > Queue > step 3 (StepLabel).
//
// The email body and packing list are duplicated in
// supabase/functions/send-eztrans-booking/index.ts — that copy is the one
// actually sent, this one is the operator's preview. Keep them in step (same
// split as the fulfillment shipping email).

import { useEffect, useState } from 'react';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';

/** Where a shipment out of EZ Trans gets booked. */
export const GOOROOSHIP_SHIP_URL = 'https://app.goorooship.ca/ship';

/** shelf_slots.location / units.location value for the EZ Trans 3PL. */
export const EZTRANS_LOCATION = 'EZTrans';

/** Who at EZ Trans receives the booking confirmation + packing list. */
export const EZTRANS_EMAIL = 'cs@goorooship.ca';

/** Everything on the packing list that is the same on every box we ship. */
export const PACKING_LIST_PRODUCT_NAME = 'LILA Kitchen Composter';
export const PACKING_LIST_SKU = 'LILA-P100X';
export const PACKING_LIST_BATCH_LOT = 'P100X';
export const PACKING_LIST_QUANTITY = 1;

/** The activity_log type written after a confirmation is sent. */
export const EZTRANS_SENT_ACTION = 'fq_eztrans_booking_sent';

export type EzTransPlacement = {
  serial: string;
  /** Shelf group the unit sits on, e.g. "EZ-P01". Null when the only evidence
   *  the unit is at EZ Trans is units.location. */
  skid: string | null;
  /** units.pallet, e.g. "P01". Null for the un-manifested shipments. */
  pallet: string | null;
  /** What goes in the packing list's Master Carton field. */
  masterCarton: string | null;
};

/** Master carton number for a shelf group key.
 *
 *  EZ-P01 -> "1", P14 -> "14". A group that isn't a numbered pallet (the two
 *  un-manifested shipments are grouped as EZ-S2 / EZ-S3) has no carton number
 *  to give, so the key itself is passed through rather than inventing one —
 *  a wrong carton number on a packing list sends the 3PL to the wrong stack. */
export function masterCartonFromSkid(skid: string | null | undefined): string | null {
  if (!skid) return null;
  const key = skid.trim();
  if (!key) return null;
  const m = /^(?:[A-Z]{2}-)?P0*(\d+)$/i.exec(key);
  if (m) return String(Number(m[1]));
  return key;
}

/** Address of an order, as the packing list and the booking email need it. */
export type EzTransShipTo = {
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

/** The address as lines, skipping the parts an order doesn't have. */
export function addressLines(o: EzTransShipTo): string[] {
  const lines: string[] = [];
  if (o.address_line) lines.push(o.address_line);
  if (o.address_line2) lines.push(o.address_line2);
  const cityLine = [o.city, o.region_state, o.postal_code].filter(Boolean).join(', ');
  if (cityLine) lines.push(cityLine);
  lines.push(o.country);
  return lines;
}

/** One-line form, for a preview or a log line. */
export function addressOneLine(o: EzTransShipTo): string {
  return addressLines(o).join(', ');
}

export type EzTransBooking = {
  subject: string;
  body: string;
  /** The packing list, as the lines that go on the attached PDF. */
  packingList: string[];
};

export function buildEzTransBooking(args: {
  order: EzTransShipTo & { order_ref: string };
  serial: string;
  masterCarton: string | null;
}): EzTransBooking {
  const { order, serial, masterCarton } = args;
  const addr = addressLines(order);
  const email = order.customer_email ?? '—';
  const phone = order.customer_phone ?? '—';
  const carton = masterCarton ?? '—';

  const subject =
    `Order confirmed — ${order.order_ref} · ${PACKING_LIST_SKU} · Serial ${serial}`;

  const body =
    `Hello EZ Trans team,\n\n` +
    `We are confirming that an order has been placed and the shipment has been ` +
    `booked on Goorooship. Please fulfill it on your end. The packing list is ` +
    `attached to this email.\n\n` +
    `CUSTOMER\n` +
    `Name: ${order.customer_name}\n` +
    `Address: ${addr.join('\n         ')}\n` +
    `Email: ${email}\n` +
    `Phone: ${phone}\n\n` +
    `SHIPMENT\n` +
    `Product Name: ${PACKING_LIST_PRODUCT_NAME}\n` +
    `SKU: ${PACKING_LIST_SKU}\n` +
    `Serial No: ${serial}\n` +
    `Batch/Lot Number: ${PACKING_LIST_BATCH_LOT}\n` +
    `Master Carton: ${carton}\n` +
    `Quantity: ${PACKING_LIST_QUANTITY}\n\n` +
    `Order reference: ${order.order_ref}\n\n` +
    `Please reply to confirm once the unit is picked and the shipment is on its way.\n\n` +
    `Thank you,\n` +
    `The VCycene Team`;

  const packingList = [
    'PACKING LIST',
    `Order: ${order.order_ref}`,
    '',
    'SHIP TO',
    order.customer_name,
    ...addr,
    `Email: ${email}`,
    `Phone: ${phone}`,
    '',
    'CONTENTS',
    `Product Name: ${PACKING_LIST_PRODUCT_NAME}`,
    `SKU: ${PACKING_LIST_SKU}`,
    `Serial No: ${serial}`,
    `Batch/Lot Number: ${PACKING_LIST_BATCH_LOT}`,
    `Master Carton: ${carton}`,
    `Quantity: ${PACKING_LIST_QUANTITY}`,
  ];

  return { subject, body, packingList };
}

/** Is this unit sitting at EZ Trans, and on which pallet?
 *
 *  Two records can say a unit is at EZ Trans: the shelf board (shelf_slots,
 *  which also carries the pallet key) and Stock (units.location + units.pallet).
 *  Either is enough to route the order through Goorooship; the shelf row wins
 *  for the carton number because that is what the 3PL is looking at. */
export function useEzTransPlacement(serial: string | null | undefined): {
  placement: EzTransPlacement | null;
  loading: boolean;
} {
  const [placement, setPlacement] = useState<EzTransPlacement | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!serial) { setPlacement(null); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const [slotRes, unitRes] = await Promise.all([
        supabase.from('shelf_slots').select('skid, location').eq('serial', serial),
        supabase.from('units').select('location, pallet').eq('serial', serial).maybeSingle(),
      ]);
      if (cancelled) return;

      const slots = (slotRes.data as Array<{ skid: string; location: string }> | null) ?? [];
      // A serial can linger on an old slot after a move, so prefer the row
      // that actually says EZTrans over whichever row came back first.
      const slot = slots.find(s => s.location === EZTRANS_LOCATION) ?? null;
      const unit = (unitRes.data as { location: string | null; pallet: string | null } | null) ?? null;

      const atEzTrans = !!slot || unit?.location === EZTRANS_LOCATION;
      if (!atEzTrans) { setPlacement(null); setLoading(false); return; }

      setPlacement({
        serial,
        skid: slot?.skid ?? null,
        pallet: unit?.pallet ?? null,
        masterCarton: masterCartonFromSkid(slot?.skid ?? unit?.pallet ?? null),
      });
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [serial]);

  return { placement, loading };
}

/** Send the booking confirmation + packing list to cs@goorooship.ca.
 *  The edge function re-reads the queue row, the order and the shelf row, so
 *  the operator's preview can never put different numbers on the wire. */
export async function sendEzTransBooking(queueId: string): Promise<{ email_id: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-eztrans-booking`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ queue_id: queueId }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    let detail = bodyText;
    try {
      const parsed = JSON.parse(bodyText) as { error?: string };
      if (parsed.error) detail = parsed.error;
    } catch { /* keep raw */ }
    throw new Error(`EZ Trans email failed (${res.status}): ${detail}`);
  }
  try { return JSON.parse(bodyText) as { email_id: string }; }
  catch { throw new Error('EZ Trans email: response was not JSON'); }
}
