import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { logAction } from './activityLog';

// ============================================================ Types

export type TicketCategory = 'onboarding' | 'support' | 'repair';
export type TicketSource =
  | 'calendly' | 'customer_form' | 'hubspot' | 'fulfillment_flag' | 'ops_manual';
export type TicketStatus =
  | 'new' | 'triaging' | 'in_progress' | 'waiting_customer'
  | 'resolved' | 'closed' | 'escalated';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type OnboardingStatus =
  | 'not_scheduled' | 'scheduled' | 'completed' | 'no_show' | 'skipped';

export type ServiceTicket = {
  id: string;
  ticket_number: string;
  category: TicketCategory;
  source: TicketSource;
  status: TicketStatus;
  priority: TicketPriority;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  unit_serial: string | null;
  order_ref: string | null;
  subject: string;
  description: string | null;
  internal_notes: string | null;
  defect_category: string | null;
  parts_needed: string | null;
  calendly_event_uri: string | null;
  calendly_event_start: string | null;
  calendly_host_email: string | null;
  hubspot_ticket_id: string | null;
  fulfillment_queue_id: string | null;
  owner_email: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CustomerLifecycle = {
  id: string;
  customer_id: string | null;
  unit_serial: string;
  shipped_at: string;
  onboarding_status: OnboardingStatus;
  onboarding_completed_at: string | null;
  warranty_months: number;
  warranty_expires_at: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type TicketAttachment = {
  id: string;
  ticket_id: string;
  file_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
  uploaded_by: string | null;
};

// ============================================================ Display metadata

export const CATEGORY_META: Record<TicketCategory, { label: string; color: string; bg: string }> = {
  onboarding: { label: 'Onboarding', color: '#276749', bg: '#f0fff4' },
  support:    { label: 'Support',    color: '#2b6cb0', bg: '#ebf8ff' },
  repair:     { label: 'Repair',     color: '#c05621', bg: '#fffaf0' },
};

export const STATUS_META: Record<TicketStatus, { label: string; color: string; bg: string }> = {
  new:              { label: 'New',              color: '#2b6cb0', bg: '#ebf8ff' },
  triaging:         { label: 'Triaging',         color: '#553c9a', bg: '#faf5ff' },
  in_progress:      { label: 'In progress',      color: '#c05621', bg: '#fffaf0' },
  waiting_customer: { label: 'Waiting customer', color: '#718096', bg: '#f7fafc' },
  resolved:         { label: 'Resolved',         color: '#276749', bg: '#f0fff4' },
  closed:           { label: 'Closed',           color: '#a0aec0', bg: '#edf2f7' },
  escalated:        { label: 'Escalated',        color: '#c53030', bg: '#fff5f5' },
};

export const PRIORITY_META: Record<TicketPriority, { label: string; color: string }> = {
  low:    { label: 'Low',    color: '#718096' },
  normal: { label: 'Normal', color: '#2b6cb0' },
  high:   { label: 'High',   color: '#c05621' },
  urgent: { label: 'Urgent', color: '#c53030' },
};

export const SOURCE_LABEL: Record<TicketSource, string> = {
  calendly:         'Calendly',
  customer_form:    'Form',
  hubspot:          'HubSpot',
  fulfillment_flag: 'Fulfillment',
  ops_manual:       'Manual',
};

// Allowed next-states for the state machine (UI gating)
export const NEXT_STATUSES: Record<TicketStatus, TicketStatus[]> = {
  new:              ['triaging', 'in_progress', 'escalated'],
  triaging:         ['in_progress', 'waiting_customer', 'escalated', 'resolved'],
  in_progress:      ['waiting_customer', 'resolved', 'escalated'],
  waiting_customer: ['in_progress', 'resolved'],
  resolved:         ['closed', 'in_progress'],   // re-open if needed
  closed:           ['in_progress'],              // re-open
  escalated:        ['in_progress', 'resolved'],
};

// Warranty helpers
export function warrantyState(lifecycle: Pick<CustomerLifecycle, 'warranty_expires_at'> | null | undefined):
  { state: 'active' | 'expired' | 'na'; daysFromNow: number } {
  if (!lifecycle) return { state: 'na', daysFromNow: 0 };
  const expiresMs = new Date(lifecycle.warranty_expires_at).getTime();
  const nowMs = Date.now();
  const days = Math.round((expiresMs - nowMs) / 86400000);
  return { state: days >= 0 ? 'active' : 'expired', daysFromNow: days };
}

// ============================================================ Hooks

export function useServiceTickets(category?: TicketCategory): {
  tickets: ServiceTicket[];
  loading: boolean;
} {
  const [tickets, setTickets] = useState<ServiceTicket[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      let q = supabase
        .from('service_tickets')
        .select('*')
        .order('created_at', { ascending: false });
      if (category) q = q.eq('category', category);
      const { data, error } = await q;
      if (cancelled) return;
      if (!error && data) setTickets(data as ServiceTicket[]);
      setLoading(false);

      channel = supabase
        .channel(`service_tickets:${category ?? 'all'}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'service_tickets' }, (payload) => {
          setTickets(prev => {
            if (payload.eventType === 'DELETE' && payload.old) {
              return prev.filter(t => t.id !== (payload.old as { id: string }).id);
            }
            if (payload.new) {
              const row = payload.new as ServiceTicket;
              if (category && row.category !== category) return prev;
              const idx = prev.findIndex(t => t.id === row.id);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [row, ...prev];
            }
            return prev;
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, [category]);

  return { tickets, loading };
}

export function useCustomerLifecycle(): { rows: CustomerLifecycle[]; loading: boolean } {
  const [rows, setRows] = useState<CustomerLifecycle[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('customer_lifecycle')
        .select('*')
        .order('shipped_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) setRows(data as CustomerLifecycle[]);
      setLoading(false);

      channel = supabase
        .channel('customer_lifecycle:realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'customer_lifecycle' }, (payload) => {
          setRows(prev => {
            if (payload.eventType === 'DELETE' && payload.old) {
              return prev.filter(r => r.id !== (payload.old as { id: string }).id);
            }
            if (payload.new) {
              const row = payload.new as CustomerLifecycle;
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

  return { rows, loading };
}

export function useTicketAttachments(ticketId: string | null): {
  attachments: TicketAttachment[];
  loading: boolean;
} {
  const [attachments, setAttachments] = useState<TicketAttachment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ticketId) { setAttachments([]); setLoading(false); return; }
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from('service_ticket_attachments')
        .select('*')
        .eq('ticket_id', ticketId)
        .order('uploaded_at', { ascending: true });
      if (cancelled) return;
      if (!error && data) setAttachments(data as TicketAttachment[]);
      setLoading(false);

      channel = supabase
        .channel(`attachments:${ticketId}`)
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'service_ticket_attachments', filter: `ticket_id=eq.${ticketId}` },
          (payload) => {
            setAttachments(prev => {
              if (payload.eventType === 'DELETE' && payload.old) {
                return prev.filter(a => a.id !== (payload.old as { id: string }).id);
              }
              if (payload.new) {
                const row = payload.new as TicketAttachment;
                const idx = prev.findIndex(a => a.id === row.id);
                if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
                return [...prev, row];
              }
              return prev;
            });
          })
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, [ticketId]);

  return { attachments, loading };
}

// ============================================================ Mutations

export async function updateTicketStatus(id: string, status: TicketStatus): Promise<void> {
  const { error } = await supabase.from('service_tickets').update({ status }).eq('id', id);
  if (error) throw error;
  await logAction('ticket_status_changed', id, status);
}

export async function assignTicketOwner(id: string, owner_email: string | null): Promise<void> {
  const { error } = await supabase.from('service_tickets').update({ owner_email }).eq('id', id);
  if (error) throw error;
  await logAction('ticket_owner_assigned', id, owner_email ?? '(unassigned)');
}

export async function setTicketPriority(id: string, priority: TicketPriority): Promise<void> {
  const { error } = await supabase.from('service_tickets').update({ priority }).eq('id', id);
  if (error) throw error;
  await logAction('ticket_priority_set', id, priority);
}

export async function updateTicketNotes(id: string, internal_notes: string): Promise<void> {
  const { error } = await supabase.from('service_tickets').update({ internal_notes }).eq('id', id);
  if (error) throw error;
}

export async function setRepairFields(
  id: string,
  patch: { defect_category?: string | null; parts_needed?: string | null },
): Promise<void> {
  const { error } = await supabase.from('service_tickets').update(patch).eq('id', id);
  if (error) throw error;
}

export async function markOnboardingComplete(lifecycleId: string): Promise<void> {
  const { error } = await supabase
    .from('customer_lifecycle')
    .update({ onboarding_status: 'completed', onboarding_completed_at: new Date().toISOString() })
    .eq('id', lifecycleId);
  if (error) throw error;
  await logAction('onboarding_completed', lifecycleId);
}

export async function markOnboardingNoShow(lifecycleId: string): Promise<void> {
  const { error } = await supabase
    .from('customer_lifecycle')
    .update({ onboarding_status: 'no_show' })
    .eq('id', lifecycleId);
  if (error) throw error;
  await logAction('onboarding_no_show', lifecycleId);
}

// Signed URL for displaying an attachment (1 hour expiry).
export async function attachmentSignedUrl(file_path: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from('ticket-attachments')
    .createSignedUrl(file_path, 3600);
  if (error || !data) return null;
  return data.signedUrl;
}
