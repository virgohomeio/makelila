// Pure helpers for the Sales-tab customer communication indicator: deciding
// which of a customer's support messages to read, hashing them so an unchanged
// conversation costs nothing to re-check, validating what the model says back,
// and wording the result.
//
// MIRROR LOCATION: supabase/functions/_shared/commAssessment.ts (kept
// byte-identical; app/scripts/check-classifier-drift.mjs enforces).
//
// Zero imports — pure TS — so Deno (the assess-order-communication edge
// function) and Node (Vitest) consume the same file, and the wording an
// operator reads is the wording the tests assert.
//
// Spec: docs/superpowers/specs/2026-09-10-order-communication-indicator-design.md

// ============================================================ Vocabulary

export type CommChannel = 'quo' | 'email';

/** 'no_contact' is deliberately not folded into 'clear'. Both are safe to ship,
 *  but only one of them means a person actually said so — and when a shipment
 *  goes wrong, which of the two it was is the first question asked. */
export type CommVerdict = 'clear' | 'unclear' | 'no_contact';

export type CommConcern =
  | 'cancel_intent'
  | 'refund_request'
  | 'hesitation'
  | 'address_change'
  | 'contact_change'
  | 'delivery_timing'
  | 'unresolved_complaint'
  | 'payment_issue'
  | 'other';

/** Fixed vocabulary. The model is told to pick from exactly this list and
 *  anything else it invents is dropped — see parseAssessment. */
export const CONCERN_LABELS: Record<CommConcern, string> = {
  cancel_intent:        'Wants to cancel',
  refund_request:       'Asked for a refund',
  hesitation:           'Having second thoughts',
  address_change:       'Address may have changed',
  contact_change:       'Contact details may have changed',
  delivery_timing:      'Asked us to delay or re-time delivery',
  unresolved_complaint: 'Unresolved complaint',
  payment_issue:        'Payment problem',
  other:                'Needs a look',
};

export const COMM_CONCERNS = Object.keys(CONCERN_LABELS) as CommConcern[];

// ============================================================ Shapes

export type CommMessage = {
  id: string;
  ticket_id: string | null;
  channel: CommChannel;
  direction: 'inbound' | 'outbound';
  sent_at: string;
  text: string;
};

export type CommEvidence = {
  channel: CommChannel;
  direction: 'inbound' | 'outbound';
  sent_at: string | null;
  excerpt: string;
  ticket_id?: string | null;
};

export type ChannelStatus = {
  /** False means we never read this channel at all — not that it was silent. */
  connected: boolean;
  last_synced_at: string | null;
  message_count: number;
};

export type ChannelsScanned = { quo: ChannelStatus; email: ChannelStatus };

export type AssessmentCore = {
  verdict: CommVerdict;
  headline: string;
  concerns: CommConcern[];
  evidence: CommEvidence[];
};

// ============================================================ Identity keys
//
// An order and a support ticket are joined on the person, and the person is
// identified by whichever of email/phone both sides happen to hold.

/** Last ten digits, which is what makes a North-American number comparable
 *  across the +1 / (416) / 416- forms the three sources each prefer. Shorter
 *  than ten identifies nobody, so it is rejected rather than matched loosely —
 *  a false join here attributes a stranger's "cancel my order" to this order. */
export function phoneKey(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

export function emailKey(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim().toLowerCase();
  return trimmed.includes('@') ? trimmed : null;
}

// ============================================================ Who is "us"
//
// VCycene replies to customers from two domains: virgohome.io (Google
// Workspace) and lilacomposter.com (Microsoft 365). Both appear as senders in
// the same thread — a customer writes to support@lilacomposter.com and
// reina@virgohome.io answers.

export const DEFAULT_INTERNAL_DOMAINS = ['virgohome.io', 'lilacomposter.com'];

/** True when a message came from the team rather than the customer.
 *
 *  This is the single most consequential field in the whole indicator: it is
 *  what separates "the customer asked for a refund" from "we offered a
 *  refund". Get it wrong and the model reads support's own words back as the
 *  customer's, which turns routine helpfulness into a shipping block. A
 *  one-domain test silently mislabels every reply sent from the other
 *  domain, so the check takes the full list. */
export function isInternalSender(
  senderEmail: string | null | undefined,
  opts: { domains?: string[]; mailbox?: string | null } = {},
): boolean {
  const email = (senderEmail ?? '').trim().toLowerCase();
  if (!email) return false;
  const mailbox = (opts.mailbox ?? '').trim().toLowerCase();
  if (mailbox && email === mailbox) return true;
  const domains = opts.domains ?? DEFAULT_INTERNAL_DOMAINS;
  return domains
    .map(d => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean)
    .some(d => email.endsWith(`@${d}`));
}

// ============================================================ Message selection

/** The newest `max` messages inside `windowDays`, returned oldest-first.
 *
 *  Oldest-first because a transcript should read forwards: "I want to cancel"
 *  followed by "actually, please still send it" means something different in
 *  the other order, and the model only gets it right if the order is real. */
export function selectMessages(
  all: CommMessage[],
  opts: { now: Date; windowDays: number; max: number },
): CommMessage[] {
  const floor = opts.now.getTime() - opts.windowDays * 24 * 60 * 60 * 1000;
  return all
    .filter(m => m.text && m.text.trim().length > 0)
    .filter(m => {
      const t = Date.parse(m.sent_at);
      return Number.isFinite(t) && t >= floor;
    })
    .sort((a, b) => a.sent_at.localeCompare(b.sent_at))
    .slice(-opts.max);
}

// ============================================================ Fingerprinting

/** The canonical string identifying "this conversation, as of now". Sorted by
 *  id so re-fetching in a different order is not mistaken for new activity;
 *  the order status is folded in so re-opening a cancelled order re-reads it. */
export function fingerprintSource(msgs: CommMessage[], orderStatus: string): string {
  const ids = msgs.map(m => m.id).sort();
  return `${orderStatus}|${ids.join(',')}`;
}

/** Web Crypto is present in Deno, Node 18+ and jsdom alike, so the mirror
 *  needs no per-runtime branch. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================ Prompting

export function buildTranscript(msgs: CommMessage[]): string {
  return msgs
    .map(m => {
      const who = m.direction === 'inbound' ? 'CUSTOMER' : 'SUPPORT';
      const when = m.sent_at.slice(0, 10);
      const via = m.channel === 'quo' ? 'SMS' : 'email';
      return `[${when} · ${via} · ${who}] ${m.text.trim().replace(/\s+/g, ' ').slice(0, 1200)}`;
    })
    .join('\n');
}

export const ASSESSMENT_SYSTEM_PROMPT = [
  'You screen customer support history for a composter manufacturer before a unit is shipped.',
  'One question only: does anything here mean we should NOT put this order on a truck today?',
  '',
  'Answer "unclear" when the customer has asked to cancel, asked for a refund, said they',
  'changed their mind or sound hesitant, mentioned moving or a different address, reported an',
  'unresolved problem that a new shipment would make worse, asked us to delay delivery, or',
  'raised a payment problem.',
  '',
  'Answer "clear" when there is contact but none of it bears on shipping — troubleshooting an',
  'existing machine, a delivery-status question, a compliment, general questions. A customer',
  'chasing us to ship SOONER is "clear".',
  '',
  'Be literal. Do not infer doubt from a support agent apologising, and do not infer',
  'enthusiasm from politeness. If the customer explicitly retracts an earlier concern, the',
  'retraction wins — read the transcript in order.',
  '',
  'Reply with JSON only, no prose, no code fence:',
  '{"verdict":"clear"|"unclear",',
  ' "headline":"one sentence, max 110 chars, plain language, naming the specific issue when unclear",',
  ` "concerns":[${COMM_CONCERNS.map(c => `"${c}"`).join(',')}],`,
  ' "evidence":[{"channel":"quo"|"email","direction":"inbound"|"outbound","sent_at":"ISO date","excerpt":"<=200 chars quoted from the transcript"}]}',
  '',
  'concerns is [] when the verdict is clear. evidence holds at most 3 entries, quoted verbatim,',
  'and must be empty when the verdict is clear.',
].join('\n');

// ============================================================ Model reply validation

const MAX_HEADLINE = 140;
const MAX_EXCERPT = 240;
const MAX_EVIDENCE = 3;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Validates and clamps whatever the model returned.
 *
 *  An unreadable answer resolves to 'unclear', never to 'clear': the cost of a
 *  spurious "confirm with the customer" is one message, and the cost of a
 *  spurious "clear to ship" is a machine on a truck to someone who cancelled. */
export function parseAssessment(raw: unknown): AssessmentCore {
  const obj = asRecord(raw);

  const rawVerdict = asString(obj.verdict).toLowerCase();
  const verdict: CommVerdict =
    rawVerdict === 'clear' ? 'clear'
    : rawVerdict === 'no_contact' ? 'no_contact'
    : 'unclear';

  const concerns = Array.isArray(obj.concerns)
    ? [...new Set(
        obj.concerns
          .map(c => asString(c).toLowerCase())
          .filter((c): c is CommConcern => (COMM_CONCERNS as string[]).includes(c)),
      )]
    : [];

  const evidence: CommEvidence[] = (Array.isArray(obj.evidence) ? obj.evidence : [])
    .map(e => asRecord(e))
    .map(e => ({
      channel: (asString(e.channel) === 'email' ? 'email' : 'quo') as CommChannel,
      direction: (asString(e.direction) === 'outbound' ? 'outbound' : 'inbound') as 'inbound' | 'outbound',
      sent_at: asString(e.sent_at) || null,
      excerpt: asString(e.excerpt).slice(0, MAX_EXCERPT),
      ticket_id: asString(e.ticket_id) || null,
    }))
    .filter(e => e.excerpt.length > 0)
    .slice(0, MAX_EVIDENCE);

  const headline = asString(obj.headline).slice(0, MAX_HEADLINE) || defaultHeadline(verdict, concerns);

  return { verdict, headline, concerns: verdict === 'clear' ? [] : concerns, evidence };
}

/** The wording used when the model gives a verdict but no sentence, and by the
 *  no-contact short circuit. Kept here so the phrasing an operator reads lives
 *  in one place. */
export function defaultHeadline(verdict: CommVerdict, concerns: CommConcern[]): string {
  if (verdict === 'no_contact') return 'Clear to ship — no support contact on file';
  if (verdict === 'clear') return 'Clear to ship — nothing in recent contact affects this shipment';
  const named = concerns.filter(c => c !== 'other').map(c => CONCERN_LABELS[c].toLowerCase());
  return named.length
    ? `Communication unclear (${named.join('; ')}) — confirm the desire to ship`
    : 'Communication unclear — confirm the desire to ship with the customer';
}

export function noContactAssessment(): AssessmentCore {
  return { verdict: 'no_contact', headline: defaultHeadline('no_contact', []), concerns: [], evidence: [] };
}

// ============================================================ Presentation

/** The fixed phrase that leads the box, per verdict.
 *
 *  The model writes a specific sentence and that sentence is the useful part,
 *  but it phrases the same conclusion a dozen ways ("No shipping obstacles
 *  identified", "Routine post-delivery check-in", …). An operator scanning a
 *  queue needs the verdict itself to read identically every time, so the fixed
 *  label leads and the model's sentence follows as detail. */
export const VERDICT_LABEL: Record<CommVerdict, string> = {
  clear:      'Clear to ship',
  no_contact: 'Clear to ship',
  unclear:    'Communication unclear — confirm the desire to ship',
};

/** The model's own sentence, or null when it would only restate the label.
 *  Suppresses the double-up when the stored headline is the generated default
 *  rather than something a model actually wrote. */
export function commDetail(
  verdict: CommVerdict | null | undefined,
  headline: string | null | undefined,
): string | null {
  if (!verdict) return null;
  const text = (headline ?? '').trim();
  if (!text) return verdict === 'no_contact' ? 'No support contact on file' : null;
  if (text === defaultHeadline(verdict, [])) {
    return verdict === 'no_contact'
      ? 'No support contact on file'
      : verdict === 'clear'
        ? 'Nothing in recent contact affects this shipment'
        : null;
  }
  // A model sentence that already opens with the label adds nothing twice.
  const label = VERDICT_LABEL[verdict].toLowerCase();
  if (text.toLowerCase().startsWith(label.split(' — ')[0])) {
    const rest = text.slice(label.split(' — ')[0].length).replace(/^[\s—:,.-]+/, '');
    return rest || null;
  }
  return text;
}

export type CommTone = 'good' | 'warn' | 'unknown';

export function commTone(verdict: CommVerdict | null | undefined): CommTone {
  if (verdict === 'clear' || verdict === 'no_contact') return 'good';
  if (verdict === 'unclear') return 'warn';
  return 'unknown';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 9" in UTC. Deliberately not toLocaleDateString: the assertion in the
 *  test suite and the string on an operator's screen should not depend on the
 *  machine's locale. */
export function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Names every channel and, crucially, says outright when one was not read.
 *
 *  Support email has never been connected in production (the Gmail sync is
 *  cron'd but its service-account secrets are unset), so without this line a
 *  "Clear to ship" built from SMS alone would read as a full all-channels
 *  clearance. It is not one, and the box has to say so. */
export function channelFootnote(channels: ChannelsScanned | null | undefined): string {
  if (!channels) return 'Scanned: nothing yet';
  const parts: string[] = [];
  for (const [key, label] of [['quo', 'Quo'], ['email', 'Support email']] as const) {
    const status = channels[key];
    if (!status || !status.connected) {
      parts.push(`${label} not connected`);
      continue;
    }
    const on = shortDate(status.last_synced_at);
    parts.push(on ? `${label} (to ${on})` : label);
  }
  return `Scanned: ${parts.join(' · ')}`;
}
