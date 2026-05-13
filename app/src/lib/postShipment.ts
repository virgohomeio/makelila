import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { logAction } from './activityLog';

// ============================================================================
// Returns
// ============================================================================

export type ReturnStatus =
  | 'created' | 'pickup_scheduled' | 'picked_up' | 'received'
  | 'inspected' | 'refunded' | 'denied' | 'closed';

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
};

export const RETURN_STATUS_ORDER: ReturnStatus[] = [
  'created','pickup_scheduled','picked_up','received','inspected','refunded','denied','closed',
];

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
  await logAction('return_status', id, `→ ${newStatus}`);
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
  | 'refunded' | 'denied' | 'closed';

export const REFUND_STATUS_META: Record<RefundStatus, { label: string; color: string; bg: string; border: string }> = {
  submitted:       { label: 'Submitted',        color: '#4a5568', bg: '#f7fafc', border: '#cbd5e1' },
  manager_review:  { label: 'Manager review',   color: '#2b6cb0', bg: '#ebf8ff', border: '#bee3f8' },
  finance_review:  { label: 'Finance review',   color: '#c05621', bg: '#fffaf0', border: '#fbd38d' },
  refunded:        { label: 'Refunded',         color: '#276749', bg: '#f0fff4', border: '#9ae6b4' },
  denied:          { label: 'Denied',           color: '#9b2c2c', bg: '#fff5f5', border: '#fc8181' },
  closed:          { label: 'Closed',           color: '#718096', bg: '#edf2f7', border: '#cbd5e1' },
};

export type RefundApproval = {
  id: string;
  return_id: string | null;
  order_id: string | null;
  customer_name: string;
  customer_email: string | null;
  refund_amount_usd: number;
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

// Role allowlist for the two approval stages. Once we ship proper RBAC
// these move to a profiles.role column, but for 8 named users a simple
// email list is fine and visible in code review.
export const MANAGER_EMAILS = ['george@virgohome.io', 'huayi@virgohome.io'];
export const FINANCE_EMAILS = ['julie@virgohome.io',  'huayi@virgohome.io'];

export function canApproveManager(email: string | null | undefined): boolean {
  return !!email && MANAGER_EMAILS.includes(email.toLowerCase());
}
export function canApproveFinance(email: string | null | undefined): boolean {
  return !!email && FINANCE_EMAILS.includes(email.toLowerCase());
}

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
  await logAction('refund_submitted', input.customer_name, `$${input.refund_amount_usd} (${input.reason ?? 'no reason'})`);
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

export async function financeApprove(id: string, note?: string): Promise<void> {
  const userId = await currentUserId();
  const { error } = await supabase.from('refund_approvals').update({
    status: 'refunded',
    finance_approved_by: userId,
    finance_approved_at: new Date().toISOString(),
    finance_decision_note: note ?? null,
    refunded_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) throw error;
  await logAction('refund_finance_approved', id, note ?? 'paid');
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
