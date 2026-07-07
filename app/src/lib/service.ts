import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';
import { logAction } from './activityLog';
import { sendTemplate } from './templates';

// ============================================================ Types

// Backlog #75 — 'diagnosis_call' is a new category for tickets created
// when a customer books on Huayi's Google appointment schedule via the
// link sent from the ticket detail panel.
export type TicketCategory = 'onboarding' | 'support' | 'repair' | 'diagnosis_call';
export type TicketSource =
  | 'calendly' | 'customer_form' | 'hubspot' | 'fulfillment_flag'
  | 'ops_manual' | 'gmail' | 'quo' | 'google_calendar' | 'telemetry_auto';

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
  root_cause: string | null;
  // Backlog #75 — diagnosis-call dedupe stamps.
  diagnosis_link_sent_at: string | null;
  diag_cohost_invited_at: string | null;
  google_calendar_event_id: string | null;
  // J5 — SLA aging
  sla_policy_id: string | null;
  first_response_due_at: string | null;
  resolution_due_at: string | null;
  first_responded_at: string | null;
  sla_resolved_at: string | null;
  sla_status: 'ok' | 'warning' | 'breached' | 'met' | null;
  // Feature 3 — bidirectional Linear/GitHub issue linking
  linear_issue_url: string | null;
  github_issue_url: string | null;
  engineering_resolved_at: string | null;
};

export type CustomerLifecycle = {
  id: string;
  customer_id: string | null;
  unit_serial: string;
  shipped_at: string;
  onboarding_status: OnboardingStatus;
  onboarding_completed_at: string | null;
  followup_email_sent_at: string | null;
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
  waiting_on_us:          { label: 'Needs Response',         color: '#2b6cb0', bg: '#ebf8ff' },
  in_progress:            { label: 'In Progress',            color: '#c05621', bg: '#fffaf0' },
  waiting_on_customer:    { label: 'Needs to Reach Out',     color: '#718096', bg: '#f7fafc' },
  queued_for_replacement: { label: 'Queued for Replacement', color: '#553c9a', bg: '#faf5ff' },
  call_scheduled:         { label: 'Call Scheduled',         color: '#2c7a7b', bg: '#e6fffa' },
  on_hold:                { label: 'On Hold',                color: '#b7791f', bg: '#fffff0' },
  closed:                 { label: 'Complete',               color: '#a0aec0', bg: '#edf2f7' },
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
  telemetry_auto:   'Telemetry auto',
};

// Safe accessors for the display metadata above. A ticket's status / priority /
// source can legitimately fall outside the known sets — a sync edge function
// that hasn't been redeployed yet, a manual DB edit, or a server-side value
// added before the frontend ships. Indexing the bare record then yields
// `undefined`, and reading `.label`/`.bg` off it throws *during render*, which
// white-screens the entire tab (there is no error boundary). These helpers
// degrade an unknown value to a neutral chip showing the raw (humanized) value
// instead of crashing. Use them anywhere the value comes from row data.
function humanizeToken(raw: string): string {
  return raw.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function statusMeta(status: string): { label: string; color: string; bg: string } {
  return STATUS_META[status as TicketStatus]
    ?? { label: humanizeToken(status), color: '#718096', bg: '#edf2f7' };
}

export function priorityMeta(priority: string): { label: string; color: string } {
  return PRIORITY_META[priority as TicketPriority]
    ?? { label: humanizeToken(priority), color: '#718096' };
}

export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source as TicketSource] ?? humanizeToken(source);
}

export function topicLabel(topic: string): string {
  return TOPIC_LABEL[topic as TicketTopic] ?? humanizeToken(topic);
}

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

// SLA chip — compact colored status pill for ticket list rows and detail panel.
export function slaChip(ticket: Pick<ServiceTicket, 'sla_status'>): {
  label: string;
  color: 'green' | 'amber' | 'red' | 'grey';
} {
  switch (ticket.sla_status) {
    case 'ok':      return { label: 'On track', color: 'green' };
    case 'warning': return { label: 'At risk',  color: 'amber' };
    case 'breached':return { label: 'Breached', color: 'red'   };
    case 'met':     return { label: 'Met',       color: 'grey'  };
    default:        return { label: 'No SLA',   color: 'grey'  };
  }
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

/**
 * Set of ticket ids that had a close event (ticket_status_changed → closed) in
 * the last `days`, read from the activity log. Used for the "closed in the last
 * N days" throughput KPI — counts a ticket even if it was reopened afterward,
 * which the current-status-based count would miss.
 */
export function useTicketsClosedSince(days: number): { closedIds: Set<string>; loading: boolean } {
  const [closedIds, setClosedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const { data, error } = await supabase
        .from('activity_log')
        .select('entity_id, ts')
        .eq('type', 'ticket_status_changed')
        .eq('detail', 'closed')
        .gte('ts', cutoff);
      if (cancelled) return;
      if (!error && data) {
        setClosedIds(new Set(
          (data as { entity_id: string | null }[])
            .map(r => r.entity_id)
            .filter((id): id is string => !!id),
        ));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [days]);

  return { closedIds, loading };
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
  /** Force a re-fetch of the attachment list. Caller should invoke after
   *  mutations (upload/delete) so the UI updates even if the realtime
   *  subscription dropped or raced the INSERT — observed on iPhone PWA
   *  installs where the realtime websocket can stall after sleep/wake. */
  refresh: () => void;
} {
  const [attachments, setAttachments] = useState<TicketAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);

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
        .channel(`attachments:${ticketId}:${refreshTick}`)
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
  }, [ticketId, refreshTick]);

  return { attachments, loading, refresh: () => setRefreshTick(t => t + 1) };
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
  await logAction('ticket_created', row.id, `${row.ticket_number} ${input.subject}`,
    { entityType: 'ticket', entityId: row.id, unitSerial: input.unit_serial ?? undefined },
    { klaviyoEvent: 'Support Ticket Opened', ...(input.customer_email ? { klaviyoEmail: input.customer_email } : {}) });
  return row;
}

export async function deleteTicket(id: string): Promise<void> {
  // First, remove any QUEUED replacement orders linked to this ticket (not yet
  // shipped) so deleting the ticket also clears its replacement from Order
  // Review. Shipped / delivered replacements are real fulfilled orders and are
  // left intact (the orders.linked_ticket_id FK just nulls on ticket delete).
  const { data: linkedRepl, error: lrErr } = await supabase
    .from('orders')
    .select('id, order_ref')
    .eq('kind', 'replacement')
    .eq('linked_ticket_id', id)
    .is('shipped_at', null)
    .is('delivered_at', null);
  if (lrErr) throw new Error(`Failed to look up linked replacements: ${lrErr.message}`);

  for (const o of linkedRepl ?? []) {
    // Free any units this replacement had reserved so they return to stock.
    // (Pending/awaiting replacements reserve nothing → this is a no-op.)
    await supabase
      .from('units')
      .update({ status: 'ready', customer_order_ref: null })
      .eq('customer_order_ref', o.order_ref)
      .eq('status', 'reserved');
    const { error: delErr } = await supabase.from('orders').delete().eq('id', o.id);
    if (delErr) {
      throw new Error(`Failed to delete linked replacement ${o.order_ref}: ${delErr.message}`);
    }
    await logAction('replacement_deleted', o.order_ref, `Removed with ticket ${id}`);
  }

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
  await logAction('ticket_deleted', id, 'Ticket deleted',
    { entityType: 'ticket', entityId: id });
}

/** Minimal live status + number of a single ticket, for gating actions on
 *  ticket state (e.g. only cancel a replacement once its ticket is closed).
 *  Subscribes to that row so closing the ticket elsewhere enables the action
 *  without a reload. */
export function useTicketBrief(ticketId: string | null): {
  status: TicketStatus | null; ticketNumber: string | null; loading: boolean;
} {
  const [status, setStatus] = useState<TicketStatus | null>(null);
  const [ticketNumber, setTicketNumber] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ticketId) { setStatus(null); setTicketNumber(null); setLoading(false); return; }
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data } = await supabase
        .from('service_tickets')
        .select('status, ticket_number')
        .eq('id', ticketId)
        .maybeSingle();
      if (cancelled) return;
      const row = data as { status: TicketStatus; ticket_number: string | null } | null;
      setStatus(row?.status ?? null);
      setTicketNumber(row?.ticket_number ?? null);
      setLoading(false);

      channel = supabase
        .channel(`service_tickets:brief:${ticketId}`)
        .on('postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'service_tickets', filter: `id=eq.${ticketId}` },
          (payload) => {
            const r = payload.new as { status?: TicketStatus; ticket_number?: string | null };
            if (r.status) setStatus(r.status);
            if (r.ticket_number !== undefined) setTicketNumber(r.ticket_number ?? null);
          })
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, [ticketId]);

  return { status, ticketNumber, loading };
}

export async function updateTicketStatus(id: string, status: TicketStatus): Promise<void> {
  // Stamp closed_at on close, and CLEAR it on reopen so a later re-close gets a
  // fresh timestamp (the DB trigger only coalesces, so without clearing, a
  // reopened-then-reclosed ticket would keep its stale original close date).
  const patch: Record<string, unknown> = { status };
  patch.closed_at = status === 'closed' ? new Date().toISOString() : null;
  const { error } = await supabase.from('service_tickets').update(patch).eq('id', id);
  if (error) throw error;
  await logAction('ticket_status_changed', id, status,
    { entityType: 'ticket', entityId: id });
}

export async function assignTicketOwner(id: string, owner_email: string | null): Promise<void> {
  const { error } = await supabase.from('service_tickets').update({ owner_email }).eq('id', id);
  if (error) throw error;
  await logAction('ticket_owner_assigned', id, owner_email ?? '(unassigned)',
    { entityType: 'ticket', entityId: id });
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
  await logAction('ticket_category_changed', id, category,
    { entityType: 'ticket', entityId: id });
}

export async function setTicketPriority(id: string, priority: TicketPriority): Promise<void> {
  // Staff edit locks the classifier out of overwriting priority/topic/etc.
  // until they click "Reclassify" (which resets the flag).
  const { error } = await supabase
    .from('service_tickets')
    .update({ priority, is_manually_overridden: true })
    .eq('id', id);
  if (error) throw error;
  await logAction('ticket_priority_set', id, priority,
    { entityType: 'ticket', entityId: id });
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

/** Set (or clear) a ticket's description. Unlike subject, empty is allowed —
 *  it clears the field. Lets operators add a description after creation
 *  (the intake/classifier sets it at creation, but backfilled / manual
 *  tickets often have none). */
export async function setTicketDescription(id: string, description: string): Promise<void> {
  const trimmed = description.trim();
  const { data, error } = await supabase
    .from('service_tickets')
    .update({ description: trimmed || null })
    .eq('id', id)
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error('Description was not updated (no permission or ticket removed).');
  }
  await logAction('ticket_description_updated', id, trimmed.slice(0, 100) || '(cleared)');
}

export async function setRepairFields(
  id: string,
  patch: { defect_category?: string | null; parts_needed?: string | null },
): Promise<void> {
  const { error } = await supabase.from('service_tickets').update(patch).eq('id', id);
  if (error) throw error;
}

/** Feature 3 — record the Linear issue URL on the ticket row.
 *  Called after the linear-create-issue edge function succeeds. */
export async function setLinearIssueUrl(ticketId: string, url: string): Promise<void> {
  const { error } = await supabase
    .from('service_tickets')
    .update({ linear_issue_url: url })
    .eq('id', ticketId);
  if (error) throw error;
  await logAction('linear_issue_linked', ticketId, url);
}

/** Feature 3 — record the GitHub issue URL on the ticket row. */
export async function setGitHubIssueUrl(ticketId: string, url: string): Promise<void> {
  const { error } = await supabase
    .from('service_tickets')
    .update({ github_issue_url: url })
    .eq('id', ticketId);
  if (error) throw error;
  await logAction('github_issue_linked', ticketId, url);
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



/** Pick the follow-up anchor date (`YYYY-MM-DD`) for a completed onboarding:
 *  the date of the customer's most-recent onboarding call
 *  (`calendly_event_start`), or `fallbackIso` (the completion timestamp) when
 *  the customer has no Calendly-booked onboarding call. FU1/FU2 count from this
 *  date (call + 14d / + 28d), so anchoring to the actual call — not the day the
 *  operator marked it complete — keeps the cadence tied to the call itself. */
export function onboardingAnchorDate(
  onboardingTickets: { calendly_event_start: string | null }[],
  fallbackIso: string,
): string {
  const latestCall = onboardingTickets
    .map(t => t.calendly_event_start)
    .filter((s): s is string => !!s)
    .sort()
    .at(-1);
  return (latestCall ?? fallbackIso).slice(0, 10);
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
  // values from prior CSV imports. Also fetch email for the Klaviyo 'First Use'
  // event (#88) that triggers the Day 3 + Day 7 first-week drip.
  let customerEmail: string | null = null;
  if (lc?.customer_id) {
    const { error: cErr, data: cust } = await supabase
      .from('customers')
      .select('email, onboard_date')
      .eq('id', lc.customer_id)
      .maybeSingle();
    if (cErr) throw cErr;
    customerEmail = (cust as { email?: string | null; onboard_date?: string | null } | null)?.email ?? null;
    if (!(cust as { onboard_date?: string | null } | null)?.onboard_date) {
      // Anchor FU1/FU2 to the actual onboarding call date, falling back to the
      // completion timestamp when the customer has no Calendly-booked call.
      const { data: obTickets } = await supabase
        .from('service_tickets')
        .select('calendly_event_start')
        .eq('customer_id', lc.customer_id)
        .eq('category', 'onboarding');
      const onboardDate = onboardingAnchorDate(
        (obTickets ?? []) as { calendly_event_start: string | null }[],
        completedAt,
      );
      const { error: upErr } = await supabase
        .from('customers')
        .update({ onboard_date: onboardDate })
        .eq('id', lc.customer_id);
      if (upErr) throw upErr;
    }
  }

  await logAction('onboarding_completed', lifecycleId, '', undefined,
    customerEmail ? { klaviyoEvent: 'First Use', klaviyoEmail: customerEmail } : undefined);
}

export async function sendPostOnboardingFollowup(
  lifecycleId: string,
  to: string,
  toName: string,
  variables: Record<string, string>,
): Promise<void> {
  await sendTemplate({ template_key: 'post_onboarding_followup', to, to_name: toName, variables });
  const { error } = await supabase
    .from('customer_lifecycle')
    .update({ followup_email_sent_at: new Date().toISOString() })
    .eq('id', lifecycleId);
  if (error) throw error;
  await logAction('followup_email_sent', lifecycleId, `→ ${to}`);
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

// Storage bucket constraints — mirrored from the bucket config so the UI
// can validate client-side before hitting Supabase Storage (which returns
// opaque "Payload too large" / "mime type not allowed" errors).
export const ATTACHMENT_BUCKET = 'ticket-attachments';
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_ALLOWED_MIME = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
  'video/mp4',  'video/quicktime', 'video/webm',
] as const;
export const ATTACHMENT_INPUT_ACCEPT = ATTACHMENT_ALLOWED_MIME.join(',');

/** Upload a single photo or video to a ticket. Validates type + size
 *  client-side, uploads to private storage bucket, then writes the DB row
 *  so realtime picks it up. Caller should handle thrown errors (show in UI). */
export async function uploadTicketAttachment(
  ticketId: string,
  file: File,
): Promise<TicketAttachment> {
  if (!ATTACHMENT_ALLOWED_MIME.includes(file.type as typeof ATTACHMENT_ALLOWED_MIME[number])) {
    throw new Error(`Unsupported file type: ${file.type || '(unknown)'}. Allowed: JPEG, PNG, WebP, HEIC, MP4, MOV, WebM.`);
  }
  if (file.size > ATTACHMENT_MAX_BYTES) {
    throw new Error(`File too large (${(file.size / 1_000_000).toFixed(1)} MB). Maximum is 25 MB.`);
  }
  const { data: { user } } = await supabase.auth.getUser();
  // Path layout mirrors ServiceRequestForm: ticketId folder so RLS /
  // signed-URL scoping by ticket is straightforward, UUID prefix avoids
  // collisions when the same filename is uploaded twice.
  const path = `${ticketId}/${crypto.randomUUID()}-${file.name}`;
  const { error: upErr } = await supabase.storage
    .from(ATTACHMENT_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (upErr) throw new Error(`Upload failed: ${upErr.message}`);

  const { data: row, error: rowErr } = await supabase
    .from('service_ticket_attachments')
    .insert({
      ticket_id:   ticketId,
      file_path:   path,
      file_name:   file.name,
      mime_type:   file.type,
      size_bytes:  file.size,
      uploaded_by: user?.id ?? null,
    })
    .select('*')
    .single();
  if (rowErr || !row) {
    // Best-effort cleanup of the orphaned storage object so we don't leak
    // bytes. If this delete fails too, the file just sits in the bucket
    // unreferenced — operator can purge later.
    await supabase.storage.from(ATTACHMENT_BUCKET).remove([path]);
    throw new Error(`Attachment record failed: ${rowErr?.message ?? 'no row returned'}`);
  }
  // Auto-write a note so the upload appears in the Notes feed where the
  // operator is already looking. logAction is invoked downstream by
  // addTicketNote so the activity_log still records it (don't double-log).
  await addTicketNote(
    ticketId,
    `📎 Added ${file.type.startsWith('image/') ? 'photo' : file.type.startsWith('video/') ? 'video' : 'file'}: ${file.name} (${formatBytes(file.size)})`,
  ).catch((e: Error) => {
    // Non-fatal: the attachment itself succeeded. Surface to console so
    // the missing audit note is debuggable but don't block the upload.
    console.warn('Auto-note for attachment upload failed (non-fatal):', e.message);
  });
  return row as TicketAttachment;
}

/** Delete an attachment — storage object first, then DB row. If the storage
 *  delete fails we still drop the DB row to avoid the operator seeing a
 *  "ghost" attachment that 404s on signed-URL fetch. */
export async function deleteTicketAttachment(att: TicketAttachment): Promise<void> {
  const { error: storageErr } = await supabase.storage
    .from(ATTACHMENT_BUCKET)
    .remove([att.file_path]);
  if (storageErr) console.warn('Attachment storage delete failed (non-fatal):', storageErr.message);
  const { error: rowErr } = await supabase
    .from('service_ticket_attachments')
    .delete()
    .eq('id', att.id);
  if (rowErr) throw new Error(`Failed to delete attachment record: ${rowErr.message}`);
  // Auto-write a note so the delete appears in the Notes feed alongside
  // the original upload note.
  await addTicketNote(
    att.ticket_id,
    `🗑 Removed ${att.mime_type.startsWith('image/') ? 'photo' : att.mime_type.startsWith('video/') ? 'video' : 'file'}: ${att.file_name}`,
  ).catch((e: Error) => {
    console.warn('Auto-note for attachment delete failed (non-fatal):', e.message);
  });
}

function formatBytes(n: number): string {
  return n > 1_000_000
    ? `${(n / 1_000_000).toFixed(1)} MB`
    : `${Math.round(n / 1000)} KB`;
}

// ============================================================ Warranty Registrations (Feature J1)

export type CoverageState = 'in_warranty' | 'expired' | 'voided' | 'no_registration';

export interface WarrantyRegistration {
  id: string;
  unit_serial: string;
  customer_id: string;
  original_order_id: string | null;
  coverage_tier: 'standard_1y' | 'extended_2y' | 'replacement_no_warranty' | 'lifetime_legacy';
  coverage_start: string; // date string YYYY-MM-DD
  coverage_end: string;   // date string YYYY-MM-DD
  parent_registration_id: string | null;
  voided_reason: string | null;
  voided_at: string | null;
  registered_at: string;
  registered_by: string | null;
}

export function computeCoverageState(reg: WarrantyRegistration | null): CoverageState {
  if (!reg) return 'no_registration';
  if (reg.voided_at) return 'voided';
  // Compare date strings directly — coverage_end is YYYY-MM-DD and new Date() parses
  // date-only strings as UTC midnight, which appears "past" in any non-UTC+ timezone.
  const todayStr = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
  if (reg.coverage_end < todayStr) return 'expired';
  return 'in_warranty';
}

export function daysRemainingWarranty(reg: WarrantyRegistration): number {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const end = new Date(reg.coverage_end); end.setHours(0, 0, 0, 0);
  return Math.ceil((end.getTime() - now.getTime()) / 86_400_000);
}

export function useWarrantyRegistration(unitSerial: string | null): {
  registration: WarrantyRegistration | null;
  loading: boolean;
} {
  const [registration, setRegistration] = useState<WarrantyRegistration | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!unitSerial) { setRegistration(null); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from('warranty_registrations')
        .select('*')
        .eq('unit_serial', unitSerial)
        .maybeSingle();
      if (cancelled) return;
      if (!error) setRegistration(data as WarrantyRegistration | null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [unitSerial]);

  return { registration, loading };
}

export async function voidWarranty(id: string, reason: string): Promise<void> {
  const { error } = await supabase
    .from('warranty_registrations')
    .update({ voided_at: new Date().toISOString(), voided_reason: reason })
    .eq('id', id);
  if (error) throw error;
  await logAction('warranty_voided', id, reason,
    { entityType: 'warranty_registration', entityId: id });
}

export async function extendWarranty(id: string, newTier: 'extended_2y' | 'lifetime_legacy'): Promise<void> {
  const { error } = await supabase
    .from('warranty_registrations')
    .update({ coverage_tier: newTier })
    .eq('id', id);
  if (error) throw error;
  await logAction('warranty_extended', id, newTier,
    { entityType: 'warranty_registration', entityId: id });
}

// ============================================================ Feature J4: Device Context

export interface DeviceContextUnit {
  firmware_version: string | null;
  electrical_check: string | null;
  mechanical_check: string | null;
  defect_notes: string | null;
  technician: string | null;
  status_updated_at: string | null;
  test_report_uploaded_at: string | null;
}

export interface DeviceContextTelemetry {
  classified_state: string;
  classified_at: string;
  is_stale: boolean; // true if > 24h old
}

export interface DeviceContext {
  unit: DeviceContextUnit | null;
  telemetry: DeviceContextTelemetry | null;
  openTicketCount: number;
  returnCount: number;
  warranty: ReturnType<typeof useWarrantyRegistration>;
  loading: boolean;
}

// Module-level telemetry cache: keyed by unit_serial, 60s TTL.
const _telemetryCache = new Map<string, { data: DeviceContextTelemetry | null; fetchedAt: number }>();
const TELEMETRY_CACHE_TTL_MS = 60_000;

async function fetchDeviceContextTelemetry(unitSerial: string): Promise<DeviceContextTelemetry | null> {
  const cached = _telemetryCache.get(unitSerial);
  if (cached && Date.now() - cached.fetchedAt < TELEMETRY_CACHE_TTL_MS) {
    return cached.data;
  }

  // Lazy import to avoid breaking if telemetry env vars are missing.
  const { supabaseTelemetry, isTelemetryConfigured } = await import('./supabaseTelemetry');
  if (!isTelemetryConfigured || !supabaseTelemetry) {
    _telemetryCache.set(unitSerial, { data: null, fetchedAt: Date.now() });
    return null;
  }

  // Pull the most recent telemetry event for this serial from the `lila` table.
  // The `lila` table stores the latest known state per serial_number.
  const { data, error } = await supabaseTelemetry
    .from('lila')
    .select('serial_number, updated_at, status')
    .eq('serial_number', unitSerial)
    .maybeSingle();

  if (error || !data) {
    _telemetryCache.set(unitSerial, { data: null, fetchedAt: Date.now() });
    return null;
  }

  const lila = data as { serial_number: string; updated_at: string | null; status: string | null };
  const classifiedAt = lila.updated_at ?? new Date(0).toISOString();
  const ageMs = Date.now() - new Date(classifiedAt).getTime();
  const result: DeviceContextTelemetry = {
    classified_state: lila.status ?? 'UNKNOWN',
    classified_at: classifiedAt,
    is_stale: ageMs > 24 * 3_600_000,
  };
  _telemetryCache.set(unitSerial, { data: result, fetchedAt: Date.now() });
  return result;
}

/** Hook that aggregates device context for a unit serial:
 *  unit QC fields, latest telemetry state, open ticket count,
 *  return count, and warranty registration. Used by DeviceContextHeader. */
export function useDeviceContext(unitSerial: string | null): DeviceContext {
  const warranty = useWarrantyRegistration(unitSerial);
  const [unit, setUnit] = useState<DeviceContextUnit | null>(null);
  const [telemetry, setTelemetry] = useState<DeviceContextTelemetry | null>(null);
  const [openTicketCount, setOpenTicketCount] = useState(0);
  const [returnCount, setReturnCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!unitSerial) {
      setUnit(null);
      setTelemetry(null);
      setOpenTicketCount(0);
      setReturnCount(0);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    (async () => {
      const [unitResult, ticketResult, returnResult, telemetryResult] = await Promise.all([
        supabase
          .from('units')
          .select('firmware_version, electrical_check, mechanical_check, defect_notes, technician, status_updated_at, test_report_uploaded_at')
          .eq('serial', unitSerial)
          .maybeSingle(),
        supabase
          .from('service_tickets')
          .select('id', { count: 'exact', head: true })
          .eq('unit_serial', unitSerial)
          .not('status', 'eq', 'closed'),
        supabase
          .from('returns')
          .select('id', { count: 'exact', head: true })
          .eq('unit_serial', unitSerial),
        fetchDeviceContextTelemetry(unitSerial).catch(() => null),
      ]);

      if (cancelled) return;

      if (!unitResult.error && unitResult.data) {
        setUnit(unitResult.data as DeviceContextUnit);
      } else {
        setUnit(null);
      }

      setOpenTicketCount(ticketResult.count ?? 0);
      setReturnCount(returnResult.count ?? 0);
      setTelemetry(telemetryResult);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitSerial]);

  return { unit, telemetry, openTicketCount, returnCount, warranty, loading: loading || warranty.loading };
}

// ============================================================ Feature J6: Telemetry auto-ticket

// Per-state hold thresholds in milliseconds.
// NOT_MIXING is intentionally absent: 75% false positive rate, see backlog #70.
const AUTOTICKET_THRESHOLDS_MS: Partial<Record<string, number>> = {
  DIAGNOSE:    6  * 3_600_000,
  NO_BME_DATA: 24 * 3_600_000,
  DRY_SOIL:    48 * 3_600_000,
  SOAKED_SOIL: 48 * 3_600_000,
  OPEN_LID:    4  * 3_600_000,
  // NOT_MIXING: DISABLED — do not add
};

/** Returns true if a telemetry state has been held long enough to warrant
 *  auto-creating a service ticket.
 *
 *  Rules:
 *  - OK / NEW_FOOD → never trigger (healthy states)
 *  - NOT_MIXING    → never trigger (75% false positive rate, backlog #70)
 *  - Any other state → true when (now - state_held_since) >= threshold
 */
export function shouldAutoCreate(
  classified_state: string,
  state_held_since: Date | string,
): boolean {
  const thresholdMs = AUTOTICKET_THRESHOLDS_MS[classified_state];
  if (thresholdMs === undefined) return false; // OK, NEW_FOOD, NOT_MIXING, UNKNOWN, etc.
  const heldMs = Date.now() - new Date(state_held_since).getTime();
  return heldMs >= thresholdMs;
}

/** Returns the human-readable description string that would be written
 *  on an auto-created ticket. */
export function autoTicketDescription(
  classified_state: string,
  state_held_since: Date | string,
): string {
  const heldHours = Math.round(
    (Date.now() - new Date(state_held_since).getTime()) / 3_600_000,
  );
  return (
    `Auto-created from telemetry — unit held ${classified_state} for ${heldHours}h. ` +
    `State held since ${new Date(state_held_since).toLocaleString()}.`
  );
}

// ---- Telemetry auto-config types + hooks ----

export type TelemetryAutoConfig = {
  id: number;
  shadow_mode: boolean;
  enabled: boolean;
  updated_at: string;
};

/** Returns the singleton telemetry_autoticket_config row. */
export function useTelemetryAutoConfig(): {
  config: TelemetryAutoConfig | null;
  loading: boolean;
} {
  const [config, setConfig] = useState<TelemetryAutoConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('telemetry_autoticket_config')
        .select('*')
        .eq('id', 1)
        .maybeSingle();
      if (cancelled) return;
      if (!error && data) setConfig(data as TelemetryAutoConfig);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return { config, loading };
}

/** Update the singleton telemetry auto-ticket config row. */
export async function setTelemetryAutoConfig(
  shadow_mode: boolean,
  enabled: boolean,
): Promise<void> {
  const { error } = await supabase
    .from('telemetry_autoticket_config')
    .update({ shadow_mode, enabled, updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (error) throw error;
  await logAction('telemetry_autoconfig_updated', 'telemetry_autoticket_config',
    `shadow_mode=${shadow_mode} enabled=${enabled}`);
}
