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
// The packing list is a template too (key 'eztrans_packing_list'), editable
// the same way. Its variables are still filled from the order and the queue
// row on the server, so an edit changes the wording, not the shipment.

import { useEffect, useState } from 'react';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';
import { renderTemplate, useEmailTemplate } from './templates';
// One implementation of the marker rules, imported rather than mirrored —
// unlike the string defaults, which must stay literal on both sides.
import {
  attachmentsNote,
  needsPesticideWorksheet,
  packingListLines,
} from '../../../supabase/functions/_shared/eztransTemplate';
import {
  goodsDescription,
  PESTICIDE_CERTIFIER,
  PESTICIDE_PART_NUMBER,
  PESTICIDE_TARIFF_NUMBER,
  formatWorksheetDate,
} from '../../../supabase/functions/_shared/pesticideWorksheet';

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

export { needsPesticideWorksheet };

/** What the 3PL receives, given the carrier on the queue row. The panel names
 *  these so an operator can see before sending whether the pesticide worksheet
 *  is going out — the same rule the edge function attaches by. */
export function attachmentFilenames(orderRef: string, carrier: string | null): string[] {
  const safeRef = orderRef.replace(/[^A-Za-z0-9._-]/g, '');
  const names = [`shipping-label-and-packing-list-${safeRef}.pdf`];
  if (needsPesticideWorksheet(carrier)) names.push(`pesticide-worksheet-${safeRef}.pdf`);
  return names;
}

/** The fields the UPS pesticide worksheet is tailored with for this shipment,
 *  for the read-only summary in the panel. The document itself is built on the
 *  server — this is the same data, so an operator can check the tracking
 *  number and the serial before the form goes to the broker. */
export function pesticideWorksheetSummary(args: {
  orderRef: string; serial: string; tracking: string | null;
}): Array<{ label: string; value: string }> {
  return [
    { label: 'Shipment number', value: args.tracking || '—' },
    { label: 'Part number', value: PESTICIDE_PART_NUMBER },
    {
      label: 'Description of goods',
      value: goodsDescription({
        serial: args.serial,
        batchLot: PACKING_LIST_BATCH_LOT,
        quantity: PACKING_LIST_QUANTITY,
        orderRef: args.orderRef,
      }),
    },
    { label: 'Tariff number', value: PESTICIDE_TARIFF_NUMBER },
    { label: 'Date', value: formatWorksheetDate(new Date()) },
    { label: 'Signed by', value: `${PESTICIDE_CERTIFIER.name}, ${PESTICIDE_CERTIFIER.title}` },
  ];
}

/** The activity_log type written after a confirmation is sent. */
export const EZTRANS_SENT_ACTION = 'fq_eztrans_booking_sent';

/** email_templates.key for the operator-editable wording (Templates tab). */
export const EZTRANS_TEMPLATE_KEY = 'eztrans_booking';

/** email_templates.key for the operator-editable packing list. */
export const EZTRANS_PACKING_LIST_KEY = 'eztrans_packing_list';

/** Who the booking confirmation comes from, and who is copied. Mirrors the
 *  edge function's defaults; eztransPackingList.test.ts fails on drift. */
export const EZTRANS_FROM = 'VCycene Fulfillment <reina@virgohome.io>';
export const EZTRANS_CC = [
  'reina@virgohome.io',
  'huayi@virgohome.io',
  // The 3PL asked for their group address on every inquiry.
  'support@goorooship.ca',
];

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
  'booked on Goorooship. Please fulfill it on your end. {{attachments_note}}\n' +
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
  'Please print the attached PDF and affix the shipping label to the carton.\n' +
  '\n' +
  'Order reference: {{order_ref}}\n' +
  '\n' +
  'Please reply to confirm once the unit is picked and the shipment is on its way.\n' +
  '\n' +
  'Thank you,\n' +
  'The VCycene Team';

export const DEFAULT_EZTRANS_PACKING_LIST =
  '# PACKING LIST\n' +
  'Order: {{order_ref}}\n' +
  'Date: {{date}}\n' +
  '\n' +
  '## SHIP TO\n' +
  '{{customer_name}}\n' +
  '{{customer_address_block}}\n' +
  'Email: {{customer_email}}\n' +
  'Phone: {{customer_phone}}\n' +
  '\n' +
  '## CONTENTS\n' +
  'Product Name: {{product_name}}\n' +
  'SKU: {{sku}}\n' +
  'Serial No: {{serial}}\n' +
  'Batch/Lot Number: {{batch_lot}}\n' +
  'Master Carton: {{master_carton}}\n' +
  'Quantity: {{quantity}}\n' +
  '\n' +
  '## SHIPPING\n' +
  'Carrier: {{carrier}}\n' +
  'Tracking No: {{tracking}}\n' +
  '\n' +
  'VCycene Inc. - LILA Composter\n' +
  'Questions: support@lilacomposter.com';

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
  /** The packing list as it will appear on the attached PDF, one entry per
   *  printed line — the `# `/`## ` markers already stripped. For preview. */
  packingList: string[];
  /** The same document as raw template text, markers intact. This is what the
   *  editor edits and what is sent as the override. */
  packingListText: string;
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
    // The PDF wants the address as its own lines; the email indents
    // continuation lines under "Address: " instead.
    customer_address_block: addressLines(order).join('\n'),
    date: new Date().toISOString().slice(0, 10),
    // What the 3PL should be looking for: one merged label + packing list, and
    // on a UPS booking the pesticide worksheet too.
    attachments_note: attachmentsNote(carrier),
  };
}

/** Render the booking email + packing list.
 *
 *  `template` is the operator-editable wording from the Templates tab; when it
 *  is absent (the row hasn't been migrated into this environment) the built-in
 *  default stands in, so a send is never blocked on a pending migration. */
export function buildEzTransBooking(
  args: EzTransBookingArgs & {
    template?: { subject: string; body: string } | null;
    /** The operator-editable packing list. Empty or absent falls back to the
     *  built-in default, so a send is never blocked on a pending migration. */
    packingListTemplate?: string | null;
  },
): EzTransBooking {
  const vars = ezTransVariables(args);
  const subject = renderTemplate(args.template?.subject || DEFAULT_EZTRANS_SUBJECT, vars);
  const body = renderTemplate(args.template?.body || DEFAULT_EZTRANS_BODY, vars);

  // The packing list is rendered through the same substitution as the email,
  // so an edit changes the wording while the serial, carton and tracking are
  // still whatever the order and the queue row say.
  const packingListText = renderTemplate(
    args.packingListTemplate || DEFAULT_EZTRANS_PACKING_LIST, vars);
  const packingList = packingListLines(packingListText).map(l => l.text);

  return { subject, body, packingList, packingListText };
}

/** A packing-list document as the PDF will print it: the `# `/`## ` markers
 *  stripped, nothing else changed.
 *
 *  The panel used to preview `booking.packingList`, which is built from the
 *  template — so an operator who edited the list and closed the editor was
 *  shown the stock document under the heading "Attached packing list (PDF)".
 *  The edit was reaching the 3PL; the panel was denying it. Previewing the
 *  same text that gets sent is the fix. */
export function packingListPreview(text: string): string {
  return packingListLines(text).map(l => l.text).join('\n');
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
  packingList: string;
  source: 'template' | 'built-in';
  loading: boolean;
} {
  const { template, loading } = useEmailTemplate(EZTRANS_TEMPLATE_KEY);
  const { template: packing, loading: packingLoading } = useEmailTemplate(EZTRANS_PACKING_LIST_KEY);
  const usable = template && template.active ? template : null;
  const usablePacking = packing && packing.active && packing.body ? packing : null;
  return {
    template: usable
      ? { subject: usable.subject, body: usable.body }
      : { subject: DEFAULT_EZTRANS_SUBJECT, body: DEFAULT_EZTRANS_BODY },
    packingList: usablePacking ? usablePacking.body : DEFAULT_EZTRANS_PACKING_LIST,
    source: usable ? 'template' : 'built-in',
    loading: loading || packingLoading,
  };
}

/** Send the booking confirmation, packing list and label to cs@goorooship.ca.
 *
 *  `sent_via` says which pipe carried it. 'gmail' means it went out as the From
 *  mailbox and is filed in that person's Sent folder; 'resend' means it was not,
 *  and `warning` explains why — worth showing, since the difference is whether
 *  there is any record of the send on the sender's own side.
 *
 *  `override` is what the operator typed for this one order — the subject and
 *  body, and optionally the packing list. Whatever the wording, the edge
 *  function fills every {{variable}} from the queue row, the order and the
 *  shelf row, and pulls the label straight out of storage: an edit changes
 *  what the documents say, never which shipment they describe. */
export type EzTransSendResult = {
  email_id: string;
  from?: string;
  sent_via?: 'gmail' | 'resend';
  warning?: string;
  wording?: 'edited' | 'template';
  packing_list?: 'edited' | 'template';
  /** What actually went out, by filename. */
  attachments?: string[];
  /** False when the label could not be merged and went as its own attachment. */
  combined?: boolean;
  /** 'unsigned' means the worksheet was built but the signature asset could
   *  not be read — it needs signing by hand before the broker sees it. */
  pesticide_worksheet?: 'signed' | 'unsigned' | 'not-required';
};

export async function sendEzTransBooking(
  queueId: string,
  override?: { subject: string; body: string; packing_list?: string },
): Promise<EzTransSendResult> {
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
      ...(override?.packing_list ? { packing_list: override.packing_list } : {}),
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
  try { return JSON.parse(bodyText) as EzTransSendResult; }
  catch { throw new Error('EZ Trans email: response was not JSON'); }
}
