import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { logAction } from './activityLog';
import { sendTemplate } from './templates';
import {
  invoiceAmountCad, pickRefundBasisInvoice, invoicesForCustomerEmail, type CustomerInvoice,
} from './invoices';

const APP_BASE_URL = 'https://lila.vip';
const REFUND_URL = `${APP_BASE_URL}/post-shipment?tab=refunds`;

/** First name from a VCycene email local-part, for greeting notification
 *  recipients (e.g. 'pedrum@virgohome.io' → 'Pedrum'). */
function firstNameFromEmail(email: string): string {
  const local = email.split('@')[0].split(/[._-]/)[0] ?? email;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

// FR-15: customer greeting — prefer the customer's given name, fall back to the
// email local part. Returns 'there' if we have neither.
function customerFirstName(name: string | null | undefined, email: string | null | undefined): string {
  const fromName = (name ?? '').trim().split(/\s+/)[0];
  if (fromName) return fromName;
  if (email && email.includes('@')) return firstNameFromEmail(email);
  return 'there';
}

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

// FR-2 (Refund & Return Approval PRD): a refund may only be approved once the
// linked return is resolved — the unit has been received/inspected, or the
// customer discarded a genuine-defect unit (BR-7: no physical return, but still
// refundable). Statuses before receipt (created/pickup_scheduled/picked_up) and
// 'denied' block approval. Used by both managerApprove and financeApprove.
export const RETURN_STATUSES_ALLOWING_REFUND: ReturnStatus[] = [
  'received', 'inspected', 'refunded', 'closed', 'discarded',
];

export function returnStatusAllowsRefund(status: ReturnStatus): boolean {
  return RETURN_STATUSES_ALLOWING_REFUND.includes(status);
}

// FR-1 (Refund & Return Approval PRD §4): the two Account-Manager-owned columns
// that precede Manager Review. A return that doesn't yet have a refund request
// lands in one of them by unit status:
//   • "Return Form Submitted" (the PRD's Intake / New stage) — a card just
//     auto-generated from the customer's form, before the unit is physically
//     back: created / pickup_scheduled / picked_up.
//   • "Return & Inspection" — the returned unit is physically back and being
//     inspected: received / inspected.
// Terminal / post-request statuses (refunded, denied, closed, discarded) belong
// to neither pre-refund column and return null.
export const RETURN_INTAKE_STATUSES: ReturnStatus[] = ['created', 'pickup_scheduled', 'picked_up'];
export const RETURN_INSPECTION_STATUSES: ReturnStatus[] = ['received', 'inspected'];

export type PreRefundStage = 'intake' | 'inspection';

export function preRefundStage(status: ReturnStatus): PreRefundStage | null {
  if (RETURN_INTAKE_STATUSES.includes(status)) return 'intake';
  if (RETURN_INSPECTION_STATUSES.includes(status)) return 'inspection';
  return null;
}

// BR-16 (PRD §5.5, v0.2): a return sitting in the Account-Manager stages while we
// wait on the customer must not stall silently. After CUSTOMER_REMIND_DAYS the
// system auto-reminds the customer and the card shows "awaiting customer, day X";
// after CUSTOMER_ESCALATE_DAYS the card is flagged for escalation/closure. These
// are the PRD's default intervals (team may tune later).
export const CUSTOMER_REMIND_DAYS = 7;
export const CUSTOMER_ESCALATE_DAYS = 14;

export type CustomerWaitStage = 'fresh' | 'remind_due' | 'escalate';
export type CustomerWaitState = { days: number; stage: CustomerWaitStage };

export function customerWaitState(
  since: string | null | undefined,
  now: Date = new Date(),
): CustomerWaitState | null {
  if (!since) return null;
  const t = Date.parse(since);
  if (Number.isNaN(t)) return null;
  const days = Math.floor((now.getTime() - t) / 86_400_000);
  const stage: CustomerWaitStage =
    days >= CUSTOMER_ESCALATE_DAYS ? 'escalate' :
    days >= CUSTOMER_REMIND_DAYS ? 'remind_due' : 'fresh';
  return { days, stage };
}

// FR-11 / BR-14 / BR-15: a refund can only be processed against a valid
// purchaser. When the return filer isn't the buyer (is_purchaser=false) we need
// the purchaser's identity AND a proof of purchase — unless the Return Manager
// has manually confirmed linkage (the no-receipt override). is_purchaser true
// (filer is the buyer) or null (ops/legacy return, no attestation collected)
// is not gated.
export type PurchaserLinkageFields = {
  is_purchaser: boolean | null;
  purchaser_name: string | null;
  purchaser_email: string | null;
  purchase_proof: string | null;
  purchaser_linkage_confirmed_at?: string | null;
};

export function hasValidPurchaserLinkage(r: PurchaserLinkageFields | null): boolean {
  if (!r) return true;                                 // nothing to gate on
  if (r.purchaser_linkage_confirmed_at) return true;   // BR-15 manager override
  if (r.is_purchaser !== false) return true;           // filer is the buyer (or ops/legacy)
  const hasIdentity = !!(r.purchaser_name?.trim() || r.purchaser_email?.trim());
  return hasIdentity && !!r.purchase_proof;
}

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
  category_other: string | null;
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
  // Purchaser identity when the return filer isn't the buyer (is_purchaser=false).
  is_purchaser: boolean | null;
  purchaser_name: string | null;
  purchaser_email: string | null;
  purchaser_phone: string | null;
  // FR-11/BR-15: set when the Return Manager overrides the linkage gate.
  purchaser_linkage_confirmed_at: string | null;
  purchaser_linkage_confirmed_by: string | null;
  // BR-16: customer-followup tracking for a return stuck awaiting the customer.
  last_customer_reminder_at: string | null;
  followup_escalated_at: string | null;
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
// FR-14 — return/refund card attachments (paste-to-attach photos)
// Multi-photo attachments on a return, stored in the 'return-documents' bucket
// and recorded in return_attachments. Mirrors the ticket attachment layer.
// ============================================================================
// Photos land in one of two operator-facing sections. 'context' is what opened
// the case (customer-supplied evidence); 'inspection' is what we found once the
// unit was back on the bench. Rows predating the split backfilled to 'context'.
export type ReturnAttachmentCategory = 'context' | 'inspection';

export const RETURN_ATTACH_CATEGORIES: { value: ReturnAttachmentCategory; label: string }[] = [
  { value: 'context', label: 'Context of the Case - Photos' },
  { value: 'inspection', label: 'Inspection Photos' },
];

export type ReturnAttachment = {
  id: string;
  return_id: string;
  file_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  category: ReturnAttachmentCategory;
  uploaded_by: string | null;
  created_at: string;
};

export const RETURN_ATTACH_BUCKET = 'return-documents';
export const RETURN_ATTACH_MAX_BYTES = 25 * 1024 * 1024; // 25 MB
export const RETURN_ATTACH_ALLOWED_MIME = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'application/pdf',
];
export const RETURN_ATTACH_INPUT_ACCEPT = RETURN_ATTACH_ALLOWED_MIME.join(',');

export function useReturnAttachments(returnId: string | null): { attachments: ReturnAttachment[]; loading: boolean; refresh: () => void } {
  const [attachments, setAttachments] = useState<ReturnAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick(t => t + 1);

  useEffect(() => {
    if (!returnId) { setAttachments([]); setLoading(false); return; }
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('return_attachments')
        .select('*')
        .eq('return_id', returnId)
        .order('created_at', { ascending: true });
      if (cancelled) return;
      setAttachments((data ?? []) as ReturnAttachment[]);
      setLoading(false);
      channel = supabase
        .channel(`return_attachments:${returnId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'return_attachments', filter: `return_id=eq.${returnId}` },
          () => refresh())
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) supabase.removeChannel(channel); };
  }, [returnId, tick]);

  return { attachments, loading, refresh };
}

export async function uploadReturnAttachment(
  returnId: string,
  file: File,
  category: ReturnAttachmentCategory = 'context',
): Promise<ReturnAttachment> {
  if (file.type && !RETURN_ATTACH_ALLOWED_MIME.includes(file.type)) {
    throw new Error(`Unsupported file type: ${file.type}`);
  }
  if (file.size > RETURN_ATTACH_MAX_BYTES) {
    throw new Error(`File is too large (max ${Math.round(RETURN_ATTACH_MAX_BYTES / (1024 * 1024))} MB).`);
  }
  const path = `${returnId}/attach-${crypto.randomUUID()}-${file.name}`;
  const { error: upErr } = await supabase.storage
    .from(RETURN_ATTACH_BUCKET)
    .upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (upErr) throw upErr;

  const userId = await currentUserId();
  const { data, error } = await supabase.from('return_attachments').insert({
    return_id: returnId, file_path: path, file_name: file.name,
    mime_type: file.type || null, size_bytes: file.size, category, uploaded_by: userId,
  }).select('*').single();
  if (error) {
    await supabase.storage.from(RETURN_ATTACH_BUCKET).remove([path]).then(() => {}, () => {});
    throw error;
  }
  await logAction('return_attachment_added', returnId, `${file.name} (${category})`, { entityType: 'return', entityId: returnId });
  return data as ReturnAttachment;
}

export async function deleteReturnAttachment(att: ReturnAttachment): Promise<void> {
  const { error } = await supabase.from('return_attachments').delete().eq('id', att.id);
  if (error) throw error;
  await supabase.storage.from(RETURN_ATTACH_BUCKET).remove([att.file_path]).then(() => {}, () => {});
  await logAction('return_attachment_removed', att.return_id, att.file_name, { entityType: 'return', entityId: att.return_id });
}

export async function returnAttachmentSignedUrl(filePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(RETURN_ATTACH_BUCKET).createSignedUrl(filePath, 3600);
  if (error || !data) throw error ?? new Error('Could not sign attachment URL');
  return data.signedUrl;
}

// ============================================================================
// FR-13 — one-click return-shipping label + courier pickup (Freightcom).
// Invokes the book-return-label edge function, which quotes + books a return
// shipment (customer → warehouse) and stamps the return's pickup fields.
//
// ⚠ UNWIRED as of 2026-08-04 — no caller. The "Generate return label" button was
// removed from RefundsTab because the edge fn reads `orders.address_postal_code`,
// a column that does not exist (real columns: postal_code / address_customer_postal
// / address_google_postal), so every click 400'd with "No customer postal code on
// file". Kept in the tree for the backlog item; see
// docs/feature-backlog-alpha-feedback.md → "FR-13 return shipping label (parked)".
// ============================================================================
export type ReturnLabelResult = { label_url: string | null; tracking: string | null; carrier: string; service: string };

export async function bookReturnLabel(returnId: string): Promise<ReturnLabelResult> {
  const { data, error } = await supabase.functions.invoke('book-return-label', { body: { return_id: returnId } });
  if (error) {
    // Surface the edge function's JSON error message when available.
    let msg = error.message;
    try {
      const ctx = (error as { context?: { json?: () => Promise<{ error?: string }> } }).context;
      const body = ctx?.json ? await ctx.json() : null;
      if (body?.error) msg = body.error;
    } catch { /* keep generic message */ }
    throw new Error(msg);
  }
  const result = data as ReturnLabelResult & { error?: string };
  if (result?.error) throw new Error(result.error);
  await logAction('return_label_booked', returnId, `${result.carrier ?? ''} ${result.tracking ?? ''}`.trim() || 'booked',
    { entityType: 'return', entityId: returnId });
  return result;
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

// FR-9 queue routing. A refund entering the Refund Queue is executed by the
// payments operator (Shopify + Sezzle/BNPL, per Stage 8) or the finance officer
// (card / bank / other). These are the current role-holders — routing keys off
// the role, so swapping a holder is a one-line change here.
export const REFUND_EXECUTORS = {
  payments: 'pedrum@virgohome.io',   // payments operator (Shopify + BNPL)
  finance:  'yueli@virgohome.io',    // finance officer (Julie)
} as const;

export function refundExecutorEmail(method: RefundMethod | null): string {
  return method === 'shopify' || method === 'sezzle'
    ? REFUND_EXECUTORS.payments
    : REFUND_EXECUTORS.finance;
}

// FR-12 fee breakdown (BR-9/BR-10, honouring current terms per OQ-1). The
// restocking fee defaults to $50; return shipping is operator-entered actual
// cost (OQ-2 resolved as actual, not fixed). Both are waived for genuine-defect
// cases (BR-7). computeRefundNet derives the payout from the gross minus fees.
export const DEFAULT_RESTOCKING_FEE = 50;

export function computeRefundNet(gross: number, restocking: number, returnShipping: number): number {
  const net = Number(gross) - (Number(restocking) || 0) - (Number(returnShipping) || 0);
  return Math.max(0, Math.round(net * 100) / 100);
}

export function defaultRefundFees(isDefect: boolean): { restocking: number; returnShipping: number } {
  return { restocking: isDefect ? 0 : DEFAULT_RESTOCKING_FEE, returnShipping: 0 };
}

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
  // FR-12 fee breakdown (how the net payout was derived).
  restocking_fee_usd: number | null;
  return_shipping_fee_usd: number | null;
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
  // Omit author_id when we don't have it so the DB default (auth.uid()) fills
  // it — never send an explicit null, which would defeat the default and (under
  // the old policy) silently reject the insert. Notes must always save.
  const payload: Record<string, unknown> = { refund_id: refundId, body: body.trim(), author_name: authorName };
  if (user?.id) payload.author_id = user.id;
  const { error } = await supabase.from('refund_notes').insert(payload);
  if (error) throw error;
  await logAction('refund_note_added', refundId, body.trim().slice(0, 120));
}

// Notes on a pre-refund return card (Return Form Submitted / Return &
// Inspection). Mirrors the refund-note layer; any internal user can add.
export type ReturnNote = {
  id: string;
  return_id: string;
  body: string;
  author_id: string | null;
  author_name: string | null;
  created_at: string;
};

export function useReturnNotes(returnId: string | null): {
  notes: ReturnNote[]; loading: boolean; refresh: () => void;
} {
  const [notes, setNotes] = useState<ReturnNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!returnId) { setNotes([]); setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from('return_notes')
        .select('*')
        .eq('return_id', returnId)
        .order('created_at', { ascending: true });
      if (!cancelled) { setNotes((data ?? []) as ReturnNote[]); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [returnId, tick]);

  return { notes, loading, refresh: () => setTick(t => t + 1) };
}

export async function addReturnNote(returnId: string, body: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  let authorName: string | null = null;
  if (user) {
    const { data: prof } = await supabase.from('profiles').select('display_name').eq('id', user.id).maybeSingle();
    authorName = (prof as { display_name?: string } | null)?.display_name ?? user.email ?? null;
  }
  // Omit author_id when absent so the DB default (auth.uid()) fills it — never
  // send an explicit null. Notes must always save.
  const payload: Record<string, unknown> = { return_id: returnId, body: body.trim(), author_name: authorName };
  if (user?.id) payload.author_id = user.id;
  const { error } = await supabase.from('return_notes').insert(payload);
  if (error) throw error;
  await logAction('return_note_added', returnId, body.trim().slice(0, 120), { entityType: 'return', entityId: returnId });
}

export async function deleteReturnNote(noteId: string, returnId: string): Promise<void> {
  const { error } = await supabase.from('return_notes').delete().eq('id', noteId);
  if (error) throw error;
  await logAction('return_note_deleted', returnId, 'removed a note', { entityType: 'return', entityId: returnId });
}

export async function deleteRefundNote(noteId: string, refundId: string): Promise<void> {
  const { error } = await supabase.from('refund_notes').delete().eq('id', noteId);
  if (error) throw error;
  await logAction('refund_note_deleted', refundId, noteId);
}

// Edit a note you authored (RLS lets an author update only their own note).
export async function updateReturnNote(noteId: string, returnId: string, body: string): Promise<void> {
  const { error } = await supabase.from('return_notes').update({ body: body.trim() }).eq('id', noteId);
  if (error) throw error;
  await logAction('return_note_edited', returnId, body.trim().slice(0, 120), { entityType: 'return', entityId: returnId });
}

export async function updateRefundNote(noteId: string, refundId: string, body: string): Promise<void> {
  const { error } = await supabase.from('refund_notes').update({ body: body.trim() }).eq('id', noteId);
  if (error) throw error;
  await logAction('refund_note_edited', refundId, body.trim().slice(0, 120));
}

// ── Unified "case" notes ────────────────────────────────────────────────────
// A refund card and its underlying return are the SAME case; the refund row is
// transient (created on compile, deleted on uncompile) but the return persists.
// So for a return-linked case, notes are anchored to the RETURN. Every view of
// the case (return card, refund card at any stage, detail modals) reads the
// union of the return's notes and any legacy refund-side notes, and NEW notes
// are written to the return. Result: moving a card to Completeness (or back)
// changes nothing about its notes and can never lose them. Direct refunds with
// no return fall back to refund_notes.
export type CaseNote = {
  id: string; body: string; author_id: string | null; author_name: string | null;
  created_at: string; source: 'return' | 'refund';
};

export function useCaseNotes(refundId: string | null, returnId: string | null): {
  notes: CaseNote[]; loading: boolean; refresh: () => void;
} {
  const rn = useReturnNotes(returnId);
  const fn = useRefundNotes(refundId);
  const notes: CaseNote[] = [
    ...rn.notes.map(n => ({ ...n, source: 'return' as const })),
    ...fn.notes.map(n => ({ id: n.id, body: n.body, author_id: n.author_id, author_name: n.author_name, created_at: n.created_at, source: 'refund' as const })),
  ].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return { notes, loading: rn.loading || fn.loading, refresh: () => { rn.refresh(); fn.refresh(); } };
}

// New notes anchor to the return when the case has one, so they survive the
// refund row being deleted on uncompile.
export async function addCaseNote(refundId: string | null, returnId: string | null, body: string): Promise<void> {
  if (returnId) return addReturnNote(returnId, body);
  if (refundId) return addRefundNote(refundId, body);
  throw new Error('addCaseNote: neither returnId nor refundId provided');
}

export async function updateCaseNote(note: CaseNote, refundId: string | null, returnId: string | null, body: string): Promise<void> {
  if (note.source === 'return' && returnId) return updateReturnNote(note.id, returnId, body);
  if (refundId) return updateRefundNote(note.id, refundId, body);
  throw new Error('updateCaseNote: no target for note');
}

export async function deleteCaseNote(note: CaseNote, refundId: string | null, returnId: string | null): Promise<void> {
  if (note.source === 'return' && returnId) return deleteReturnNote(note.id, returnId);
  if (refundId) return deleteRefundNote(note.id, refundId);
  throw new Error('deleteCaseNote: no target for note');
}

async function currentUserId(): Promise<string> {
  // Prefer the locally-cached session (no network) — getUser() makes a round-trip
  // to the auth server that can transiently fail on a valid session and abort an
  // approval before it runs (looks like "can't move the card"). Fall back to the
  // network call only if there's no cached session. Mirrors logAction().
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) return session.user.id;
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
  currency?: RefundCurrency;
  payment_method?: string;
  reason?: string;
  notes?: string;
}): Promise<string> {
  const userId = await currentUserId();
  const { data: created, error } = await supabase.from('refund_approvals').insert({
    ...input,
    // FR-3: land in Completeness/prep, not straight in front of the Return
    // Manager. The Account Manager verifies the case, then calls submitToManager.
    status: 'submitted',
    submitted_by: userId,
  }).select('id').single();
  if (error) throw error;
  const newRefundId = (created as { id: string }).id;
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

  // FR-15 (revised 2026-08-04): NO customer email here. Compiling a case into
  // the refund pipeline is an internal move — the customer already got the
  // return-form confirmation from send-return-emails, and the only other
  // automatic customer email in this workflow is the one at Refunded
  // (executeRefund). See "Refund workflow customer emails" in
  // docs/feature-backlog-alpha-feedback.md.
  return newRefundId;
}

// A note row as stored on either notes table, minus the id/target — used to
// carry notes across the compile/uncompile boundary so none are ever lost.
type PortableNote = { body: string; author_id: string | null; author_name: string | null; created_at: string };

/** The opening refund amount for a case: what the customer actually paid on
 *  their sales invoice, in CAD (invoices are issued in CAD). Falls back to any
 *  amount already recorded on the return, which is denominated in USD.
 *
 *  Every card used to open at $0.00 because this read the return's
 *  refund_amount_usd and nothing else — it is null on most returns, and the
 *  invoice was never consulted. Finance still confirms and can edit the figure;
 *  this only saves them re-keying it off the PDF. */
export async function defaultRefundAmountFromInvoice(
  email: string | null | undefined,
  orderRef: string | null | undefined,
  fallbackUsd: number | null | undefined,
): Promise<{ amount: number; currency: RefundCurrency; invoice: CustomerInvoice | null }> {
  if (email?.trim()) {
    try {
      const invoices = await invoicesForCustomerEmail(email);
      const basis = pickRefundBasisInvoice(invoices, orderRef);
      const amount = basis ? invoiceAmountCad(basis) : null;
      if (basis && amount != null) return { amount, currency: 'CAD', invoice: basis };
    } catch (e) {
      // A lookup failure must not block compiling the case — the operator can
      // always type the amount in.
      console.warn('refund amount from invoice failed (non-fatal):', (e as Error).message);
    }
  }
  return { amount: Number(fallbackUsd ?? 0), currency: 'USD', invoice: null };
}

/** Compile a return into a refund request in the Completeness column, opening
 *  at the amount the customer paid on their sales invoice (CAD). Finance
 *  (Julie) confirms or corrects it — and the payment method — at Finance
 *  Review, then it carries to Pedrum in the Refund Queue. Auto-fills the
 *  purchaser/customer from the return. */
export async function compileReturnToRefund(r: ReturnRow): Promise<void> {
  const usePurchaser = r.is_purchaser === false;
  const email = ((usePurchaser && r.purchaser_email?.trim()) ? r.purchaser_email.trim() : r.customer_email) ?? undefined;
  const opening = await defaultRefundAmountFromInvoice(email, r.original_order_ref, r.refund_amount_usd);
  const refundId = await submitRefundRequest({
    return_id: r.id,
    // NOTE: don't pass order_id — that column is a UUID FK to orders(id), not the
    // human original_order_ref (e.g. "#1107"). The refund links via return_id.
    customer_name: (usePurchaser && r.purchaser_name?.trim()) ? r.purchaser_name.trim() : r.customer_name,
    customer_email: email,
    refund_amount_usd: opening.amount,
    currency: opening.currency,
    reason: r.reason ?? undefined,
    // no payment_method — Finance sets the method at Finance Review.
  });
  if (opening.invoice) {
    await logAction('refund_amount_from_invoice', refundId,
      `$${opening.amount.toFixed(2)} CAD from invoice #${opening.invoice.invoice_number}`);
  }
  // No note copying needed: the case's notes stay on the return and every refund
  // view reads them via useCaseNotes, so the card is unchanged after compile.
  void refundId;
}

// FR-15: standardized customer-facing status message at a refund transition.
// Best-effort (never throws into the caller); no-ops when we have no email.
//
// ⚠ As of 2026-08-04 there is exactly ONE caller: executeRefund (→ Refunded).
// Per operator decision, the customer hears from us twice in this workflow —
// the return-form confirmation (send-return-emails) and the refund-sent notice.
// Do not add transition emails here without that decision being revisited.
async function notifyCustomerRefundStatus(
  templateKey: string,
  c: { email?: string | null; name?: string | null; amount?: number | null; method?: RefundMethod | null; relatedRefundId?: string },
): Promise<void> {
  const to = (c.email ?? '').trim();
  if (!to) return;
  try {
    await sendTemplate({
      template_key: templateKey,
      to,
      to_name: customerFirstName(c.name, to),
      variables: {
        customer_first_name: customerFirstName(c.name, to),
        amount: (c.amount != null && Number(c.amount) > 0) ? `$${Number(c.amount).toFixed(2)}` : 'your refund',
        method: c.method ? REFUND_METHOD_META[c.method].label : 'your original payment method',
      },
      ...(c.relatedRefundId ? { related_refund_id: c.relatedRefundId } : {}),
    });
  } catch (e) {
    console.warn(`FR-15 customer status email (${templateKey}) failed (non-fatal):`, (e as Error).message);
  }
}

/** Edit a refund's dollar amount directly from the card, at any stage.
 *  Approvers (manager/finance) use this to correct the amount without having
 *  to advance the refund through the approval action. */
export async function updateRefundAmount(id: string, amount: number): Promise<void> {
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Amount must be a non-negative number');
  const rounded = Math.round(amount * 100) / 100;
  const { error } = await supabase.from('refund_approvals')
    .update({ refund_amount_usd: rounded }).eq('id', id);
  if (error) throw error;
  await logAction('refund_amount_edited', id, `$${rounded.toFixed(2)}`);
}

export type RefundCurrency = 'USD' | 'CAD';
/** Set the currency the refund amount is denominated in (label only — the value
 *  isn't converted). */
export async function setRefundCurrency(id: string, currency: RefundCurrency): Promise<void> {
  const { error } = await supabase.from('refund_approvals')
    .update({ currency }).eq('id', id);
  if (error) throw error;
  await logAction('refund_currency_set', id, currency);
}

/** FR-3: the Account Manager advances a prepared case from Completeness
 *  ('submitted') to Manager Review. Explicit "Submit", distinct from the
 *  Manager's "Approve" — so incomplete cases never sit in front of the Return
 *  Manager. */
export async function submitToManager(id: string): Promise<void> {
  const { data: approval, error: aErr } = await supabase
    .from('refund_approvals')
    .select('id, status')
    .eq('id', id)
    .single();
  if (aErr || !approval) throw new Error(`Refund approval not found: ${aErr?.message}`);
  if (approval.status !== 'submitted') {
    throw new Error(`Cannot submit to manager from status: ${approval.status}`);
  }
  const { error } = await supabase.from('refund_approvals')
    .update({ status: 'manager_review' }).eq('id', id);
  if (error) throw error;
  await logAction('refund_submitted_to_manager', id, 'submitted to manager review');
}

/** FR-11 / BR-15 override: the Return Manager manually confirms purchaser
 *  linkage for a legitimate no-receipt case, clearing the linkage gate so the
 *  refund can proceed. Mirrors the BR-3 30-day exception process. */
export async function confirmPurchaserLinkage(returnId: string): Promise<void> {
  const userId = await currentUserId();
  const { error } = await supabase.from('returns').update({
    purchaser_linkage_confirmed_at: new Date().toISOString(),
    purchaser_linkage_confirmed_by: userId,
  }).eq('id', returnId);
  if (error) throw error;
  await logAction('return_purchaser_linkage_confirmed', returnId, 'manager confirmed purchaser linkage');
}

export async function managerApprove(id: string, note?: string): Promise<void> {
  const userId = await currentUserId();

  // FR-2 gate: block Manager Review approval unless the linked return is
  // resolved (received/inspected/discarded/…). This mirrors the guard in
  // financeApprove so incomplete cards never reach — or pass — the Return
  // Manager, rather than only being caught one stage later at Finance Review.
  const { data: approval, error: aErr } = await supabase
    .from('refund_approvals')
    .select('id, return_id, customer_email, customer_name, refund_amount_usd')
    .eq('id', id)
    .single();
  if (aErr || !approval) throw new Error(`Refund approval not found: ${aErr?.message}`);
  if (approval.return_id) {
    const { data: ret, error: rErr } = await supabase
      .from('returns')
      .select('id, status, is_purchaser, purchaser_name, purchaser_email, purchase_proof, purchaser_linkage_confirmed_at')
      .eq('id', approval.return_id)
      .single();
    if (rErr || !ret) throw new Error(`Linked return not found: ${rErr?.message}`);
    if (!returnStatusAllowsRefund(ret.status)) {
      throw new Error(`Return is in status '${ret.status}' — approval is blocked until the unit is received/inspected (or the customer discards a defective unit).`);
    }
    // FR-11 / BR-14 / BR-15: don't refund the wrong party.
    if (!hasValidPurchaserLinkage(ret)) {
      throw new Error(`Purchaser linkage is unverified — the filer isn't the buyer and no purchaser identity + receipt is on file. Confirm linkage (manager override) before approving.`);
    }
  }

  const { error } = await supabase.from('refund_approvals').update({
    status: 'finance_review',
    manager_approved_by: userId,
    manager_approved_at: new Date().toISOString(),
    manager_decision_note: note ?? null,
  }).eq('id', id);
  if (error) throw error;
  await logAction('refund_manager_approved', id, note ?? 'approved');
  // FR-15 (revised 2026-08-04): no customer email on manager approval — an
  // internal stage move. The customer is told once, at Refunded.
}

export type FinanceApproveOpts = {
  method: RefundMethod;
  amount?: number;             // if omitted, keep original
  correction_note?: string;    // required if amount differs from original
  note?: string;               // free-form optional note (e.g. Stripe refund ID)
  restocking_fee?: number;     // FR-12: recorded on the card for the audit trail
  return_shipping_fee?: number;
};

export async function financeApprove(id: string, opts: FinanceApproveOpts): Promise<void> {
  const userId = await currentUserId();

  // 1. Fetch the approval row to validate + read original amount
  const { data: approval, error: aErr } = await supabase
    .from('refund_approvals')
    .select('id, return_id, original_amount_usd, refund_amount_usd, status, customer_email, customer_name')
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
    if (!returnStatusAllowsRefund(ret.status)) {
      throw new Error(`Return is in status '${ret.status}' — refund cannot be processed until the unit is received (or the customer discards a defective unit).`);
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
    // FR-12: record the fee breakdown behind the net payout (null = not set).
    restocking_fee_usd: opts.restocking_fee ?? null,
    return_shipping_fee_usd: opts.return_shipping_fee ?? null,
  };
  const { error: upErr } = await supabase
    .from('refund_approvals')
    .update(updatePatch)
    .eq('id', id);
  if (upErr) throw upErr;

  // Best-effort audit log — the approval has already committed above, so a log
  // failure (e.g. a momentary session gap) must NEVER surface as an approval
  // failure or the card looks stuck when it actually moved.
  try {
    await logAction('refund_finance_approved', id, `${opts.method} $${adjusted.toFixed(2)}`);
  } catch (e) {
    console.warn('Refund finance-approve audit log failed (non-fatal):', (e as Error).message);
  }

  // FR-9a: notify the executor that a refund is queued for payout. Best-effort —
  // a mail failure must never roll back the approval (mirrors the ticket-
  // assignment email). Shopify/Sezzle → payments operator, else finance officer.
  const executorEmail = refundExecutorEmail(opts.method);
  try {
    await sendTemplate({
      template_key: 'refund_queued_executor',
      to: executorEmail,
      to_name: firstNameFromEmail(executorEmail),
      variables: {
        executor_first_name: firstNameFromEmail(executorEmail),
        customer_name: approval.customer_name ?? approval.customer_email ?? 'Unknown customer',
        amount: `$${adjusted.toFixed(2)}`,
        method: REFUND_METHOD_META[opts.method].label,
        refund_url: REFUND_URL,
      },
      related_refund_id: id,
    });
  } catch (e) {
    console.warn('Refund queue-entry email failed (non-fatal):', (e as Error).message);
  }
  // FR-15 (revised 2026-08-04): no customer email when the card enters the
  // Refund Queue — internal only (the executor notice above). The customer is
  // told once, at Refunded.
}

/** Refund Queue → Refunded. Finance has already approved the case + amount; this
 *  is the operator actually executing the payout and marking it done. The Klaviyo
 *  "Refund Processed" event fires here — the moment money actually moves — not at
 *  finance approval. */
export async function executeRefund(id: string, note?: string): Promise<void> {
  const { data: approval, error: aErr } = await supabase
    .from('refund_approvals')
    .select('id, status, customer_email, customer_name, refund_amount_usd, refund_method, submitted_by')
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

  // FR-9b: notify the Account Manager (the case owner who submitted it) that the
  // payout is done, so they can tell the customer. Best-effort — never blocks
  // the executed refund.
  if (approval.submitted_by) {
    try {
      const { data: amProfile } = await supabase
        .from('profiles').select('email').eq('id', approval.submitted_by).maybeSingle();
      const amEmail = (amProfile as { email?: string } | null)?.email;
      if (amEmail) {
        await sendTemplate({
          template_key: 'refund_executed_am',
          to: amEmail,
          to_name: firstNameFromEmail(amEmail),
          variables: {
            am_first_name: firstNameFromEmail(amEmail),
            customer_name: approval.customer_name ?? approval.customer_email ?? 'the customer',
            amount: `$${Number(approval.refund_amount_usd).toFixed(2)}`,
            method: approval.refund_method ? REFUND_METHOD_META[approval.refund_method as RefundMethod].label : '—',
            refund_url: REFUND_URL,
          },
          related_refund_id: id,
        });
      }
    } catch (e) {
      console.warn('Refund completion email failed (non-fatal):', (e as Error).message);
    }
  }

  // FR-15 (revised 2026-08-04): the ONLY automatic customer email in the refund
  // workflow after the return-form confirmation — sent when the card lands in
  // Refunded, telling them to expect the money in 7–10 business days.
  await notifyCustomerRefundStatus('refund_funds_sent_customer', {
    email: approval.customer_email as string | null,
    name: approval.customer_name as string | null,
    amount: approval.refund_amount_usd as number | null,
    method: (approval.refund_method as RefundMethod | null) ?? null,
    relatedRefundId: id,
  });
}

export async function denyRefund(id: string, stage: 'submitted' | 'manager_review' | 'finance_review' | 'refund_queue', reason: string): Promise<void> {
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

// Send a refund card BACK to an earlier column (e.g. Manager → Completeness when
// there isn't enough information). Clears the approval stamps for every stage
// at/after the target so the trail stays honest. Available to everyone involved.
export type RefundBackTarget = 'submitted' | 'manager_review' | 'finance_review';

export function refundBackPatch(toStatus: RefundBackTarget): Record<string, unknown> {
  const patch: Record<string, unknown> = { status: toStatus };
  // Any target is at/below the finance stage, so the finance decision is undone.
  patch.finance_approved_by = null;
  patch.finance_approved_at = null;
  patch.finance_decision_note = null;
  // Going all the way back to Completeness also undoes the manager approval.
  if (toStatus === 'submitted') {
    patch.manager_approved_by = null;
    patch.manager_approved_at = null;
    patch.manager_decision_note = null;
  }
  return patch;
}

export async function sendRefundBack(id: string, toStatus: RefundBackTarget): Promise<void> {
  const { error } = await supabase.from('refund_approvals').update(refundBackPatch(toStatus)).eq('id', id);
  if (error) throw error;
  await logAction('refund_sent_back', id, `→ ${toStatus}`);
}

// "Uncompile" — remove the refund request so the case returns to Return &
// Inspection (the linked return row stays). Used to move a Completeness card
// back a column. Notes are NEVER lost: any notes on the refund are copied onto
// the linked return before the refund row (and its cascading notes) is removed.
export async function uncompileRefund(id: string, returnId?: string | null): Promise<void> {
  if (returnId) {
    const { data: notes, error: readErr } = await supabase
      .from('refund_notes')
      .select('body, author_id, author_name, created_at')
      .eq('refund_id', id)
      .order('created_at', { ascending: true });
    if (readErr) throw readErr;
    if (notes && notes.length) {
      // Skip notes already on the return (those carried over at compile time),
      // matched by their preserved created_at, so round-tripping a card fwd/back
      // never duplicates a note. Only refund-side additions come back.
      const { data: existing } = await supabase
        .from('return_notes').select('created_at').eq('return_id', returnId);
      const seen = new Set(((existing ?? []) as { created_at: string }[]).map(e => e.created_at));
      const rows = (notes as PortableNote[])
        .filter(n => !seen.has(n.created_at))
        .map(n => ({ return_id: returnId, body: n.body, author_id: n.author_id, author_name: n.author_name, created_at: n.created_at }));
      if (rows.length) {
        const { error: copyErr } = await supabase.from('return_notes').insert(rows);
        if (copyErr) throw copyErr;
      }
    }
  }
  const { error } = await supabase.from('refund_approvals').delete().eq('id', id);
  if (error) throw error;
  await logAction('refund_uncompiled', id, 'returned to Return & Inspection (notes preserved on the return)');
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

/** Auto-queueing starts here: only cancellation forms submitted on or after the
 *  day this shipped become refund cards. The rows already sitting in the table
 *  (old test submissions, requests handled off-system months ago) are not
 *  refunds anyone still owes — they stay in the Cancellations tab and never
 *  appear on the Refunds board. */
export const CANCELLATION_QUEUE_START = '2026-08-12T00:00:00Z';

/** The cancellation forms waiting to be turned into a refund. A customer
 *  cancellation is a refund request the moment it's submitted — the same way a
 *  return form is — so every 'submitted' row with no refund_approval_id yet is
 *  a live card on the Refunds board's first column. Once processed (refund
 *  compiled, or dismissed as "no money collected") the row drops out. */
export function pendingCancellationRefunds(
  rows: OrderCancellation[],
  since: string = CANCELLATION_QUEUE_START,
): OrderCancellation[] {
  // Parse rather than string-compare: PostgREST timestamps carry an offset
  // ('+00:00') that a lexicographic compare against a 'Z' cutoff gets wrong.
  const cutoff = Date.parse(since);
  return rows
    .filter(c => c.status === 'submitted' && !c.refund_approval_id
                 && !Number.isNaN(Date.parse(c.created_at))
                 && Date.parse(c.created_at) >= cutoff)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Compile a cancellation into a refund request in the Completeness column —
 *  the cancellation-side twin of compileReturnToRefund. Opens at what the
 *  customer paid on their sales invoice (CAD) unless an amount is passed. */
async function createCancellationRefund(
  c: OrderCancellation,
  refundAmount?: number,
): Promise<string> {
  // No amount typed in → open at what they paid on the sales invoice (CAD),
  // same as a return-compiled card, rather than at $0.00.
  const opening = refundAmount != null
    ? { amount: refundAmount, currency: 'USD' as RefundCurrency }
    : await defaultRefundAmountFromInvoice(c.customer_email, c.order_ref, c.order_amount_usd);
  // Goes through submitRefundRequest so a cancellation-born card is
  // indistinguishable from a return-born one: it lands in Completeness
  // (status 'submitted') for the Account Manager to verify before George sees
  // it, rather than jumping the queue straight into Manager Review.
  return submitRefundRequest({
    customer_name: c.customer_name,
    customer_email: c.customer_email,
    refund_amount_usd: opening.amount,
    currency: opening.currency,
    payment_method: c.preferred_contact === 'phone' ? 'Credit Card (call to process)' : 'E-Transfer',
    reason: `Order cancellation: ${c.reason ?? 'no reason'}`,
    notes: `Auto-created from order_cancellation ${c.order_ref ?? c.id}. Customer preferred contact: ${c.preferred_contact ?? '—'}.`,
  });
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
    refundApprovalId = await createCancellationRefund(c as OrderCancellation, refundAmount);
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

/** Refunds-board action on a cancellation card: compile it into a refund
 *  request in Completeness and close out the cancellation. Thin wrapper over
 *  processCancellation so both entry points (Refunds board, Cancellations tab)
 *  write exactly the same rows. */
export async function compileCancellationToRefund(c: OrderCancellation): Promise<void> {
  await processCancellation(c.id, true);
}

/** Refunds-board action on a cancellation card: no money to give back (e.g.
 *  the order was never charged). Closes the cancellation without a refund. */
export async function dismissCancellationRefund(c: OrderCancellation, opsNote?: string): Promise<void> {
  await processCancellation(c.id, false, undefined, opsNote);
}
