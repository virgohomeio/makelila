// Backlog #72 — canonical place for canned SMS bodies + verified URLs.
//
// Why this file exists: we shipped a Trustpilot review-request SMS with a
// guessed URL (trustpilot.com/lila → 404). To stop guessing, the canonical
// URL lives here as a const, and any operator-triggered canned SMS pulls
// its body from CANNED_SMS_TEMPLATES below.
//
// Where else canned SMS bodies live:
//   • lib/dashboard.ts — STATUS_SMS_TEMPLATES are *status-keyed* (wellness
//     / lid) and tightly coupled to the device-telemetry flow. They stay
//     there because the dashboard is the only caller.
//   • Supabase email_templates table — formal email templates managed via
//     the Templates module. Could absorb canned SMS later, but the table
//     is email-shaped (subject column etc.) and operators want quick
//     JS-side edits without a DB round-trip for these short messages.
//
// When adding a new canned SMS, add it here and surface a picker in the
// UI that calls into it. Don't paste raw bodies into modules.

export const TRUSTPILOT_REVIEW_URL = 'https://www.trustpilot.com/review/lilacomposter.com';

export type CannedSmsKey = 'trustpilot_review_request' | 'compost_drying_tip' | 'phone_verification';

export const CANNED_SMS_TEMPLATES: Record<CannedSmsKey, {
  label: string;
  description: string;
  body: (firstName: string) => string;
}> = {
  trustpilot_review_request: {
    label: 'Trustpilot review request',
    description: 'Ask a happy customer to leave a 5-star review.',
    body: (n) => `Hi ${n} — so glad your LILA is treating you well! If you have a minute, we'd love a quick 5-star review on Trustpilot — it helps other folks find us: ${TRUSTPILOT_REVIEW_URL}. Thanks!`,
  },
  compost_drying_tip: {
    label: 'Compost too dry — add water',
    description: 'Standard tip when DRY_SOIL flag is confirmed accurate.',
    body: (n) => `Hi ${n} — based on your latest data the compost looks a bit dry, which can stall the microbes. Try adding 1–2 cups of water mixed in over the top, then close the lid and let it run. Reply if you'd like more troubleshooting!`,
  },
  phone_verification: {
    label: 'Phone number verification',
    description: 'Ask customer to confirm the cell number on file when SMS is bouncing.',
    body: (n) => `Hi ${n} — this is LILA Composter support. We've been trying to reach you with a quick check-in but the SMS isn't going through. Could you confirm this is still the best mobile number for you? Thanks!`,
  },
};

export const CANNED_SMS_OPTIONS: { key: CannedSmsKey; label: string; description: string }[] =
  (Object.entries(CANNED_SMS_TEMPLATES) as [CannedSmsKey, typeof CANNED_SMS_TEMPLATES[CannedSmsKey]][])
    .map(([key, t]) => ({ key, label: t.label, description: t.description }));
