// EZ Trans (Goorooship) fulfillment path.
//
// Most machines ship from our own floor and are booked through Freightcom.
// Stock held at the EZTrans 3PL is booked through Goorooship instead, and the
// 3PL only picks the box once we email them a confirmation with a packing
// list. This module is the data + text layer for that second path; the UI
// lives in Fulfillment > Queue > step 3 (StepLabel).
//
// The wording is an operator-editable template (email_templates key
// 'eztrans_booking', edited in the Templates tab) with a built-in default
// below for environments where that row hasn't been migrated in yet. The panel
// pre-fills from it and the operator can still tweak a one-off before sending.
// The packing list is NOT part of the template — see EzTransBooking.

import { useEffect, useState } from 'react';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';
import { renderTemplate, useEmailTemplate } from './templates';

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

/** email_templates.key for the operator-editable wording (Templates tab). */
export const EZTRANS_TEMPLATE_KEY = 'eztrans_booking';

// Duplicated from supabase/functions/_shared/eztransTemplate.ts so the panel
// can preview without a round-trip, and so a send still works in an
// environment where the template row has not been migrated in yet.
// eztransTemplate.test.ts fails the build if the two copies drift.
export const DEFAULT_EZTRANS_SUBJECT =
  'Order confirmed — {{order_ref}} · {{sku}} · Serial {{serial}}';

export const DEFAULT_EZTRANS_BODY =
  'Hello EZ Trans team,\n' +
  '\n' +
  'We are confirming that an order has been placed and the shipment has been ' +
  'booked on Goorooship. Please fulfill it on your end. The packing list and ' +
  'the shipping label are attached to this email.\n' +
  '\n' +
  'CUSTOMER\n' +
  'Name: {{customer_name}}\n' +
  'Address: {{customer_address}}\n' +
  'Email: {{customer_email}}\n' +
  'Phone: {{customer_phone}}\n' +
  '\n' +
  'SHIPMENT\n' +
  'Product Name: {{product_name}}\n' +
  'SKU: {{sku}}\n' +
  'Serial No: {{serial}}\n' +
  'Batch/Lot Number: {{batch_lot}}\n' +
  'Master Carton: {{master_carton}}\n' +
  'Quantity: {{quantity}}\n' +
  '\n' +
  'SHIPPING LABEL (attached)\n' +
  'Carrier: {{carrier}}\n' +
  'Tracking Number: {{tracking}}\n' +
  'Please print the attached label and affix it to the carton.\n' +
  '\n' +
  'Order reference: {{order_ref}}\n' +
  '\n' +
  'Please reply to confirm once the unit is picked and the shipment is on its way.\n' +
  '\n' +
  'Thank you,\n' +
  'The VCycene Team';

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
  /** The packing list, as the lines that go on the attached PDF. Built here,
   *  never from the template: it is the document EZ Trans picks from, and a
   *  field edited out of it would silently ship a box nobody can identify. */
  packingList: string[];
};

export type EzTransBookingArgs = {
  order: EzTransShipTo & { order_ref: string };
  serial: string;
  masterCarton: string | null;
  /** From the Goorooship booking. Both are required before the email can go. */
  carrier: string | null;
  tracking: string | null;
};

/** Everything the template can interpolate. Missing values become an em dash
 *  rather than a blank, so a gap on the 3PL's copy reads as a gap. */
export function ezTransVariables(args: EzTransBookingArgs): Record<string, string> {
  const { order, serial, masterCarton, carrier, tracking } = args;
  return {
    customer_name: order.customer_name,
    // Continuation lines are indented under "Address: " so the block still
    // reads as one address in a plain-text mail client.
    customer_address: addressLines(order).join('\n         '),
    customer_email: order.customer_email ?? '—',
    customer_phone: order.customer_phone ?? '—',
    product_name: PACKING_LIST_PRODUCT_NAME,
    sku: PACKING_LIST_SKU,
    serial,
    batch_lot: PACKING_LIST_BATCH_LOT,
    master_carton: masterCarton ?? '—',
    quantity: String(PACKING_LIST_QUANTITY),
    carrier: carrier ?? '—',
    tracking: tracking ?? '—',
    order_ref: order.order_ref,
  };
}

/** Render the booking email + packing list.
 *
 *  `template` is the operator-editable wording from the Templates tab; when it
 *  is absent (the row hasn't been migrated into this environment) the built-in
 *  default stands in, so a send is never blocked on a pending migration. */
export function buildEzTransBooking(
  args: EzTransBookingArgs & { template?: { subject: string; body: string } | null },
): EzTransBooking {
  const { order, serial, masterCarton } = args;
  const addr = addressLines(order);
  const email = order.customer_email ?? '—';
  const phone = order.customer_phone ?? '—';
  const carton = masterCarton ?? '—';

  const vars = ezTransVariables(args);
  const subject = renderTemplate(args.template?.subject || DEFAULT_EZTRANS_SUBJECT, vars);
  const body = renderTemplate(args.template?.body || DEFAULT_EZTRANS_BODY, vars);

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
    '',
    'SHIPPING',
    `Carrier: ${vars.carrier}`,
    `Tracking No: ${vars.tracking}`,
  ];

  return { subject, body, packingList };
}

/** The label details Goorooship gives back, saved onto the queue row.
 *
 *  Deliberately does NOT advance the step: the operator is still standing in
 *  step 3 and has yet to send the confirmation, and moving to step 4 here
 *  would unmount the panel out from under them. `confirmLabel` still owns the
 *  step-3 -> step-4 transition, and it leaves `label_pdf_path` alone when no
 *  new file is picked, so the label uploaded here survives it.
 *
 *  Uses the same `order-labels` bucket and path convention as confirmLabel so
 *  a label is a label wherever it was attached from. */
export async function saveEzTransLabel(
  queueId: string,
  input: { carrier: string; tracking_num: string; label_pdf?: File },
): Promise<{ label_pdf_path: string | null }> {
  let label_pdf_path: string | null = null;
  if (input.label_pdf) {
    const path = `${queueId}/label-${Date.now()}.pdf`;
    const { error: upErr } = await supabase.storage
      .from('order-labels')
      .upload(path, input.label_pdf, { contentType: 'application/pdf' });
    if (upErr) throw upErr;
    label_pdf_path = path;
  }
  const { error } = await supabase
    .from('fulfillment_queue')
    .update({
      carrier: input.carrier,
      tracking_num: input.tracking_num.trim(),
      ...(label_pdf_path ? { label_pdf_path } : {}),
    })
    .eq('id', queueId);
  if (error) throw error;
  return { label_pdf_path };
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

/** The operator-editable wording, plus whether it came from the Templates tab
 *  or the built-in default (which is worth saying out loud in the panel — an
 *  edit made in Templates that hasn't been migrated in would otherwise look
 *  like it had simply been ignored). */
export function useEzTransTemplate(): {
  template: { subject: string; body: string };
  source: 'template' | 'built-in';
  loading: boolean;
} {
  const { template, loading } = useEmailTemplate(EZTRANS_TEMPLATE_KEY);
  const usable = template && template.active ? template : null;
  return {
    template: usable
      ? { subject: usable.subject, body: usable.body }
      : { subject: DEFAULT_EZTRANS_SUBJECT, body: DEFAULT_EZTRANS_BODY },
    source: usable ? 'template' : 'built-in',
    loading,
  };
}

/** Send the booking confirmation, packing list and label to cs@goorooship.ca.
 *
 *  `override` is the subject/body the operator typed for this one order. The
 *  packing list and the label are NOT overridable: the edge function rebuilds
 *  the list from the queue row, the order and the shelf row, and pulls the
 *  label out of storage, so an edited email can never put different numbers on
 *  the documents the 3PL actually picks and ships from. */
export async function sendEzTransBooking(
  queueId: string,
  override?: { subject: string; body: string },
): Promise<{ email_id: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-eztrans-booking`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({
      queue_id: queueId,
      ...(override ? { subject: override.subject, body: override.body } : {}),
    }),
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
