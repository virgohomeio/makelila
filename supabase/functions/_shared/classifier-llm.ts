// Anthropic-backed classifier for support tickets. Called by reclassify-ticket
// (always-on) and sync-gmail-tickets (budget-gated for category='other' only).
//
// This file lives OUTSIDE the drift-checked classifier.ts because it depends
// on Deno-only globals (fetch, Deno.env, Web Crypto).

import type { Category, Priority, ThreadInput } from './classifier.ts';

// Sonnet for reclassify (richer reasoning); callers may override.
export const LLM_MODEL_DEFAULT = 'claude-sonnet-4-6';
export const LLM_MODEL_FAST    = 'claude-haiku-4-5-20251001';

const LLM_CATEGORIES: Category[] = [
  'return_hardware_defect','warranty_replacement','refund','software_firmware',
  'complaint','callback','assembly_support','troubleshooting','logistics_pickup',
  'order_fulfillment','in_person_service','appointment','marketing_social',
  'closed_acknowledgment','other',
];

const ISSUE_AREAS = [
  'electrical','mechanical','software','shipping','billing','onboarding','other',
] as const;
type IssueArea = (typeof ISSUE_AREAS)[number];

const TICKET_STATUSES = [
  'waiting_on_us','in_progress','waiting_on_customer',
  'queued_for_replacement','call_scheduled','on_hold','closed',
] as const;
type TicketStatus = (typeof TICKET_STATUSES)[number];

export type UnitContext = {
  serial: string;
  model?: string | null;
  unit_status?: string | null;
  batch_label?: string | null;
};

export type QuoMessage = {
  direction: 'incoming' | 'outgoing';
  text: string;
  createdAt: string; // ISO 8601
};

export type LLMClassification = {
  priority: Priority;
  category: Category;
  status: TicketStatus;
  issue_area: IssueArea;
  root_cause: string;           // plain-English specific explanation, ≤120 chars
  summary: string;              // 1-2 sentence current state
  suggested_next_action: string;
  confidence: number;
};

/**
 * Call Claude to classify a support thread.
 * Returns null on API key missing, network failure, or malformed JSON.
 * opts.model defaults to LLM_MODEL_DEFAULT (Sonnet).
 */
export async function llmClassify(
  thread: ThreadInput,
  opts: { model?: string; unit?: UnitContext | null; quoMessages?: QuoMessage[] } = {},
): Promise<LLMClassification | null> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return null;

  const model = opts.model ?? LLM_MODEL_DEFAULT;
  const unit = opts.unit ?? null;
  const quoMessages = opts.quoMessages ?? [];

  const recent = thread.messages.slice(-30);
  const transcript = recent.map(m => {
    const who = m.direction === 'outbound' ? 'staff' : 'customer';
    const when = (m.sent_at ?? '').slice(0, 16).replace('T', ' ');
    const body = (m.body_text || m.snippet || '').slice(0, 2000);
    return `[${who} ${when}] ${body}`;
  }).join('\n\n');

  const unitLine = unit
    ? `Unit: ${unit.serial}${unit.model ? ` · model ${unit.model}` : ''}${unit.unit_status ? ` · ${unit.unit_status}` : ''}${unit.batch_label ? ` · batch ${unit.batch_label}` : ''}`
    : 'Unit: not linked';

  const userPrompt = `You are a customer support triage expert for VCycene/LILA Composter, a home composting appliance company.

Analyze this support thread and return strict JSON with exactly these fields:
{
  "priority": one of ["urgent","high","medium","low"],
  "category": one of [${LLM_CATEGORIES.map(c => `"${c}"`).join(',')}],
  "status": one of ["waiting_on_us","in_progress","waiting_on_customer","queued_for_replacement","call_scheduled","on_hold","closed"],
  "issue_area": one of ["electrical","mechanical","software","shipping","billing","onboarding","other"],
  "root_cause": "concise specific root cause in plain English, max 120 chars",
  "summary": "1-2 sentences on the current state of this support case",
  "suggested_next_action": "one sentence — what staff should do next",
  "confidence": float 0.0–1.0
}

Status assignment rules:
- waiting_on_us: last message was inbound from customer and staff has not replied yet
- waiting_on_customer: staff replied last; waiting for customer response
- in_progress: being actively diagnosed or worked (appointment pending, trial fix underway)
- queued_for_replacement: confirmed hardware defect, unit replacement arranged or pending
- call_scheduled: a call or technician visit is booked
- on_hold: parked — waiting for parts, carrier update, or third party
- closed: fully resolved or acknowledged as closed

Root cause examples:
- "Door seal degraded — leaks liquid when full"
- "WiFi module not pairing after firmware v2.3 update"
- "Shipment lost in transit — FedEx trace filed"
- "Customer skipped initial setup; auger jammed with uncomposted material"
- "Billing dispute: Sezzle instalment missed due to expired card"

Customer: ${thread.customer_name ?? 'unknown'}
${unitLine}
Subject: ${thread.subject}

Transcript (oldest first, max 30 messages):
${transcript || '(no messages)'}
${quoMessages.length > 0 ? `
Live Quo SMS (not yet synced, oldest first):
${quoMessages.map(m => {
  const who = m.direction === 'outgoing' ? 'staff' : 'customer';
  const when = m.createdAt.slice(0, 16).replace('T', ' ');
  return `[${who} SMS ${when}] ${m.text.slice(0, 500)}`;
}).join('\n\n')}` : ''}
Respond with JSON only. No markdown, no preamble.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      system: 'You are a customer-support triage classifier for VCycene. Output strict JSON only — no markdown, no commentary.',
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    console.warn(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }

  const json = await res.json() as { content?: { text?: string }[] };
  const text = (json.content?.[0]?.text ?? '').trim();
  try {
    const parsed = JSON.parse(text) as LLMClassification;
    if (!['urgent','high','medium','low'].includes(parsed.priority)) return null;
    if (!LLM_CATEGORIES.includes(parsed.category)) return null;
    if (!TICKET_STATUSES.includes(parsed.status as TicketStatus)) return null;
    if (!ISSUE_AREAS.includes(parsed.issue_area as IssueArea)) return null;
    if (typeof parsed.root_cause !== 'string') return null;
    return parsed;
  } catch {
    console.warn(`Failed to parse LLM JSON: ${text.slice(0, 200)}`);
    return null;
  }
}

/** SHA-256 hex digest via Web Crypto. Used for the LLM input hash so we can
 *  audit/dedupe LLM calls in ticket_classification_log. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
