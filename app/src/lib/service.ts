import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';
import { logAction } from './activityLog';

// ============================================================ Types

// Backlog #75 — 'diagnosis_call' is a new category for tickets created
// when a customer books on Huayi's Google appointment schedule via the
// link sent from the ticket detail panel.
export type TicketCategory = 'onboarding' | 'support' | 'repair' | 'diagnosis_call';
export type TicketSource =
  | 'calendly' | 'customer_form' | 'hubspot' | 'fulfillment_flag'
  | 'ops_manual' | 'gmail' | 'quo' | 'google_calendar';

export type TicketKind = 'conversation' | 'ticket';
export type InboxDisposition = 'promoted' | 'sales' | 'follow_up' | 'dismissed';
export const TICKET_STATUSES = [
  'waiting_on_us', 'in_progress', 'waiting_on_customer',
  'queued_for_replacement', 'call_scheduled', 'on_hold', 'closed',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type OnboardingStatus =
  | 'not_scheduled' | 'scheduled' | 'completed' | 'no_show' | 'skipped';

export type TicketTopic =
  | 'return_hardware_defect' | 'warranty_replacement' | 'refund' | 'software_firmware'
  | 'complaint' | 'callback' | 'assembly_support' | 'troubleshooting'
  | 'logistics_pickup' | 'order_fulfillment' | 'in_person_service' | 'appointment'
  | 'marketing_social' | 'closed_acknowledgment' | 'other';

// Coarser, operator-set classification for volume reporting (walkthrough #38).
// Distinct from `topic` (which is auto-classified and granular). DB column is
// `text` with no check constraint so this list can iterate without a migration.
export const ISSUE_AREAS = [
  'electrical', 'mechanical', 'software', 'shipping',
  'billing', 'onboarding', 'other',
] as const;
export type IssueArea = (typeof ISSUE_AREAS)[number];

export const ISSUE_AREA_LABEL: Record<IssueArea, string> = {
  electrical: 'Electrical',
  mechanical: 'Mechanical',
  software:   'Software',
  shipping:   'Shipping',
  billing:    'Billing',
  onboarding: 'Onboarding',
  other:      'Other',
};

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
  replacement_order_id: string | null;
  kind: TicketKind;
  inbox_disposition: InboxDisposition | null;
  created_at: string;
  updated_at: string;
  // Gmail pipeline (PR1 + PR2)
  gmail_thread_id: string | null;
  gmail_account: string | null;
  topic: TicketTopic | null;
  summary: string | null;
  suggested_next_action: string | null;
  last_classified_at: string | null;
  classification_confidence: number | null;
  message_count: number;
  first_message_at: string | null;
  last_message_at: string | null;
  is_manually_overridden: boolean;
  issue_area: IssueArea | null;
  // Backlog #75 — diagnosis-call dedupe stamps.
  diagnosis_link_sent_at: string | null;
  diag_cohost_invited_at: string | null;
  google_calendar_event_id: string | null;
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

export type TicketMessage = {
  id: string;
  ticket_id: string;
  gmail_message_id: string;
  direction: 'inbound' | 'outbound';
  sender: string | null;
  sent_at: string | null;
  snippet: string | null;
  body_text: string | null;
  created_at: string;
};

export type ClassificationLogEntry = {
  id: string;
  ticket_id: string;
  method: 'rules' | 'llm';
  priority: string | null;
  category: string | null;
  rule_id: string | null;
  llm_input_hash: string | null;
  confidence: number | null;
  created_at: string;
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

export type TicketNote = {
  id: string;
  ticket_id: string;
  body: string;
  author_id: string | null;
  author_email: string | null;
  created_at: string;
  updated_at: string;
};

// ============================================================ Display metadata

export const CATEGORY_META: Record<TicketCategory, { label: string; color: string; bg: string }> = {
  onboarding:     { label: 'Onboarding',     color: '#276749', bg: '#f0fff4' },
  support:        { label: 'Support',        color: '#2b6cb0', bg: '#ebf8ff' },
  repair:         { label: 'Repair',         color: '#c05621', bg: '#fffaf0' },
  diagnosis_call: { label: 'Diagnosis call', color: '#805ad5', bg: '#faf5ff' },
};

export const TOPIC_LABEL: Record<TicketTopic, string> = {
  return_hardware_defect: 'Return / hardware',
  warranty_replacement:   'Warranty',
  refund:                 'Refund',
  software_firmware:      'Software / firmware',
  complaint:              'Complaint',
  callback:               'Callback',
  assembly_support:       'Assembly support',
  troubleshooting:        'Troubleshooting',
  logistics_pickup:       'Logistics',
  order_fulfillment:      'Order fulfillment',
  in_person_service:      'In-person',
  appointment:            'Appointment',
  marketing_social:       'Marketing',
  closed_acknowledgment:  'Acknowledgment',
  other:                  'Other',
};

export const STATUS_META: Record<TicketStatus, { label: string; color: string; bg: string }> = {
  waiting_on_us:          { label: 'Waiting on Us',          color: '#2b6cb0', bg: '#ebf8ff' },
  in_progress:            { label: 'In Progress',            color: '#c05621', bg: '#fffaf0' },
  waiting_on_customer:    { label: 'Waiting on Customer',    color: '#718096', bg: '#f7fafc' },
  queued_for_replacement: { label: 'Queued for Replacement', color: '#553c9a', bg: '#faf5ff' },
  call_scheduled:         { label: 'Call Scheduled',         color: '#2c7a7b', bg: '#e6fffa' },
  on_hold:                { label: 'On Hold',                color: '#b7791f', bg: '#fffff0' },
  closed:                 { label: 'Closed',                 color: '#a0aec0', bg: '#edf2f7' },
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
  gmail:            'Gmail',
  quo:              'Quo',
  google_calendar:  'Calendar',
};

// Allowed next-states for the state machine (UI gating). Any status can move
// to any other — ops decides; we don't impose a rigid flow across the seven.
export const NEXT_STATUSES: Record<TicketStatus, TicketStatus[]> = Object.fromEntries(
  TICKET_STATUSES.map(s => [s, TICKET_STATUSES.filter(x => x !== s)]),
) as Record<TicketStatus, TicketStatus[]>;

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
        .eq('kind', 'ticket')
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
              if (row.kind !== 'ticket') return prev.filter(t => t.id !== row.id);
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

export function useInbox(disposition?: InboxDisposition | 'untriaged' | 'all'): {
  rows: ServiceTicket[];
  loading: boolean;
} {
  const [rows, setRows] = useState<ServiceTicket[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      let q = supabase
        .from('service_tickets')
        .select('*')
        .eq('kind', 'conversation')
        .order('last_message_at', { ascending: false, nullsFirst: false });
      if (disposition === 'untriaged') q = q.is('inbox_disposition', null);
      else if (disposition && disposition !== 'all') q = q.eq('inbox_disposition', disposition);
      const { data, error } = await q;
      if (cancelled) return;
      if (!error && data) setRows(data as ServiceTicket[]);
      setLoading(false);

      channel = supabase
        .channel(`service_inbox:${disposition ?? 'all'}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'service_tickets' }, (payload) => {
          setRows(prev => {
            if (payload.eventType === 'DELETE' && payload.old) {
              return prev.filter(r => r.id !== (payload.old as { id: string }).id);
            }
            if (payload.new) {
              const row = payload.new as ServiceTicket;
              // Drop rows that no longer belong in this view
              if (row.kind !== 'conversation') return prev.filter(r => r.id !== row.id);
              if (disposition === 'untriaged' && row.inbox_disposition !== null) return prev.filter(r => r.id !== row.id);
              if (disposition && disposition !== 'all' && disposition !== 'untriaged' && row.inbox_disposition !== disposition) {
                return prev.filter(r => r.id !== row.id);
              }
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
  }, [disposition]);

  return { rows, loading };
}

export async function setInboxDisposition(
  ticketId: string,
  disposition: InboxDisposition | null,
): Promise<void> {
  const { error } = await supabase
    .from('service_tickets')
    .update({ inbox_disposition: disposition })
    .eq('id', ticketId);
  if (error) throw error;
  await logAction('inbox_disposition_set', ticketId, disposition ?? '(cleared)');
}

export async function promoteToTicket(
  ticketId: string,
  fields: { category: TicketCategory; owner_email: string },
): Promise<void> {
  const { error } = await supabase
    .from('service_tickets')
    .update({
      kind: 'ticket',
      inbox_disposition: 'promoted',
      category: fields.category,
      owner_email: fields.owner_email,
      status: 'waiting_on_us',
    })
    .eq('id', ticketId);
  if (error) throw error;
  await logAction('promoted_to_ticket', ticketId, `${fields.category} → ${fields.owner_email}`);
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

export function useTicketNotes(ticketId: string | null): {
  notes: TicketNote[];
  loading: boolean;
} {
  const [notes, setNotes] = useState<TicketNote[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ticketId) { setNotes([]); setLoading(false); return; }
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from('ticket_notes')
        .select('*')
        .eq('ticket_id', ticketId)
        .order('created_at', { ascending: true });
      if (cancelled) return;
      if (!error && data) setNotes(data as TicketNote[]);
      setLoading(false);

      channel = supabase
        .channel(`ticket_notes:${ticketId}`)
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'ticket_notes', filter: `ticket_id=eq.${ticketId}` },
          (payload) => {
            setNotes(prev => {
              if (payload.eventType === 'DELETE' && payload.old) {
                return prev.filter(n => n.id !== (payload.old as { id: string }).id);
              }
              if (payload.new) {
                const row = payload.new as TicketNote;
                const idx = prev.findIndex(n => n.id === row.id);
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

  return { notes, loading };
}

export async function addTicketNote(ticketId: string, body: string): Promise<void> {
  const trimmed = body.trim();
  if (!trimmed) throw new Error('Note cannot be empty.');
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from('ticket_notes').insert({
    ticket_id: ticketId,
    body: trimmed,
    author_id: user?.id ?? null,
    author_email: user?.email ?? null,
  });
  if (error) throw error;
  await logAction('ticket_note_added', ticketId, trimmed.slice(0, 120));
}

export async function updateTicketNote(noteId: string, body: string): Promise<void> {
  const trimmed = body.trim();
  if (!trimmed) throw new Error('Note cannot be empty.');
  const { data, error } = await supabase
    .from('ticket_notes')
    .update({ body: trimmed })
    .eq('id', noteId)
    .select('id, ticket_id');
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error('Note was not updated (no permission or note removed).');
  }
  await logAction('ticket_note_edited', data[0].ticket_id as string, trimmed.slice(0, 120));
}

export async function deleteTicketNote(noteId: string): Promise<void> {
  const { data, error } = await supabase
    .from('ticket_notes')
    .delete()
    .eq('id', noteId)
    .select('id, ticket_id');
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error('Note was not deleted (no permission or already removed).');
  }
  await logAction('ticket_note_deleted', data[0].ticket_id as string, '');
}

export function useTicketMessages(ticketId: string | null): {
  messages: TicketMessage[];
  loading: boolean;
} {
  const [messages, setMessages] = useState<TicketMessage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ticketId) { setMessages([]); setLoading(false); return; }
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from('ticket_messages')
        .select('*')
        .eq('ticket_id', ticketId)
        .order('sent_at', { ascending: true });
      if (cancelled) return;
      if (!error && data) setMessages(data as TicketMessage[]);
      setLoading(false);

      channel = supabase
        .channel(`ticket_messages:${ticketId}`)
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'ticket_messages', filter: `ticket_id=eq.${ticketId}` },
          (payload) => {
            setMessages(prev => {
              if (payload.eventType === 'DELETE' && payload.old) {
                return prev.filter(m => m.id !== (payload.old as { id: string }).id);
              }
              if (payload.new) {
                const row = payload.new as TicketMessage;
                const idx = prev.findIndex(m => m.id === row.id);
                if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
                return [...prev, row].sort((a, b) =>
                  (a.sent_at ?? '').localeCompare(b.sent_at ?? ''));
              }
              return prev;
            });
          })
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, [ticketId]);

  return { messages, loading };
}

export function useClassificationLog(ticketId: string | null): {
  entries: ClassificationLogEntry[];
  loading: boolean;
} {
  const [entries, setEntries] = useState<ClassificationLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ticketId) { setEntries([]); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from('ticket_classification_log')
        .select('*')
        .eq('ticket_id', ticketId)
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) setEntries(data as ClassificationLogEntry[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [ticketId]);

  return { entries, loading };
}

// ============================================================ Mutations

export type NewTicketInput = {
  category: TicketCategory;
  subject: string;
  description?: string | null;
  priority?: TicketPriority;
  customer_id?: string | null;
  customer_name?: string | null;
  customer_email?: string | null;
  customer_phone?: string | null;
  unit_serial?: string | null;
};

export async function createTicket(input: NewTicketInput): Promise<ServiceTicket> {
  const { data, error } = await supabase
    .from('service_tickets')
    .insert({
      category: input.category,
      source: 'ops_manual',
      subject: input.subject,
      description: input.description ?? null,
      priority: input.priority ?? 'normal',
      customer_id: input.customer_id ?? null,
      customer_name: input.customer_name ?? null,
      customer_email: input.customer_email ?? null,
      customer_phone: input.customer_phone ?? null,
      unit_serial: input.unit_serial ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  const row = data as ServiceTicket;
  await logAction('ticket_created', row.id, `${row.ticket_number} ${input.subject}`);
  return row;
}

export async function deleteTicket(id: string): Promise<void> {
  // Child rows (messages, attachments, classification log) are removed by the
  // `on delete cascade` FKs. Realtime fires a DELETE event that drops the row
  // from any open `useServiceTickets`/`useInbox` list.
  //
  // We `select()` the deleted rows back so an RLS-blocked delete — which
  // returns success with zero rows rather than an error — surfaces as a
  // failure instead of silently leaving the ticket in place.
  const { data, error } = await supabase
    .from('service_tickets')
    .delete()
    .eq('id', id)
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error('Ticket was not deleted (no permission or already removed).');
  }
  await logAction('ticket_deleted', id, 'Ticket deleted');
}

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

// Walkthrough #41: defines the support → repair pipeline. Operators flip a
// ticket's category here once they've confirmed it's actually a hardware
// repair issue (vs. an onboarding question or a general support inquiry).
// The category column gates which tab the ticket appears under — flipping
// to 'repair' surfaces the Repair Details section on this panel and routes
// the row to the Repair tab. Status is preserved so the operator's progress
// (triaging / in_progress / etc.) doesn't reset.
export async function setTicketCategory(id: string, category: TicketCategory): Promise<void> {
  const { error } = await supabase.from('service_tickets').update({ category }).eq('id', id);
  if (error) throw error;
  await logAction('ticket_category_changed', id, category);
}

export async function setTicketPriority(id: string, priority: TicketPriority): Promise<void> {
  // Staff edit locks the classifier out of overwriting priority/topic/etc.
  // until they click "Reclassify" (which resets the flag).
  const { error } = await supabase
    .from('service_tickets')
    .update({ priority, is_manually_overridden: true })
    .eq('id', id);
  if (error) throw error;
  await logAction('ticket_priority_set', id, priority);
}

export async function setTicketTopic(id: string, topic: TicketTopic): Promise<void> {
  const { error } = await supabase
    .from('service_tickets')
    .update({ topic, is_manually_overridden: true })
    .eq('id', id);
  if (error) throw error;
  await logAction('ticket_topic_set', id, topic);
}

export async function setTicketIssueArea(id: string, issue_area: IssueArea | null): Promise<void> {
  const { error } = await supabase
    .from('service_tickets')
    .update({ issue_area })
    .eq('id', id);
  if (error) throw error;
  await logAction('ticket_issue_area_set', id, issue_area ?? '(cleared)');
}

/** Trigger an on-demand run of the Gmail sync edge function. Returns the
 *  function's run summary so the UI can show a toast. */
export async function syncGmailTickets(): Promise<unknown> {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/sync-gmail-tickets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
    },
    body: '{}',
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try { detail = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* keep raw */ }
    throw new Error(`Gmail sync failed (${res.status}): ${detail}`);
  }
  await logAction('gmail_sync_manual', 'tickets');
  return JSON.parse(text);
}

/** Force a classifier rerun on a single ticket. Resets the manual-override
 *  flag so the new classification sticks. */
export async function reclassifyTicket(id: string): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/reclassify-ticket`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ ticket_id: id }),
  });
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try { detail = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* keep raw */ }
    throw new Error(`Reclassify failed (${res.status}): ${detail}`);
  }
  await logAction('ticket_reclassified', id);
}

export async function updateTicketNotes(id: string, internal_notes: string): Promise<void> {
  const { error } = await supabase.from('service_tickets').update({ internal_notes }).eq('id', id);
  if (error) throw error;
}

export async function updateTicketSubject(id: string, subject: string): Promise<void> {
  const trimmed = subject.trim();
  if (!trimmed) throw new Error('Subject cannot be empty.');
  const { data, error } = await supabase
    .from('service_tickets')
    .update({ subject: trimmed })
    .eq('id', id)
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error('Subject was not updated (no permission or ticket removed).');
  }
  await logAction('ticket_subject_updated', id, trimmed);
}

export async function setRepairFields(
  id: string,
  patch: { defect_category?: string | null; parts_needed?: string | null },
): Promise<void> {
  const { error } = await supabase.from('service_tickets').update(patch).eq('id', id);
  if (error) throw error;
}

/** Backlog #75 — record that the diagnosis-call booking link was sent.
 *  The actual SMS / email send happens via sendFollowupSms() in the
 *  caller; this stamp is for dedupe + audit so operators don't double-send. */
export async function markDiagnosisLinkSent(ticketId: string): Promise<void> {
  const sentAt = new Date().toISOString();
  const { error } = await supabase
    .from('service_tickets')
    .update({ diagnosis_link_sent_at: sentAt })
    .eq('id', ticketId);
  if (error) throw error;
  await logAction('diagnosis_link_sent', ticketId, sentAt);
}

export async function markOnboardingComplete(lifecycleId: string): Promise<void> {
  const completedAt = new Date().toISOString();
  // Fetch the lifecycle row first so we can mirror onboarding_completed_at
  // onto the linked customer's onboard_date (walkthrough #40). The FU1/FU2
  // calendar runs off customers.onboard_date; auto-populating it removes
  // the manual CSV-import step Reina was doing.
  const { data: lc, error: lcErr } = await supabase
    .from('customer_lifecycle')
    .select('customer_id')
    .eq('id', lifecycleId)
    .maybeSingle();
  if (lcErr) throw lcErr;

  const { error } = await supabase
    .from('customer_lifecycle')
    .update({ onboarding_status: 'completed', onboarding_completed_at: completedAt })
    .eq('id', lifecycleId);
  if (error) throw error;

  // Only set onboard_date when it's still null — preserves manually-set
  // values from prior CSV imports.
  if (lc?.customer_id) {
    const onboardDate = completedAt.slice(0, 10); // YYYY-MM-DD
    const { error: cErr } = await supabase
      .from('customers')
      .update({ onboard_date: onboardDate })
      .eq('id', lc.customer_id)
      .is('onboard_date', null);
    if (cErr) throw cErr;
  }

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

export async function markOnboardingSkipped(lifecycleId: string): Promise<void> {
  const { error } = await supabase
    .from('customer_lifecycle')
    .update({ onboarding_status: 'skipped' })
    .eq('id', lifecycleId);
  if (error) throw error;
  await logAction('onboarding_skipped', lifecycleId);
}

// Signed URL for displaying an attachment (1 hour expiry).
export async function attachmentSignedUrl(file_path: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from('ticket-attachments')
    .createSignedUrl(file_path, 3600);
  if (error || !data) return null;
  return data.signedUrl;
}
