// Anthropic-backed LLM fallback for the ticket classifier. Called when the
// pure rules in classifier.ts return category='other' AND budget allows.
//
// This file lives OUTSIDE the drift-checked classifier.ts because it depends
// on Deno-only globals (fetch, Deno.env, Web Crypto). The shared module is
// imported by sync-gmail-tickets (budget-gated) and reclassify-ticket
// (always-on, one call per invocation).

import type { Category, Priority, ThreadInput } from './classifier.ts';

const LLM_MODEL = 'claude-haiku-4-5-20251001';

const LLM_CATEGORIES: Category[] = [
  'return_hardware_defect','warranty_replacement','refund','software_firmware',
  'complaint','callback','assembly_support','troubleshooting','logistics_pickup',
  'order_fulfillment','in_person_service','appointment','marketing_social',
  'closed_acknowledgment','other',
];

export type LLMClassification = {
  priority: Priority;
  category: Category;
  summary: string;
  suggested_next_action: string;
  confidence: number;
};

/** Call Anthropic to classify a thread. Returns null when the API key is
 *  unset, the call fails, or the model returns malformed JSON. */
export async function llmClassify(thread: ThreadInput): Promise<LLMClassification | null> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return null;

  const recent = thread.messages.slice(-20);
  const transcript = recent.map(m => {
    const who = m.direction === 'outbound' ? 'staff' : 'customer';
    const when = (m.sent_at ?? '').slice(0, 16).replace('T', ' ');
    const body = (m.body_text || m.snippet || '').slice(0, 2000);
    return `[${who} ${when}] ${body}`;
  }).join('\n\n');

  const userPrompt = `Classify this customer support thread. Output strict JSON with these exact fields:
{
  "priority": one of ["urgent","high","medium","low"],
  "category": one of [${LLM_CATEGORIES.map(c => `"${c}"`).join(',')}],
  "summary": "1-2 sentence current state",
  "suggested_next_action": "one sentence next step for staff",
  "confidence": float in 0..1
}

Customer: ${thread.customer_name ?? 'unknown'}
Subject: ${thread.subject}

Transcript (oldest first):
${transcript}

Respond with JSON only. No markdown, no preamble.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: 600,
      system: 'You are a customer-support triage classifier. Output strict JSON only.',
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
