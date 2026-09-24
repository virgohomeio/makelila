/** The shipment-confirmation email the Fulfillment queue sends at Step 5.
 *
 *  The wording lives here, in code, rather than only in the database. The
 *  'shipment_confirmation' row in email_templates is treated as an OVERRIDE:
 *  used when it is renderable, ignored when it is not. That inversion is
 *  deliberate — migrations on this project are gated behind a manual workflow,
 *  so a body that only exists in a migration is a body that may never ship. A
 *  stale row previously left a literal {{calendly_url}} in the draft because
 *  the row declared a variable the renderer no longer supplies.
 *
 *  Operators can still edit the text: per send in Step 5, or permanently with
 *  "Save as default", which writes the stored row that then takes over. */

/** Every placeholder the Step-5 renderer knows how to fill. A stored template
 *  that reaches for anything outside this set cannot be rendered correctly, so
 *  it is rejected in favour of the default below. */
export const SHIPMENT_EMAIL_VARIABLES = [
  'customer_first_name',
  'order_ref',
  'carrier',
  'tracking_num',
  'tracking_url',
  'starter_block',
] as const;

export const SHIPMENT_EMAIL_DEFAULT: { subject: string; body: string } = {
  subject: 'Your LILA has officially shipped! 🎉 ({{order_ref}})',
  body: `Hi {{customer_first_name}},

Your LILA has officially shipped! 🎉 It's on its way to you. Here are your shipping details:

Carrier: {{carrier}}

Tracking Number: {{tracking_num}}

Tracking Link: {{tracking_url}}
{{starter_block}}
You can use the link above to check on your delivery progress at any time.

Important next steps

1. Mandatory onboarding session
Once your unit arrives, you'll need to book a mandatory onboarding session before using LILA. This session is required to ensure your first batches produce high-quality compost, avoid common mistakes, and help you get the best results from day one.

Book a weekday session (business hours):
https://calendly.com/lila-ed/intro-call

Evenings or weekends work better? Book here:
https://calendly.com/lila-ed/lila-onboarding-with-danica-patrik

2. Please keep the original box
Please do not throw out the original packaging for the first 30 days after delivery. In the rare event of shipping damage or if a return is required during our 30-day refund period, the unit must be returned in its original box.

Thank you again for being part of the LILA community and supporting our mission to make composting effortless and sustainable. We can't wait to see the difference your LILA will make in your home.

Happy Composting! 🌱
-The VCycene Team`,
};

/** Placeholders a stored template uses that the renderer cannot fill.
 *  Empty means the template is safe to render. */
export function unsupportedVariables(template: { subject: string; body: string }): string[] {
  const known = new Set<string>(SHIPMENT_EMAIL_VARIABLES);
  const found = new Set<string>();
  for (const text of [template.subject, template.body]) {
    for (const m of text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
      if (!known.has(m[1])) found.add(m[1]);
    }
  }
  return [...found];
}
