// Gmail ticket classifier — rules-first deterministic module.
//
// MIRROR LOCATION: app/src/lib/classifier.ts (kept byte-identical;
// app/scripts/check-classifier-drift.mjs enforces).
//
// Zero imports — pure TS — so the same file works in Deno (edge function) and
// Node (Vitest). LLM fallback will live elsewhere (PR3) so this module stays
// dependency-free.

// ============================================================ Types

export type Priority = 'urgent' | 'high' | 'medium' | 'low';

export type Category =
  | 'return_hardware_defect'
  | 'warranty_replacement'
  | 'refund'
  | 'software_firmware'
  | 'complaint'
  | 'callback'
  | 'assembly_support'
  | 'troubleshooting'
  | 'logistics_pickup'
  | 'order_fulfillment'
  | 'in_person_service'
  | 'appointment'
  | 'marketing_social'
  | 'closed_acknowledgment'
  | 'other';

// Subset of statuses the classifier may suggest. 'closed' is the only
// auto-status; everything else is left to staff progression.
export type SuggestedStatus = 'closed';

export type ThreadMessage = {
  direction: 'inbound' | 'outbound';
  sent_at: string;          // ISO 8601
  body_text: string;
  snippet?: string;
};

export type ThreadInput = {
  subject: string;
  customer_name?: string | null;
  messages: ThreadMessage[]; // chronological, oldest first
  now?: number;             // for tests; defaults to Date.now()
};

export type ClassificationResult = {
  priority: Priority;
  category: Category;
  subject: string;
  summary: string;
  suggested_next_action: string;
  status?: SuggestedStatus;
  method: 'rules' | 'llm';
  ruleId?: string;
};

// ============================================================ Display labels

export const CATEGORY_LABEL: Record<Category, string> = {
  return_hardware_defect: 'Return / hardware defect',
  warranty_replacement:   'Warranty replacement',
  refund:                 'Refund',
  software_firmware:      'Software / firmware',
  complaint:              'Complaint',
  callback:               'Callback',
  assembly_support:       'Assembly support',
  troubleshooting:        'Troubleshooting',
  logistics_pickup:       'Logistics / pickup',
  order_fulfillment:      'Order fulfillment',
  in_person_service:      'In-person service',
  appointment:            'Appointment',
  marketing_social:       'Marketing / social',
  closed_acknowledgment:  'Acknowledgment',
  other:                  'Other',
};

const NEXT_ACTION: Record<Category, string> = {
  return_hardware_defect: 'Call the customer and coordinate a return or replacement.',
  warranty_replacement:   'Confirm warranty status and ship a replacement part.',
  refund:                 'Review the refund with finance and reply with timeline.',
  software_firmware:      'Walk the customer through reset/reconnect; escalate if recurring.',
  complaint:              'Call the customer to acknowledge and de-escalate.',
  callback:               'Return the missed call within the same business day.',
  assembly_support:       'Send the setup guide; offer a 15-min screen-share if blocked.',
  troubleshooting:        'Ask for unit serial and a photo/video; suggest standard fixes.',
  logistics_pickup:       'Coordinate pickup window with the carrier.',
  order_fulfillment:      'Check fulfillment queue status and provide an update.',
  in_person_service:      'Schedule a technician visit window.',
  appointment:            "Confirm the appointment on the customer's calendar.",
  marketing_social:       'Hand off to marketing or reply with the brand voice.',
  closed_acknowledgment:  'No action — thread can be closed.',
  other:                  'Triage manually and assign an owner.',
};

// ============================================================ Rule engine

type RuleInput = {
  thread: ThreadInput;
  body: string;                       // concatenated inbound bodies, lowercased
  lastMessage: ThreadMessage | null;
  lastInbound: ThreadMessage | null;
  lastOutbound: ThreadMessage | null;
  inboundCount: number;
  outboundCount: number;
  hoursSinceLastInbound: number;      // 0 if no inbound
  hoursSinceFirstMessage: number;
};

type RuleOutput = {
  priority: Priority;
  category: Category;
  status?: SuggestedStatus;
};

type Rule = {
  id: string;
  match: (input: RuleInput) => RuleOutput | null;
};

// Order matters: first match wins.
const RULES: Rule[] = [
  // 1. closed-ack — short thanks/ok with optional emoji. Auto-resolves.
  //    Placed first so a single-token "thanks" doesn't trip escalation rules.
  {
    id: 'closed-ack',
    match: ({ lastInbound, lastMessage }) => {
      if (!lastInbound || lastMessage !== lastInbound) return null;
      const txt = (lastInbound.body_text || '').trim();
      if (!txt || txt.length > 40) return null;
      const pat = /^(thanks?|thank you|thx|ty|ok(ay)?|k|cool|got it|sounds good|appreciate(d)? it|perfect|will do|noted)[\s!?.,]*[\u{1F642}\u{1F60A}\u{1F44D}❤\u{1F970}]*\s*$/iu;
      if (!pat.test(txt)) return null;
      return { priority: 'low', category: 'closed_acknowledgment', status: 'closed' };
    },
  },

  // 2. warranty-crack — physical crack on a body part.
  {
    id: 'warranty-crack',
    match: ({ body }) => {
      if (!/\bcrack(ed|ing|s)?\b/i.test(body)) return null;
      if (!/(bin|chamber|unit|composter|lid|door|drawer|housing|enclosure)/i.test(body)) return null;
      return { priority: 'high', category: 'warranty_replacement' };
    },
  },

  // 3. return-hardware-multi-issue — ≥3 inbound messages over >1 day with
  //    hardware-issue keywords AND frustration tone. Catches escalating
  //    return situations before they age into urgent silence.
  {
    id: 'return-hardware-multi-issue',
    match: ({ body, inboundCount, hoursSinceFirstMessage }) => {
      if (inboundCount < 3) return null;
      if (hoursSinceFirstMessage < 24) return null;
      const hwIssue = /(smell|odor|stink|crack|leak|broken|not working|won['’]?t|disconnect|part\s*\d|stopped|error|fault)/i;
      const tone = /(sorry|nightmare|confused|frustrat|why is this|please keep me updated|so long|nightmare|disappointed)/i;
      if (!hwIssue.test(body) || !tone.test(body)) return null;
      return { priority: 'urgent', category: 'return_hardware_defect' };
    },
  },

  // 4. refund — any mention of refund is high.
  {
    id: 'refund-mention',
    match: ({ body }) => {
      if (!/\brefund(s|ed|ing)?\b/i.test(body)) return null;
      return { priority: 'high', category: 'refund' };
    },
  },

  // 5. firmware-disconnect — connectivity / module / firmware issues.
  {
    id: 'firmware-disconnect',
    match: ({ body }) => {
      if (!/(part\s*\d|module|firmware|update fail|won['’]?t connect|won['’]?t pair|disconnect|offline|no wifi|wi-?fi)/i.test(body)) return null;
      return { priority: 'high', category: 'software_firmware' };
    },
  },

  // 6. missed-call — Quo forwards missed calls.
  {
    id: 'missed-call',
    match: ({ thread }) => {
      if (!/^missed call/i.test(thread.subject || '')) return null;
      return { priority: 'medium', category: 'callback' };
    },
  },

  // 7. escalation-no-reply — inbound aged >24h with zero outbound.
  {
    id: 'escalation-no-reply',
    match: ({ lastInbound, lastMessage, outboundCount, hoursSinceLastInbound }) => {
      if (!lastInbound || lastMessage !== lastInbound) return null;
      if (outboundCount > 0) return null;
      if (hoursSinceLastInbound < 24) return null;
      return { priority: 'urgent', category: 'complaint' };
    },
  },

  // 8. appointment-scheduled — customer confirmed an outbound proposal.
  {
    id: 'appointment-scheduled',
    match: ({ body, lastOutbound, lastMessage }) => {
      if (!lastOutbound) return null;
      if (lastMessage?.direction !== 'inbound') return null;
      if (!/(see you|sounds good|booked|scheduled|tomorrow at|works for me|let['’]s do)/i.test(body)) return null;
      return { priority: 'low', category: 'appointment' };
    },
  },

  // 9. complaint-emotional — catches strong negative tone without a more
  //    specific category fitting.
  {
    id: 'complaint-emotional',
    match: ({ body }) => {
      if (!/(nightmare|terrible|horrible|awful|disappointed|unhappy|never again|piece of (junk|crap))/i.test(body)) return null;
      return { priority: 'high', category: 'complaint' };
    },
  },
];

// ============================================================ classify()

export function classify(thread: ThreadInput): ClassificationResult {
  const messages = (thread.messages ?? []).slice();
  const inbound = messages.filter(m => m.direction === 'inbound');
  const outbound = messages.filter(m => m.direction === 'outbound');
  const lastMessage = messages[messages.length - 1] ?? null;
  const lastInbound = inbound[inbound.length - 1] ?? null;
  const lastOutbound = outbound[outbound.length - 1] ?? null;
  const body = inbound.map(m => m.body_text ?? '').join('\n').toLowerCase();
  const now = thread.now ?? Date.now();
  const hoursSinceLastInbound = lastInbound
    ? Math.max(0, (now - Date.parse(lastInbound.sent_at)) / 3_600_000) : 0;
  const hoursSinceFirstMessage = messages[0]
    ? Math.max(0, (now - Date.parse(messages[0].sent_at)) / 3_600_000) : 0;

  const input: RuleInput = {
    thread, body, lastMessage, lastInbound, lastOutbound,
    inboundCount: inbound.length, outboundCount: outbound.length,
    hoursSinceLastInbound, hoursSinceFirstMessage,
  };

  for (const rule of RULES) {
    const out = rule.match(input);
    if (out) return finalize(thread, out, rule.id);
  }
  return finalize(thread, { priority: 'medium', category: 'other' });
}

function finalize(thread: ThreadInput, out: RuleOutput, ruleId?: string): ClassificationResult {
  return {
    priority: out.priority,
    category: out.category,
    subject: makeSubject(thread, out.category),
    summary: makeSummary(thread, out.category),
    suggested_next_action: NEXT_ACTION[out.category],
    status: out.status,
    method: 'rules',
    ruleId,
  };
}

function makeSubject(thread: ThreadInput, category: Category): string {
  const name = (thread.customer_name ?? '').trim() || 'Customer';
  return `${name} — ${CATEGORY_LABEL[category]}`;
}

function makeSummary(thread: ThreadInput, category: Category): string {
  const inbound = thread.messages.filter(m => m.direction === 'inbound');
  const last = inbound[inbound.length - 1];
  const snip = (last?.snippet ?? last?.body_text ?? '').replace(/\s+/g, ' ').trim();
  if (!snip) return `${CATEGORY_LABEL[category]} thread`;
  return snip.length > 180 ? snip.slice(0, 177) + '...' : snip;
}
