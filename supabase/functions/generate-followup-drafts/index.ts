// Auto follow-up queue Phase 1: generate Claude-drafted SMS messages
// for a list of overdue customers. See
// docs/superpowers/specs/2026-06-03-auto-followup-queue-design.md.
//
// Auth: operator JWT required (gated via _shared/auth.ts authenticate()).

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { authenticate } from '../_shared/auth.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Input = { customer_ids?: string[] };
type FuKind = 'fu1' | 'fu2';
type Draft = {
  customer_id: string;
  customer_name: string;
  customer_phone: string | null;
  days_overdue: number;
  fu_kind: FuKind;
  draft_message: string | null;
  skip_reason: string | null;
  context_summary: string;
};

const FU1_DAYS = 7;
const FU2_DAYS = 30;
const RECENT_TOUCH_DAYS = 7;
const MAX_QUO_MESSAGES = 20;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!supabaseUrl || !serviceKey) return j({ error: 'Missing SUPABASE_URL / SERVICE_ROLE_KEY' }, 500);
    if (!anthropicKey) return j({ error: 'ANTHROPIC_API_KEY not configured' }, 500);

    const admin = createClient(supabaseUrl, serviceKey);

    let _caller;
    try { _caller = await authenticate(req, admin); }
    catch (e) { if (e instanceof Response) return e; throw e; }
    if (_caller.kind !== 'user') {
      return j({ error: 'This function requires an operator JWT — cron-secret not accepted.' }, 403);
    }

    const { customer_ids } = (await req.json()) as Input;

    // 1. Resolve the customer list.
    let ids = customer_ids ?? [];
    if (ids.length === 0) {
      // Fetch overdue-candidates and filter client-side (small set, ~300 customers).
      const { data: allCustomers } = await admin
        .from('customers')
        .select('id, onboard_date, fu1_status, fu2_status')
        .not('onboard_date', 'is', null);
      const today = new Date();
      ids = (allCustomers ?? []).filter(c => {
        const onboard = new Date(c.onboard_date + 'T00:00:00');
        const fu1Due = new Date(onboard); fu1Due.setDate(fu1Due.getDate() + FU1_DAYS);
        const fu2Due = new Date(onboard); fu2Due.setDate(fu2Due.getDate() + FU2_DAYS);
        if (!c.fu1_status && today > fu1Due) return true;
        if (c.fu1_status && !c.fu2_status && today > fu2Due) return true;
        return false;
      }).map(c => c.id);
    }

    if (ids.length === 0) return j({ drafts: [] });

    // 2. Build per-customer drafts (serialized; ~10s for 10 customers).
    const drafts: Draft[] = [];
    for (const id of ids) {
      try {
        const draft = await buildDraftForCustomer(admin, anthropicKey, id);
        if (draft) drafts.push(draft);
      } catch (e) {
        // Bad row shouldn't crash the batch. Surface as a skip so the
        // operator sees something rather than losing 49 other drafts.
        drafts.push({
          customer_id: id,
          customer_name: '(unknown — fetch failed)',
          customer_phone: null,
          days_overdue: 0,
          fu_kind: 'fu1',
          draft_message: null,
          skip_reason: `Internal error: ${(e as Error).message}`,
          context_summary: '',
        });
      }
    }

    // If every customer in the batch errored with an LLM-error skip_reason,
    // upstream (Anthropic) is the likely cause — return 502 so the UI shows
    // "service unavailable" rather than rendering 0 usable drafts.
    if (drafts.length > 0 && drafts.every(d => d.skip_reason?.startsWith('LLM error:'))) {
      return j({
        error: 'All drafts failed at the LLM stage — Anthropic likely down. First error: ' + drafts[0].skip_reason,
        drafts,
      }, 502);
    }

    return j({ drafts });
  } catch (err) {
    return j({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }, 500);
  }
});

async function buildDraftForCustomer(
  admin: SupabaseClient,
  anthropicKey: string,
  customerId: string,
): Promise<Draft | null> {
  const { data: c } = await admin
    .from('customers')
    .select('id, full_name, first_name, email, phone, onboard_date, fu1_status, fu2_status, fu_notes')
    .eq('id', customerId)
    .maybeSingle();
  if (!c) return null;

  const onboardDate = c.onboard_date ? new Date(c.onboard_date + 'T00:00:00') : null;
  const today = new Date();
  let fuKind: FuKind | null = null;
  let daysOverdue = 0;
  if (onboardDate) {
    const fu1Due = new Date(onboardDate); fu1Due.setDate(fu1Due.getDate() + FU1_DAYS);
    const fu2Due = new Date(onboardDate); fu2Due.setDate(fu2Due.getDate() + FU2_DAYS);
    if (!c.fu1_status && today > fu1Due) {
      fuKind = 'fu1';
      daysOverdue = Math.floor((today.getTime() - fu1Due.getTime()) / 86400_000);
    } else if (c.fu1_status && !c.fu2_status && today > fu2Due) {
      fuKind = 'fu2';
      daysOverdue = Math.floor((today.getTime() - fu2Due.getTime()) / 86400_000);
    }
  }
  if (!fuKind) return null;

  const baseDraft: Draft = {
    customer_id: c.id,
    customer_name: c.full_name ?? c.first_name ?? '(unknown)',
    customer_phone: c.phone,
    days_overdue: daysOverdue,
    fu_kind: fuKind,
    draft_message: null,
    skip_reason: null,
    context_summary: '',
  };

  // Auto-skip: no phone
  if (!c.phone) {
    return { ...baseDraft, skip_reason: 'No phone on file', context_summary: 'No phone on file' };
  }

  // Auto-skip: active return / refund / cancellation.
  // Gate on c.email — without an email we can't key these tables, so we
  // fall through and let Reina handle the judgment call manually.
  if (c.email) {
    const { data: activeReturn } = await admin
      .from('returns')
      .select('return_ref, status')
      .eq('customer_email', c.email)
      .in('status', ['created','in_transit','received','inspecting'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (activeReturn) {
      return {
        ...baseDraft,
        skip_reason: `Active return ${activeReturn.return_ref} (${activeReturn.status}) — manual touch only`,
        context_summary: `Active return ${activeReturn.return_ref}`,
      };
    }
  }

  if (c.email) {
    const { data: activeApproval } = await admin
      .from('refund_approvals')
      .select('id, status')
      .eq('customer_email', c.email)
      .in('status', ['manager_review','finance_review','approved'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (activeApproval) {
      return {
        ...baseDraft,
        skip_reason: `Active refund approval (${activeApproval.status}) — manual touch only`,
        context_summary: `Active refund approval`,
      };
    }
  }

  if (c.email) {
    const { data: activeCancel } = await admin
      .from('order_cancellations')
      .select('id')
      .eq('customer_email', c.email)
      .eq('status', 'submitted')
      .limit(1)
      .maybeSingle();
    if (activeCancel) {
      return {
        ...baseDraft,
        skip_reason: 'Active cancellation request — manual touch only',
        context_summary: 'Active cancellation',
      };
    }
  }

  // Auto-skip: outbound Quo message within last 7 days
  const recentCutoff = new Date(Date.now() - RECENT_TOUCH_DAYS * 86400_000).toISOString();
  const { data: recentOut } = await admin
    .from('ticket_messages')
    .select('sent_at, service_tickets!inner(customer_id, source)')
    .eq('direction', 'outbound')
    .eq('service_tickets.customer_id', c.id)
    .eq('service_tickets.source', 'quo')
    .gte('sent_at', recentCutoff)
    .order('sent_at', { ascending: false })
    .limit(1);
  if (recentOut && recentOut.length > 0) {
    return {
      ...baseDraft,
      skip_reason: `Already messaged via Quo on ${recentOut[0].sent_at?.slice(0,10) ?? 'recently'}`,
      context_summary: 'Recently messaged',
    };
  }

  // Activity bundle for the LLM prompt (independent of skip rules — fetches
  // latest regardless of status so Claude sees historical refunds/returns
  // when drafting). Each "last 1" per table, newest first.
  const activityParts: string[] = [];

  if (c.email) {
    const { data: latestReturn } = await admin
      .from('returns')
      .select('return_ref, status, reason, created_at')
      .eq('customer_email', c.email)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestReturn) {
      activityParts.push(
        `Return ${latestReturn.return_ref} (${latestReturn.status}) on ${latestReturn.created_at?.slice(0,10) ?? '?'}` +
        (latestReturn.reason ? ` — ${latestReturn.reason.slice(0, 100)}` : '')
      );
    }

    const { data: latestApproval } = await admin
      .from('refund_approvals')
      .select('status, refund_amount_usd, created_at')
      .eq('customer_email', c.email)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestApproval) {
      activityParts.push(
        `Refund approval ${latestApproval.status}` +
        (latestApproval.refund_amount_usd ? ` ($${latestApproval.refund_amount_usd})` : '') +
        ` on ${latestApproval.created_at?.slice(0,10) ?? '?'}`
      );
    }

    const { data: latestCancel } = await admin
      .from('order_cancellations')
      .select('status, reason, created_at')
      .eq('customer_email', c.email)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestCancel) {
      activityParts.push(
        `Cancellation request (${latestCancel.status}) on ${latestCancel.created_at?.slice(0,10) ?? '?'}` +
        (latestCancel.reason ? ` — ${latestCancel.reason.slice(0, 100)}` : '')
      );
    }
  }

  const activitySummary = activityParts.length > 0 ? activityParts.join('\n') : '(no recent returns / refunds / cancellations)';

  // Order (most recent by customer_email, fallback to customer_name)
  let orderRow: { order_ref: string; placed_at: string | null; country: string | null } | null = null;
  if (c.email) {
    const { data } = await admin
      .from('orders')
      .select('order_ref, placed_at, country')
      .eq('customer_email', c.email)
      .order('placed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    orderRow = data;
  } else if (c.full_name) {
    // Email-null fallback: lowercase-trimmed match on customer_name.
    // TODO(perf): for larger datasets, pre-build a customer-keyed map at
    // the top of handle() instead of re-fetching per customer. Pattern in
    // sync-quo-tickets/index.ts lines 119-165. Acceptable today at ~300
    // customers; revisit if the customer base grows.
    const needle = c.full_name.toLowerCase().trim();
    const { data: candidates } = await admin
      .from('orders')
      .select('order_ref, placed_at, country, customer_name')
      .not('customer_name', 'is', null)
      .order('placed_at', { ascending: false })
      .range(0, 9999);
    const match = (candidates ?? []).find(o =>
      o.customer_name && o.customer_name.toLowerCase().trim() === needle
    );
    if (match) {
      orderRow = { order_ref: match.order_ref, placed_at: match.placed_at, country: match.country };
    }
  }

  // Unit (most recent shipped to this customer_name).
  // Use a lowercase-trimmed exact match. ilike() is case-insensitive but
  // treats % and _ as wildcards, which is unsafe for arbitrary names; an
  // explicit lower(trim(...)) join in SQL would be ideal but the Supabase
  // JS client doesn't expose a `lower()` filter, so fetch a candidate set
  // and filter client-side.
  // TODO(perf): for larger datasets, pre-build a customer-keyed map at
  // the top of handle() instead of re-fetching per customer. Pattern in
  // sync-quo-tickets/index.ts lines 119-165. Acceptable today at ~300
  // customers; revisit if the customer base grows.
  let unitRow: { serial: string; batch: string; shipped_at: string | null } | null = null;
  if (c.full_name) {
    const needle = c.full_name.toLowerCase().trim();
    const { data: candidates } = await admin
      .from('units')
      .select('serial, batch, shipped_at, customer_name')
      .not('customer_name', 'is', null)
      .order('shipped_at', { ascending: false, nullsFirst: false })
      .range(0, 9999);
    const match = (candidates ?? []).find(u =>
      u.customer_name && u.customer_name.toLowerCase().trim() === needle
    );
    if (match) {
      unitRow = { serial: match.serial, batch: match.batch, shipped_at: match.shipped_at };
    }
  }

  // Quo history (last 20 messages, chronological)
  const { data: quoMsgs } = await admin
    .from('ticket_messages')
    .select('direction, body_text, sent_at, service_tickets!inner(customer_id, source)')
    .eq('service_tickets.customer_id', c.id)
    .eq('service_tickets.source', 'quo')
    .order('sent_at', { ascending: false })
    .limit(MAX_QUO_MESSAGES);
  const history = (quoMsgs ?? []).slice().reverse();

  const firstName = c.first_name ?? (c.full_name ?? '').split(' ')[0] ?? 'there';
  const contextSummary = [
    unitRow ? `shipped ${unitRow.shipped_at?.slice(0,10) ?? '?'} (${unitRow.batch})` : null,
    history.length > 0 ? `${history.length} Quo msgs (last ${history[history.length-1].sent_at?.slice(0,10)})` : 'no Quo history',
  ].filter(Boolean).join(', ');

  const prompt = composePrompt({
    firstName,
    fullName: c.full_name ?? firstName,
    fuKind,
    daysOverdue,
    onboardDate: c.onboard_date ?? '?',
    unitSerial: unitRow?.serial ?? null,
    unitBatch: unitRow?.batch ?? null,
    orderRef: orderRow?.order_ref ?? null,
    activitySummary,
    fuNotes: c.fu_notes ?? null,
    quoHistory: history.map(m => `${m.direction} ${m.sent_at?.slice(0,10) ?? '?'}: ${(m.body_text ?? '').slice(0, 200)}`).join('\n'),
  });

  try {
    const llmOut = await callClaude(anthropicKey, prompt);
    return {
      ...baseDraft,
      draft_message: llmOut.draft,
      skip_reason: llmOut.skip_reason,
      context_summary: contextSummary,
    };
  } catch (e) {
    return {
      ...baseDraft,
      skip_reason: `LLM error: ${(e as Error).message}`,
      context_summary: contextSummary,
    };
  }
}

function composePrompt(args: {
  firstName: string;
  fullName: string;
  fuKind: FuKind;
  daysOverdue: number;
  onboardDate: string;
  unitSerial: string | null;
  unitBatch: string | null;
  orderRef: string | null;
  activitySummary: string;
  fuNotes: string | null;
  quoHistory: string;
}): string {
  return `You are drafting a short SMS follow-up from Reina at VCycene (the company
that makes the Lila Pro composter). The customer is overdue for a
${args.fuKind === 'fu1' ? 'first (1-week)' : 'second (1-month)'} check-in.

Constraints on the message:
- 1-3 sentences max. SMS-length.
- Open warmly using the customer's first name.
- Reference at least one specific detail from the context below (an issue
  they raised, where they're at in onboarding, their product/unit serial,
  or the time since they got the unit).
- End with an open question or a clear "let me know if..." invitation.
- Sound like Reina — friendly, lowercase casual, no marketing speak.
- Do NOT mention "follow-up", "check-in", or "we noticed you're overdue".
- Do NOT use the words "appreciate", "valued customer", "outreach".

Customer profile:
- Name: ${args.fullName}
- Onboarded: ${args.onboardDate} (${args.daysOverdue} days past the ${args.fuKind.toUpperCase()} window)
- Unit: ${args.unitSerial ?? '(no serial linked)'} (${args.unitBatch ?? '?'})
- Order: ${args.orderRef ?? '(no order linked)'}

Recent activity:
${args.activitySummary}

Operator notes on this customer (most recent first):
${args.fuNotes ? args.fuNotes.slice(-500) : '(none)'}

Last few Quo messages with this customer (chronological):
${args.quoHistory || '(none)'}

Output strict JSON, no prose:
{"draft": "<message text>", "skip_reason": null}
OR if you cannot draft a good message:
{"draft": null, "skip_reason": "<short reason>"}`;
}

async function callClaude(apiKey: string, prompt: string): Promise<{ draft: string | null; skip_reason: string | null }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content ?? []).find(b => b.type === 'text')?.text ?? '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Claude returned non-JSON: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(jsonMatch[0]) as { draft?: string | null; skip_reason?: string | null };
  return {
    draft: parsed.draft ?? null,
    skip_reason: parsed.skip_reason ?? null,
  };
}

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
