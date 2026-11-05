// Outbound Quo (OpenPhone) text for the customer-facing fulfillment sends —
// the shipping notice and the next-day onboarding instructions.
//
// Same rules as send-ticket-sms: the first OPENPHONE_PHONE_NUMBER_IDS entry is
// the sending line, and FOLLOWUP_SMS_TEST_PHONE redirects every send while set.
//
// Never throws. A text is the secondary channel to an email that has already
// gone out, so a missing number or a Quo outage is reported back to the caller
// to record, not allowed to fail the send around it.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

export type QuoSmsResult =
  | { ok: true; to: string; message_id: string | null; test_redirected: boolean }
  | { ok: false; error: string };

/** Normalise a North-American number to E.164; pass through anything already +-prefixed. */
export function toE164(raw: string): string | null {
  const s = raw.trim();
  if (s.startsWith('+')) {
    const d = s.slice(1).replace(/\D/g, '');
    return d.length >= 8 ? `+${d}` : null;
  }
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

const norm = (v: string | null | undefined) => (v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** The phone on file for an order: the order's own column, else the linked
 *  customer record — but only when that record names the same person, because
 *  orders.customer_id is set by a trigger that can match on name alone (the
 *  same guard resolveRecipient applies to email). */
export async function resolveOrderPhone(
  admin: SupabaseClient,
  order: { customer_name: string; customer_phone?: string | null; customer_id?: string | null },
): Promise<string | null> {
  const onOrder = order.customer_phone?.trim();
  if (onOrder) return onOrder;
  if (!order.customer_id) return null;
  const { data: c } = await admin
    .from('customers')
    .select('full_name, phone')
    .eq('id', order.customer_id)
    .maybeSingle<{ full_name: string | null; phone: string | null }>();
  const phone = c?.phone?.trim();
  if (!phone) return null;
  const a = norm(order.customer_name);
  if (a === '' || a !== norm(c?.full_name)) return null;
  return phone;
}

export async function sendQuoSms(rawPhone: string | null, text: string): Promise<QuoSmsResult> {
  const apiKey = Deno.env.get('OPENPHONE_API_KEY');
  const fromIds = (Deno.env.get('OPENPHONE_PHONE_NUMBER_IDS') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!apiKey || fromIds.length === 0) {
    return { ok: false, error: 'OPENPHONE_API_KEY / OPENPHONE_PHONE_NUMBER_IDS not configured' };
  }
  if (!rawPhone) return { ok: false, error: 'no phone number on file' };
  const dest = toE164(rawPhone);
  if (!dest) return { ok: false, error: `"${rawPhone}" is not a valid phone number` };
  const body = text.trim();
  if (!body) return { ok: false, error: 'empty message' };
  if (body.length > 1600) return { ok: false, error: 'message too long (1600 characters max)' };

  const testPhone = Deno.env.get('FOLLOWUP_SMS_TEST_PHONE');
  const to = testPhone || dest;
  const content = testPhone ? `[TEST → ${dest}] ${body}` : body;
  try {
    const res = await fetch('https://api.openphone.com/v1/messages', {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromIds[0], to: [to], content }),
    });
    if (!res.ok) {
      const errTxt = await res.text();
      return { ok: false, error: `Quo ${res.status}: ${errTxt.slice(0, 300)}` };
    }
    const json = await res.json() as { data?: { id?: string } };
    return { ok: true, to: dest, message_id: json.data?.id ?? null, test_redirected: !!testPhone };
  } catch (e) {
    return { ok: false, error: `Quo request failed: ${(e as Error).message}` };
  }
}
