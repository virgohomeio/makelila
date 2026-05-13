import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';
import { logAction } from './activityLog';

export type TemplateCategory =
  | 'order_review' | 'fulfillment' | 'post_shipment'
  | 'returns_refunds' | 'replacements' | 'support';

export const CATEGORY_META: Record<TemplateCategory, { label: string; color: string; bg: string }> = {
  order_review:     { label: 'Order Review',     color: '#c53030', bg: '#fff5f5' },
  fulfillment:      { label: 'Fulfillment',      color: '#2b6cb0', bg: '#ebf8ff' },
  post_shipment:    { label: 'Post-Shipment',    color: '#553c9a', bg: '#faf5ff' },
  returns_refunds:  { label: 'Returns / Refunds',color: '#c05621', bg: '#fffaf0' },
  replacements:     { label: 'Replacements',     color: '#276749', bg: '#f0fff4' },
  support:          { label: 'Support',          color: '#718096', bg: '#f7fafc' },
};

export type EmailTemplate = {
  id: string;
  key: string;
  name: string;
  category: TemplateCategory;
  description: string | null;
  subject: string;
  body: string;
  variables: string[];
  channel: 'email' | 'sms';
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type EmailMessage = {
  id: string;
  template_key: string | null;
  recipient_email: string;
  recipient_name: string | null;
  subject: string;
  body: string;
  variables: Record<string, unknown> | null;
  status: 'queued' | 'sent' | 'bounced' | 'failed' | 'delivered';
  resend_id: string | null;
  error: string | null;
  related_return_id: string | null;
  related_refund_id: string | null;
  related_cancellation_id: string | null;
  sent_by: string | null;
  sent_at: string | null;
  created_at: string;
};

// ---------- hooks ----------

export function useEmailTemplates(): { templates: EmailTemplate[]; loading: boolean } {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('email_templates')
        .select('*')
        .order('category', { ascending: true })
        .order('name', { ascending: true });
      if (cancelled) return;
      if (!error && data) setTemplates(data as EmailTemplate[]);
      setLoading(false);

      channel = supabase
        .channel('email_templates:realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'email_templates' }, (payload) => {
          setTemplates(prev => {
            if (payload.eventType === 'DELETE' && payload.old) {
              return prev.filter(t => t.id !== (payload.old as { id: string }).id);
            }
            if (payload.new) {
              const row = payload.new as EmailTemplate;
              const idx = prev.findIndex(t => t.id === row.id);
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

  return { templates, loading };
}

export function useEmailMessages(): { messages: EmailMessage[]; loading: boolean } {
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('email_messages')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      if (cancelled) return;
      if (!error && data) setMessages(data as EmailMessage[]);
      setLoading(false);

      channel = supabase
        .channel('email_messages:realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'email_messages' }, (payload) => {
          setMessages(prev => {
            if (payload.eventType === 'DELETE' && payload.old) {
              return prev.filter(m => m.id !== (payload.old as { id: string }).id);
            }
            if (payload.new) {
              const row = payload.new as EmailMessage;
              const idx = prev.findIndex(m => m.id === row.id);
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

  return { messages, loading };
}

// ---------- helpers ----------

/** Render `{{variable}}` placeholders client-side (matches edge function logic
 *  exactly — keep in sync). Used for the live preview. */
export function renderTemplate(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => {
    const v = vars[name];
    if (v === undefined || v === null || v === '') return `{{${name}}}`;
    return String(v);
  });
}

// ---------- mutations ----------

export async function updateTemplate(id: string, patch: Partial<Pick<EmailTemplate, 'name' | 'description' | 'subject' | 'body' | 'category' | 'active'>>): Promise<void> {
  const { error } = await supabase.from('email_templates').update(patch).eq('id', id);
  if (error) throw error;
  await logAction('template_updated', id, Object.keys(patch).join(', '));
}

export async function sendTemplate(input: {
  template_key: string;
  to: string;
  to_name?: string;
  variables?: Record<string, string | undefined>;
  related_return_id?: string;
  related_refund_id?: string;
  related_cancellation_id?: string;
}): Promise<{ message_id: string; resend_id: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-template-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(input),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try { detail = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* keep raw */ }
    throw new Error(`Send template failed (${res.status}): ${detail}`);
  }
  const json = JSON.parse(text) as { message_id: string; resend_id: string };
  await logAction('template_sent', input.template_key, `→ ${input.to}`);
  return json;
}
