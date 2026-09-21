// The EZ Trans booking email, as a template.
//
// Three things can supply the wording, in this order:
//   1. what the operator typed into the step-3 panel for this one order
//   2. the `eztrans_booking` row in email_templates (Templates tab)
//   3. the built-in default below
//
// (3) exists because migrations are applied by hand in this repo: the template
// row may not be in a given environment yet, and a 3PL confirmation that can't
// be sent until someone runs a workflow is worse than one with stock wording.
//
// These strings are duplicated in app/src/lib/eztrans.ts so the panel can show
// a preview without a round-trip. eztransTemplate.test.ts asserts the two
// copies are byte-identical, so drift fails the build rather than the 3PL.

export const EZTRANS_TEMPLATE_KEY = 'eztrans_booking';

/** email_templates.key for the packing-list document (Templates tab). */
export const EZTRANS_PACKING_LIST_KEY = 'eztrans_packing_list';

/** Who the booking confirmation comes from, and who is copied on it.
 *
 *  Overridable per-environment with EZTRANS_FROM / EZTRANS_CC on the edge
 *  function, so the address can be moved without a deploy. Note the sending
 *  domain has to be verified in Resend or the API rejects the send outright. */
export const EZTRANS_FROM_DEFAULT = 'VCycene Fulfillment <reina@virgohome.io>';
export const EZTRANS_CC_DEFAULT = ['reina@virgohome.io', 'huayi@virgohome.io'];

/** Sender of last resort, on the domain that has been verified in Resend since
 *  this app started sending mail.
 *
 *  Resend refuses a From on an unverified domain outright, so if virgohome.io
 *  has not had its SPF + DKIM records added yet, the booking confirmation would
 *  simply never reach the 3PL. Rather than let that stop a shipment, the send
 *  is retried from here with the intended address as Reply-To — and the caller
 *  is told, loudly, that it happened. Once virgohome.io is verified this path
 *  stops being taken on its own, with no code change. */
export const EZTRANS_FROM_FALLBACK = 'VCycene Team <support@lilacomposter.com>';

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

/** The packing list, as an operator-editable template.
 *
 *  This document is what EZ Trans prints and tapes to the box, so it was
 *  built in code and deliberately un-editable for a while. It is a template
 *  now because operators need to add a one-off handling note or correct a
 *  carton line without waiting on a deploy — but the variables below are
 *  still filled from the order and the queue row on the server, so an edit
 *  changes the wording, not the shipment's identity.
 *
 *  Two line markers, because guessing is worse: `# ` is the document title
 *  and `## ` a section heading. Everything else is a body line, and a blank
 *  line becomes space under the line above. An all-caps value line like
 *  "SKU: LILA-P100X" is therefore never mistaken for a heading. */
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

/** Variables the packing-list template may use. A superset of the email's:
 *  the PDF wants the address as its own lines, and carries a date. */
export const EZTRANS_PACKING_LIST_VARIABLES = [
  'customer_name', 'customer_address_block', 'customer_email', 'customer_phone',
  'product_name', 'sku', 'serial', 'batch_lot', 'master_carton', 'quantity',
  'carrier', 'tracking', 'order_ref', 'date',
] as const;

/** Structurally a PdfLine from _shared/simplePdf.ts, redeclared here so this
 *  module stays importable from the app's test suite without dragging the PDF
 *  writer along. */
export type PackingListLine = { text: string; size?: number; bold?: boolean; gap?: number };

/** Turn a rendered packing-list template into the lines the PDF writer takes.
 *
 *  A blank line is applied as a gap under the previous line rather than
 *  emitted as an empty row, so trailing or doubled blanks can't push the
 *  document down the page. */
export function packingListLines(rendered: string): PackingListLine[] {
  const out: PackingListLine[] = [];
  for (const raw of rendered.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      if (out.length) out[out.length - 1].gap = (out[out.length - 1].gap ?? 0) + 10;
      continue;
    }
    if (line.startsWith('## ')) {
      out.push({ text: line.slice(3).trim(), size: 11, bold: true, gap: 2 });
    } else if (line.startsWith('# ')) {
      out.push({ text: line.slice(2).trim(), size: 18, bold: true, gap: 4 });
    } else {
      out.push({ text: line, size: 10 });
    }
  }
  return out;
}

/** Every variable the template may use. Also what the Templates tab lists as
 *  available, so an operator editing the copy can see what they can reach for. */
export const EZTRANS_TEMPLATE_VARIABLES = [
  'customer_name', 'customer_address', 'customer_email', 'customer_phone',
  'product_name', 'sku', 'serial', 'batch_lot', 'master_carton', 'quantity',
  'carrier', 'tracking', 'order_ref',
] as const;

/** Same substitution rule as lib/templates.ts renderTemplate: an unknown or
 *  empty variable is left standing as `{{name}}` rather than silently becoming
 *  a blank, so a typo in the template is visible instead of invisible. */
export function renderEzTransTemplate(
  template: string,
  vars: Record<string, string | undefined>,
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined || v === null || v === '') return `{{${name}}}`;
    return String(v);
  });
}
