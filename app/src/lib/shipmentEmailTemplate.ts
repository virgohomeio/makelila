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
/** The Lovely install guide, hosted on the app's own GitHub Pages origin.
 *
 *  An emailed image needs a public, permanent URL. Every Supabase storage
 *  bucket on this project is private — a signed URL expires and would leave a
 *  broken image in an inbox a week later — so the asset lives in app/public/,
 *  which Pages serves at this address for as long as the site is up.
 *
 *  A line in the body that is nothing but an image URL is rendered as an <img>
 *  in the HTML part of the email (see _shared/emailHtml.ts) and left as a
 *  working link in the text part. */
export const LOVELY_INSTALL_GUIDE_URL = 'https://lila.vip/lovely-install-guide.png';

export const SHIPMENT_EMAIL_VARIABLES = [
  'customer_first_name',
  'order_ref',
  'carrier',
  'tracking_num',
  'tracking_url',
  'starter_block',
] as const;

/** The email_templates key the queue's shipping email reads as an override.
 *
 *  Changed from 'shipment_confirmation' on 2026-11-05 when the email was cut
 *  down to shipping information only (the Lovely app and onboarding-call
 *  instructions moved to the automatic next-day email — see
 *  supabase/functions/_shared/onboardingEmail.ts). The old row still holds the
 *  long combined wording, and reading it would put the onboarding sections
 *  straight back into the shipping email. Sends are still logged to
 *  email_messages under 'shipment_confirmation' so the Fulfilled step and the
 *  customer timeline keep finding them. */
export const SHIPMENT_EMAIL_TEMPLATE_KEY = 'shipment_shipping_info';

export const SHIPMENT_EMAIL_DEFAULT: { subject: string; body: string } = {
  subject: 'Important Information For Your LILA Shipment',
  body: `Hi {{customer_first_name}},

Your LILA (order {{order_ref}}) is on its way to you. Here are your shipping details:

Carrier: {{carrier}}

Tracking Number: {{tracking_num}}

Tracking Link: {{tracking_url}}
{{starter_block}}
You can use the link above to check on your delivery progress at any time.

IMPORTANT: A signature is required on delivery. Please make sure someone is available to sign for the package when it arrives. If no one is there to sign, the carrier will not leave it and will attempt redelivery or hold it for pickup.

Tomorrow we'll send you a second email with the steps you'll need to complete to get your LILA set up.

Questions about your delivery? Just reply to this email and we'll help.

Happy Composting! 🌱
-The VCycene Team`,
};

/** The Quo (OpenPhone) text that goes out with the shipping email — the same
 *  information, condensed. Same {{variables}} as the email. */
export const SHIPMENT_SMS_DEFAULT = `Hi {{customer_first_name}}, your LILA (order {{order_ref}}) has shipped via {{carrier}}. Tracking #: {{tracking_num}} — {{tracking_url}}
A signature is required on delivery, so please make sure someone is available to sign for the package. Full details are in your email. - The VCycene Team`;

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
