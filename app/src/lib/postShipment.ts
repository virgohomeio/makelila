import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { logAction } from './activityLog';

// ============================================================================
// Returns
// ============================================================================

export type ReturnStatus =
  | 'created' | 'pickup_scheduled' | 'picked_up' | 'received'
  | 'inspected' | 'refunded' | 'denied' | 'closed' | 'discarded';

export type ReturnCondition =
  | 'unused' | 'used' | 'damaged'           // legacy / coarse
  | 'like-new' | 'good' | 'fair';           // granular (matches Jotform)

export const RETURN_STATUS_META: Record<ReturnStatus, { label: string; color: string; bg: string; border: string }> = {
  'created':          { label: 'Created',    color: '#4a5568', bg: '#f7fafc', border: '#cbd5e1' },
  'pickup_scheduled': { label: 'Pickup Sched',color:'#2b6cb0', bg: '#ebf8ff', border: '#bee3f8' },
  'picked_up':        { label: 'Picked Up',  color: '#2b6cb0', bg: '#ebf8ff', border: '#bee3f8' },
  'received':         { label: 'Received',   color: '#975a16', bg: '#fffbeb', border: '#f6ad55' },
  'inspected':        { label: 'Inspected',  color: '#c05621', bg: '#fffaf0', border: '#fbd38d' },
  'refunded':         { label: 'Refunded',   color: '#276749', bg: '#f0fff4', border: '#9ae6b4' },
  'denied':           { label: 'Denied',     color: '#9b2c2c', bg: '#fff5f5', border: '#fc8181' },
  'closed':           { label: 'Closed',     color: '#718096', bg: '#edf2f7', border: '#cbd5e1' },
  'discarded':        { label: 'Discarded',  color: '#744210', bg: '#fffff0', border: '#f6e05e' },
};

export const RETURN_STATUS_ORDER: ReturnStatus[] = [
  'created','pickup_scheduled','picked_up','received','inspected','refunded','denied','closed','discarded',
];

// Plain-language unit status for the Refunds tab — where is the physical unit?
export const UNIT_STATUS_LABEL: Record<ReturnStatus, string> = {
  'created':          'Return form submitted',
  'pickup_scheduled': 'Pickup scheduled',
  'picked_up':        'Picked up',
  'received':         'Received',
  'inspected':        'Received · inspected',
  'refunded':         'Received · refunded',
  'denied':           'Denied',
  'closed':           'Closed',
  'discarded':        'Unit discarded by customer',
};

// What the customer was told to do with the unit being returned.
export type ReturnDisposition = 'discard' | 'ship_back';
export const RETURN_DISPOSITION_META: Record<ReturnDisposition, { label: string; color: string; bg: string }> = {
  discard:   { label: 'Discard unit',  color: '#9b2c2c', bg: '#fff5f5' },
  ship_back: { label: 'Ship unit back', color: '#2b6cb0', bg: '#ebf8ff' },
};

export type ReturnCategory =
  | 'product_defect' | 'software_issue' | 'shipping_damage'
  | 'customer_service' | 'financing' | 'other';

export const RETURN_CATEGORY_META: Record<ReturnCategory, { label: string; color: string; bg: string }> = {
  product_defect:    { label: 'Product Defect',     color: '#9b2c2c', bg: '#fff5f5' },
  software_issue:    { label: 'Software Issue',     color: '#2b6cb0', bg: '#ebf8ff' },
  shipping_damage:   { label: 'Shipping Damage',    color: '#c05621', bg: '#fffaf0' },
  customer_service:  { label: 'Customer Service',   color: '#553c9a', bg: '#faf5ff' },
  financing:         { label: 'Financing',          color: '#276749', bg: '#f0fff4' },
  other:             { label: 'Other',              color: '#718096', bg: '#f7fafc' },
};

export const RETURN_CATEGORIES: ReturnCategory[] = [
  'product_defect','software_issue','shipping_damage',
  'customer_service','financing','other',
];

// Responsible-team accountability mapping (PostShipment dashboard, George's
// ask). Derived from return_category — no separate column. A return with no
// category counts toward 'Unassigned' alongside the 'other' category.
export const CATEGORY_TEAM: Record<ReturnCategory, string> = {
  product_defect:   'Engineering',
  software_issue:   'Software',
  shipping_damage:  'Logistics',
  customer_service: 'Customer Service',
  financing:        'Finance',
  other:            'Unassigned',
};

export const RETURN_TEAMS: string[] = [
  'Engineering', 'Software', 'Logistics', 'Customer Service', 'Finance', 'Unassigned',
];

/** Counts returns per responsible team, ordered by RETURN_TEAMS, dropping
 *  teams with zero returns. Null/unknown category → 'Unassigned'. */
export function returnTeamCounts(
  rows: Array<Pick<ReturnRow, 'return_category'>>,
): Array<{ label: string; value: number }> {
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const team = r.return_category ? CATEGORY_TEAM[r.return_category] : 'Unassigned';
    counts[team] = (counts[team] ?? 0) + 1;
  }
  return RETURN_TEAMS
    .filter(t => (counts[t] ?? 0) > 0)
    .map(t => ({ label: t, value: counts[t] }));
}

export type ReturnRow = {
  id: string;
  return_ref: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  channel: 'Canada' | 'USA' | null;
  unit_serial: string | null;
  original_order_ref: string | null;
  condition: ReturnCondition | null;
  reason: string | null;
  return_category: ReturnCategory | null;
  disposition: ReturnDisposition | null;
  refund_amount_usd: number | null;
  status: ReturnStatus;
  pickup_carrier: string | null;
  pickup_tracking: string | null;
  pickup_date: string | null;
  received_at: string | null;
  refund_issued_at: string | null;
  notes: string | null;
  description: string | null;
  source: 'ops' | 'customer_form';
  // Extended fields from the Jotform return form
  usage_duration: string | null;
  return_reasons: string[];
  support_contacted: string | null;
  experience_rating: number | null;
  would_change_decision: string | null;
  future_likelihood: string | null;
  packaging_status: string | null;
  alternative_composting: string | null;
  refund_method_preference: string | null;
  refund_contact: string | null;
  additional_comments: string | null;
  purchase_proof: string | null;
  created_at: string;
  updated_at: string;
};

export function useReturns(): { returns: ReturnRow[]; loading: boolean } {
  const [returns, setReturns] = useState<ReturnRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('returns')
        .select('*')
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) setReturns(data as ReturnRow[]);
      setLoading(false);

      channel = supabase
        .channel('returns:realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'returns' }, (payload) => {
          setReturns(prev => {
            if (payload.eventType === 'DELETE' && payload.old) {
              return prev.filter(r => r.id !== (payload.old as { id: string }).id);
            }
            if (payload.new) {
              const row = payload.new as ReturnRow;
              const idx = prev.findIndex(r => r.id === row.id);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [row, ...prev];
            }
            return prev;
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { returns, loading };
}

export async function updateReturnStatus(id: string, newStatus: ReturnStatus): Promise<void> {
  const patch: Record<string, unknown> = { status: newStatus };
  if (newStatus === 'received' && !(await hasField(id, 'received_at'))) {
    patch.received_at = new Date().toISOString();
  }
  if (newStatus === 'refunded') {
    patch.refund_issued_at = new Date().toISOString();
  }
  const { error } = await supabase.from('returns').update(patch).eq('id', id);
  if (error) throw error;

  // #89: emit Klaviyo win-back event when a return is fully refunded so
  // Klaviyo can trigger the 30-day re-engagement flow.
  let klaviyoEmail: string | undefined;
  if (newStatus === 'refunded') {
    const { data: ret } = await supabase
      .from('returns')
      .select('customer_email')
      .eq('id', id)
      .maybeSingle();
    klaviyoEmail = (ret as { customer_email?: string | null } | null)?.customer_email ?? undefined;
  }

  await logAction('return_status', id, `→ ${newStatus}`,
    { entityType: 'return', entityId: id },
    newStatus === 'refunded' && klaviyoEmail
      ? { klaviyoEvent: 'Return Refunded', klaviyoEmail }
      : undefined);
}

export async function updateReturnCategory(id: string, category: ReturnCategory | null): Promise<void> {
  const { error } = await supabase
    .from('returns')
    .update({ return_category: category })
    .eq('id', id);
  if (error) throw error;
  await logAction('return_category', id, category ?? 'cleared',
    { entityType: 'return', entityId: id });
}

/** Sets whether the customer was told to discard the unit or ship it back. */
export async function setReturnDisposition(id: string, disposition: ReturnDisposition | null): Promise<void> {
  const { error } = await supabase
    .from('returns')
    .update({ disposition })
    .eq('id', id);
  if (error) throw error;
  await logAction('return_disposition', id, disposition ?? 'cleared',
    { entityType: 'return', entityId: id });
}

async function hasField(id: string, field: string): Promise<boolean> {
  const { data } = await supabase.from('returns').select(field).eq('id', id).single();
  return !!(data as Record<string, unknown> | null)?.[field];
}

// ============================================================================
// Replacement queue
// ============================================================================

export type ReplQueueStatus = 'queued' | 'assigned' | 'shipped' | 'closed';

export type ReplQueueRow = {
  id: string;
  customer_name: string;
  customer_email: string | null;
  original_unit_serial: string | null;
  original_order_ref: string | null;
  batch_preference: string | null;
  priority: boolean;
  assigned_serial: string | null;
  status: ReplQueueStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export function useReplacementQueue(): { queue: ReplQueueRow[]; loading: boolean } {
  const [queue, setQueue] = useState<ReplQueueRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('replacement_queue')
        .select('*')
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true });
      if (cancelled) return;
      if (!error && data) setQueue(data as ReplQueueRow[]);
      setLoading(false);

      channel = supabase
        .channel('replacement_queue:realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'replacement_queue' }, (payload) => {
          setQueue(prev => {
            if (payload.eventType === 'DELETE' && payload.old) {
              return prev.filter(r => r.id !== (payload.old as { id: string }).id);
            }
            if (payload.new) {
              const row = payload.new as ReplQueueRow;
              const idx = prev.findIndex(r => r.id === row.id);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [...prev, row];
            }
            return prev;
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { queue, loading };
}

/** Assign a specific serial from ready inventory to a queued replacement. */
export async function assignReplacementSerial(id: string, serial: string): Promise<void> {
  const { error } = await supabase.from('replacement_queue')
    .update({ assigned_serial: serial, status: 'assigned' })
    .eq('id', id);
  if (error) throw error;
  await logAction('repl_assign', id, `serial ${serial}`);
}

export async function clearReplacementAssignment(id: string): Promise<void> {
  const { error } = await supabase.from('replacement_queue')
    .update({ assigned_serial: null, status: 'queued' })
    .eq('id', id);
  if (error) throw error;
  await logAction('repl_unassign', id, 'cleared');
}

export async function toggleReplPriority(id: string, value: boolean): Promise<void> {
  const { error } = await supabase.from('replacement_queue')
    .update({ priority: value })
    .eq('id', id);
  if (error) throw error;
  await logAction('repl_priority', id, value ? 'priority' : 'normal');
}

export async function updateReplStatus(id: string, newStatus: ReplQueueStatus): Promise<void> {
  const { error } = await supabase.from('replacement_queue')
    .update({ status: newStatus })
    .eq('id', id);
  if (error) throw error;
  await logAction('repl_status', id, `→ ${newStatus}`);
}

// ============================================================================
// Refund approvals (Pedrum dual sign-off: George manager → Julie finance)
// ============================================================================

export type RefundStatus =
  | 'submitted' | 'manager_review' | 'finance_review'
  | 'refund_queue' | 'refunded' | 'denied' | 'closed';

export const REFUND_STATUS_META: Record<RefundStatus, { label: string; color: string; bg: string; border: string }> = {
  submitted:       { label: 'Submitted',        color: '#4a5568', bg: '#f7fafc', border: '#cbd5e1' },
  manager_review:  { label: 'Manager review',   color: '#2b6cb0', bg: '#ebf8ff', border: '#bee3f8' },
  finance_review:  { label: 'Finance review',   color: '#c05621', bg: '#fffaf0', border: '#fbd38d' },
  // Case + amount approved; awaiting the operator to actually execute the payout.
  refund_queue:    { label: 'Refund Queue',     color: '#553c9a', bg: '#faf5ff', border: '#d6bcfa' },
  refunded:        { label: 'Refunded',         color: '#276749', bg: '#f0fff4', border: '#9ae6b4' },
  denied:          { label: 'Denied',           color: '#9b2c2c', bg: '#fff5f5', border: '#fc8181' },
  closed:          { label: 'Closed',           color: '#718096', bg: '#edf2f7', border: '#cbd5e1' },
};

export type RefundMethod =
  | 'shopify' | 'sezzle' | 'quickbooks_cc' | 'bank_etransfer' | 'original_card';

export const REFUND_METHOD_META: Record<RefundMethod, { label: string; description: string }> = {
  shopify:        { label: 'Shopify',              description: 'Process via Shopify Admin' },
  sezzle:         { label: 'Sezzle financing',     description: 'For Sezzle-financed orders' },
  quickbooks_cc:  { label: 'QuickBooks CC',        description: 'Card refund in QuickBooks' },
  bank_etransfer: { label: 'Bank e-transfer',      description: 'CA customers only' },
  original_card:  { label: 'Back to original card',description: 'Refund to the card used at checkout' },
};

export const REFUND_METHODS: RefundMethod[] = [
  'shopify','sezzle','quickbooks_cc','bank_etransfer','original_card',
];

export type RefundApproval = {
  id: string;
  return_id: string | null;
  order_id: string | null;
  customer_name: string;
  customer_email: string | null;
  refund_amount_usd: number;
  refund_method: RefundMethod | null;
  original_amount_usd: number | null;
  amount_correction_note: string | null;
  currency: string;
  payment_method: string | null;
  reason: string | null;
  notes: string | null;
  status: RefundStatus;
  submitted_by: string | null;
  submitted_at: string;
  manager_approved_by: string | null;
  manager_approved_at: string | null;
  manager_decision_note: string | null;
  finance_approved_by: string | null;
  finance_approved_at: string | null;
  finance_decision_note: string | null;
  refunded_at: string | null;
  denied_by: string | null;
  denied_at: string | null;
  denied_at_stage: 'manager_review' | 'finance_review' | null;
  denied_reason: string | null;
  created_at: string;
  updated_at: string;
};

// Refund approval gating moved to lib/permissions.ts canDo() helpers
// (Huayi RBAC Phase A, migration 20260607020000). Call sites import
// from 'lib/permissions': canDo(role, 'approve_refund_manager') etc.
// profiles.role enum is the source of truth; RLS on refund_approvals
// enforces is_manager() in WITH CHECK as a backstop.

export function useRefundApprovals(): { approvals: RefundApproval[]; loading: boolean } {
  const [approvals, setApprovals] = useState<RefundApproval[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('refund_approvals')
        .select('*')
        .order('submitted_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) setApprovals(data as RefundApproval[]);
      setLoading(false);

      channel = supabase
        .channel('refund_approvals:realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'refund_approvals' }, (payload) => {
          setApprovals(prev => {
            if (payload.eventType === 'DELETE' && payload.old) {
              return prev.filter(r => r.id !== (payload.old as { id: string }).id);
            }
            if (payload.new) {
              const row = payload.new as RefundApproval;
              const idx = prev.findIndex(r => r.id === row.id);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [row, ...prev];
            }
            return prev;
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { approvals, loading };
}

// ── Refund notes (collaborative, approver-visible) ──────────────────────────

export type RefundNote = {
  id: string;
  refund_id: string;
  body: string;
  author_id: string | null;
  author_name: string | null;
  created_at: string;
};

export function useRefundNotes(refundId: string | null): {
  notes: RefundNote[]; loading: boolean; refresh: () => void;
} {
  const [notes, setNotes] = useState<RefundNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!refundId) { setNotes([]); setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from('refund_notes')
        .select('*')
        .eq('refund_id', refundId)
        .order('created_at', { ascending: true });
      if (!cancelled) { setNotes((data ?? []) as RefundNote[]); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [refundId, tick]);

  return { notes, loading, refresh: () => setTick(t => t + 1) };
}

export async function addRefundNote(refundId: string, body: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  let authorName: string | null = null;
  if (user) {
    const { data: prof } = await supabase.from('profiles').select('display_name').eq('id', user.id).maybeSingle();
    authorName = (prof as { display_name?: string } | null)?.display_name ?? user.email ?? null;
  }
  const { error } = await supabase.from('refund_notes')
    .insert({ refund_id: refundId, body: body.trim(), author_id: user?.id ?? null, author_name: authorName });
  if (error) throw error;
  await logAction('refund_note_added', refundId, body.trim().slice(0, 120));
}

export async function deleteRefundNote(noteId: string, refundId: string): Promise<void> {
  const { error } = await supabase.from('refund_notes').delete().eq('id', noteId);
  if (error) throw error;
  await logAction('refund_note_deleted', refundId, noteId);
}

async function currentUserId(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error('refund: not authenticated');
  return data.user.id;
}

export async function submitRefundRequest(input: {
  return_id?: string;
  order_id?: string;
  customer_name: string;
  customer_email?: string;
  refund_amount_usd: number;
  payment_method?: string;
  reason?: string;
  notes?: string;
}): Promise<void> {
  const userId = await currentUserId();
  const { error } = await supabase.from('refund_approvals').insert({
    ...input,
    status: 'manager_review',
    submitted_by: userId,
  });
  if (error) throw error;
  await logAction('refund_submitted', input.customer_name, `$${input.refund_amount_usd} (${input.reason ?? 'no reason'})`,
    undefined,
    {
      klaviyoEvent: 'Refund Submitted',
      ...(input.customer_email ? { klaviyoEmail: input.customer_email } : {}),
      facebookEvent: {
        event_name: 'StartTrial',
        event_time: Math.floor(Date.now() / 1000),
        email: input.customer_email ?? undefined,
        order_id: input.order_id,
        event_id: `return-${input.order_id ?? Date.now()}`,
      },
    });
}

export async function managerApprove(id: string, note?: string): Promise<void> {
  const userId = await currentUserId();
  const { error } = await supabase.from('refund_approvals').update({
    status: 'finance_review',
    manager_approved_by: userId,
    manager_approved_at: new Date().toISOString(),
    manager_decision_note: note ?? null,
  }).eq('id', id);
  if (error) throw error;
  await logAction('refund_manager_approved', id, note ?? 'approved');
}

export type FinanceApproveOpts = {
  method: RefundMethod;
  amount?: number;             // if omitted, keep original
  correction_note?: string;    // required if amount differs from original
  note?: string;               // free-form optional note (e.g. Stripe refund ID)
};

export async function financeApprove(id: string, opts: FinanceApproveOpts): Promise<void> {
  const userId = await currentUserId();

  // 1. Fetch the approval row to validate + read original amount
  const { data: approval, error: aErr } = await supabase
    .from('refund_approvals')
    .select('id, return_id, original_amount_usd, refund_amount_usd, status, customer_email')
    .eq('id', id)
    .single();
  if (aErr || !approval) throw new Error(`Refund approval not found: ${aErr?.message}`);
  if (approval.status !== 'finance_review') {
    throw new Error(`Cannot finance-approve from status: ${approval.status}`);
  }

  // 2. Guard: if linked to a return, the return must be in a received-or-later status
  if (approval.return_id) {
    const { data: ret, error: rErr } = await supabase
      .from('returns')
      .select('id, status')
      .eq('id', approval.return_id)
      .single();
    if (rErr || !ret) throw new Error(`Linked return not found: ${rErr?.message}`);
    if (!['received','inspected','refunded','closed'].includes(ret.status)) {
      throw new Error(`Return is in status '${ret.status}' — refund cannot be processed until the unit is received.`);
    }
  }

  // 3. Compute amount + validate correction_note
  const original = Number(approval.original_amount_usd ?? approval.refund_amount_usd);
  const adjusted = opts.amount ?? original;
  const amountChanged = Number(adjusted.toFixed(2)) !== Number(original.toFixed(2));
  if (amountChanged && !opts.correction_note?.trim()) {
    throw new Error('Correction note is required when changing the refund amount.');
  }

  // 4. Update the approval row → status='refund_queue'. Finance has approved the
  //    case + amount + method here; the payout itself is executed later from the
  //    Refund Queue (executeRefund), so we don't set refunded_at yet.
  const updatePatch: Record<string, unknown> = {
    status: 'refund_queue',
    refund_method: opts.method,
    refund_amount_usd: adjusted,
    amount_correction_note: amountChanged ? opts.correction_note!.trim() : null,
    finance_approved_by: userId,
    finance_approved_at: new Date().toISOString(),
    finance_decision_note: opts.note?.trim() || null,
  };
  const { error: upErr } = await supabase
    .from('refund_approvals')
    .update(updatePatch)
    .eq('id', id);
  if (upErr) throw upErr;

  await logAction('refund_finance_approved', id, `${opts.method} $${adjusted.toFixed(2)}`);
}

/** Refund Queue → Refunded. Finance has already approved the case + amount; this
 *  is the operator actually executing the payout and marking it done. The Klaviyo
 *  "Refund Processed" event fires here — the moment money actually moves — not at
 *  finance approval. */
export async function executeRefund(id: string, note?: string): Promise<void> {
  const { data: approval, error: aErr } = await supabase
    .from('refund_approvals')
    .select('id, status, customer_email')
    .eq('id', id)
    .single();
  if (aErr || !approval) throw new Error(`Refund approval not found: ${aErr?.message}`);
  if (approval.status !== 'refund_queue') {
    throw new Error(`Cannot execute a refund from status: ${approval.status}`);
  }
  const { error } = await supabase.from('refund_approvals').update({
    status: 'refunded',
    refunded_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) throw error;
  await logAction('refund_executed', id, note?.trim() || 'paid out',
    undefined,
    { klaviyoEvent: 'Refund Processed', ...(approval.customer_email ? { klaviyoEmail: approval.customer_email as string } : {}) });
}

export async function denyRefund(id: string, stage: 'manager_review' | 'finance_review', reason: string): Promise<void> {
  const userId = await currentUserId();
  const { error } = await supabase.from('refund_approvals').update({
    status: 'denied',
    denied_by: userId,
    denied_at: new Date().toISOString(),
    denied_at_stage: stage,
    denied_reason: reason,
  }).eq('id', id);
  if (error) throw error;
  await logAction('refund_denied', id, `${stage}: ${reason}`);
}

export async function closeRefund(id: string): Promise<void> {
  const { error } = await supabase.from('refund_approvals').update({ status: 'closed' }).eq('id', id);
  if (error) throw error;
  await logAction('refund_closed', id, 'archived');
}

// ============================================================================
// Order cancellations (customer-submitted via /cancel-order)
// ============================================================================

// Cancellations skip the manager/finance review — every customer request
// is accepted as intent. Two states: submitted (just came in, ops hasn't
// processed yet) and completed (cancelled + refund routed if applicable).
export type CancellationStatus = 'submitted' | 'completed';

export const CANCELLATION_STATUS_META: Record<CancellationStatus, { label: string; color: string; bg: string; border: string }> = {
  submitted: { label: 'Submitted', color: '#2b6cb0', bg: '#ebf8ff', border: '#bee3f8' },
  completed: { label: 'Completed', color: '#276749', bg: '#f0fff4', border: '#9ae6b4' },
};

export type OrderCancellation = {
  id: string;
  order_ref: string | null;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  preferred_contact: 'email' | 'phone' | null;
  order_date: string | null;
  product_name: string | null;
  order_amount_usd: number | null;
  purchase_channel: string | null;
  reason: string | null;
  description: string | null;
  product_received: boolean | null;
  desired_resolution: string | null;
  status: CancellationStatus;
  ops_notes: string | null;
  processed_by: string | null;
  processed_at: string | null;
  refund_approval_id: string | null;
  created_at: string;
  updated_at: string;
};

export function useOrderCancellations(): { cancellations: OrderCancellation[]; loading: boolean } {
  const [cancellations, setCancellations] = useState<OrderCancellation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('order_cancellations')
        .select('*')
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) setCancellations(data as OrderCancellation[]);
      setLoading(false);

      channel = supabase
        .channel('order_cancellations:realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'order_cancellations' }, (payload) => {
          setCancellations(prev => {
            if (payload.eventType === 'DELETE' && payload.old) {
              return prev.filter(c => c.id !== (payload.old as { id: string }).id);
            }
            if (payload.new) {
              const row = payload.new as OrderCancellation;
              const idx = prev.findIndex(c => c.id === row.id);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [row, ...prev];
            }
            return prev;
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { cancellations, loading };
}

/** Process the cancellation request: marks status='completed' and
 *  optionally spawns a refund_approval row when money needs to be paid
 *  back. No review/deny step — every customer request is accepted. */
export async function processCancellation(
  id: string,
  createRefund: boolean,
  refundAmount?: number,
  opsNote?: string,
): Promise<void> {
  const userId = await currentUserId();
  const { data: c, error: rErr } = await supabase
    .from('order_cancellations')
    .select('*')
    .eq('id', id)
    .single();
  if (rErr || !c) throw rErr ?? new Error('cancellation not found');

  let refundApprovalId: string | null = null;
  if (createRefund) {
    const { data: ra, error: raErr } = await supabase.from('refund_approvals').insert({
      order_id: null,
      customer_name: c.customer_name,
      customer_email: c.customer_email,
      refund_amount_usd: refundAmount ?? c.order_amount_usd ?? 0,
      payment_method: c.preferred_contact === 'phone' ? 'Credit Card (call to process)' : 'E-Transfer',
      reason: `Order cancellation: ${c.reason ?? 'no reason'}`,
      notes: `Auto-created from order_cancellation ${c.order_ref ?? id}. Customer preferred contact: ${c.preferred_contact ?? '—'}.`,
      status: 'manager_review',
      submitted_by: userId,
    }).select('id').single();
    if (raErr) throw raErr;
    refundApprovalId = (ra as { id: string }).id;
  }

  const { error: upErr } = await supabase.from('order_cancellations').update({
    status: 'completed',
    processed_by: userId,
    processed_at: new Date().toISOString(),
    refund_approval_id: refundApprovalId,
    ops_notes: opsNote ? `${c.ops_notes ?? ''}\n${opsNote}`.trim() : c.ops_notes,
  }).eq('id', id);
  if (upErr) throw upErr;

  await logAction('cancellation_processed', id, refundApprovalId ? `→ refund ${refundApprovalId}` : 'no refund needed');
}
