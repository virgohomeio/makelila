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
