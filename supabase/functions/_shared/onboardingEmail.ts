// The "ACTION NEEDED" onboarding email and its Quo text, sent automatically one
// day after the shipping email (send-onboarding-instructions, on a cron).
//
// Until 2026-11-05 these instructions rode inside the shipment-confirmation
// email itself. They were split out so the shipping email carries only
// shipping, tracking and the signature requirement, and the setup steps
// arrive on their own a day later where they are harder to miss.
//
// The wording lives in code rather than only in email_templates for the same
// reason as app/src/lib/shipmentEmailTemplate.ts: migrations are applied by
// hand, and a body that exists only in a migration may never ship. An active
// 'onboarding_instructions' row in email_templates overrides it when every
// placeholder in it can be filled.

export const ONBOARDING_TEMPLATE_KEY = 'onboarding_instructions';

export const ONBOARDING_EMAIL_VARIABLES = ['customer_first_name', 'order_ref'] as const;

/** Rendered as an <img> by textToEmailHtml when it sits alone on a line. */
export const LOVELY_INSTALL_GUIDE_URL = 'https://lila.vip/lovely-install-guide.png';

export const ONBOARDING_EMAIL_DEFAULT: { subject: string; body: string } = {
  subject: 'ACTION NEEDED: Onboarding Instructions for your LILA',
  body: `Hi {{customer_first_name}},

Your LILA is on its way! Before you start using it, there are two mandatory steps you'll need to complete.

STEP 1 (MANDATORY): Sign in to the Lovely App to activate your warranty

Signing in to the Lovely app is mandatory to activate your LILA's warranty. Please create your account and sign in as soon as your LILA arrives.

Lovely is LILA's companion app, and you'll need it to get started. It walks you through setup step by step, lets you check on and control your LILA from your phone, and sends you alerts when your LILA needs attention.

Lovely isn't in the App Store or Google Play. You add it to your phone straight from your browser, which takes under a minute:

iPhone
1. Open lilalovely.io in Safari.
2. Tap the Share button at the bottom of the screen.
3. Scroll down, tap Add to Home Screen, then tap Add.

Android
1. Open lilalovely.io in Chrome.
2. Tap the ⋮ menu in the top right corner.
3. Tap Add to Home screen (or Install app), then confirm.

${LOVELY_INSTALL_GUIDE_URL}

Once it's added, always open Lovely from the ladybug icon on your home screen rather than from your browser, and tap Allow when it asks to send notifications. That way you won't miss any alerts from your LILA.

IMPORTANT: Before you use your LILA for the first time, open Lovely and follow all of the onboarding steps in the app. Please don't start using your LILA until you've completed them.

STEP 2 (MANDATORY): Book your onboarding call

Once your unit arrives, you'll need to book a mandatory onboarding session before using LILA. This session is required to ensure your first batches produce high-quality compost, avoid common mistakes, and help you get the best results from day one.

IMPORTANT: Please book your onboarding session only AFTER you have successfully completed all of the onboarding steps in the Lovely app. Your session is built around a LILA that is already set up and connected, so if the in-app steps aren't finished yet, we may need to reschedule.

Book a weekday session (business hours):
https://calendly.com/lila-ed/intro-call

Evenings or weekends work better? Book here:
https://calendly.com/lila-ed/lila-onboarding-with-danica-patrik

Questions or trouble installing? Just reply to this email and we'll help.

Happy Composting! 🌱
-The VCycene Team`,
};

/** The Quo text sent alongside the onboarding email — the same two steps,
 *  condensed. */
export const ONBOARDING_SMS_DEFAULT = `Hi {{customer_first_name}}, ACTION NEEDED for your LILA (order {{order_ref}}) — 2 mandatory steps:
1) Sign in to the Lovely App to activate your warranty: open lilalovely.io on your phone and add it to your home screen, then complete all the in-app onboarding steps before using LILA.
2) After the in-app steps are done, book your mandatory onboarding call: https://calendly.com/lila-ed/intro-call (weekdays) or https://calendly.com/lila-ed/lila-onboarding-with-danica-patrik (evenings/weekends).
Full instructions are in your email. - The VCycene Team`;

/** `{{name}}` → value. A missing value is left visible as `{{name}}`. */
export function renderPlaceholders(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => {
    const v = vars[name];
    return v === undefined || v === null || v === '' ? match : String(v);
  });
}

/** Placeholders the onboarding renderer cannot fill. */
export function unfilledPlaceholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(m => m[1]))];
}
