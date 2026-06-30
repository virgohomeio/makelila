import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { logAction } from './activityLog';
import { STATUS_FILTERS, type FollowUpStatusKey } from './followupStatus';

// Status keys that are purely date-derived — never operator-applied.
const DATE_DERIVED: FollowUpStatusKey[] = ['overdue', 'due_today', 'due_7d', 'fu_on_hold', 'diag_followup_due'];

/** Status keys an operator may apply manually (additive to the derived ones). */
export const MANUAL_TAGS: FollowUpStatusKey[] = STATUS_FILTERS
  .map(f => f.key)
  .filter(k => !DATE_DERIVED.includes(k));

const VALID_KEYS = new Set<string>(STATUS_FILTERS.map(f => f.key));

/** Union validated manual tags into a derived status set. Pure. */
export function mergeManualTags(
  derived: Set<FollowUpStatusKey>, manual: string[] | null,
): Set<FollowUpStatusKey> {
  const out = new Set(derived);
  for (const t of manual ?? []) if (VALID_KEYS.has(t)) out.add(t as FollowUpStatusKey);
  return out;
}

export type ActionItem = {
  id: string; customer_id: string; text: string; due_date: string | null;
  done: boolean; done_at: string | null; created_by: string | null;
  created_at: string; updated_at: string;
};
export type CustomerNote = {
  id: string; customer_id: string; body: string; author_id: string | null; created_at: string;
};

export function useActionItems(customerId: string | null): {
  items: ActionItem[]; loading: boolean; refresh: () => void;
} {
  const [items, setItems] = useState<ActionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!customerId) { setItems([]); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data } = await supabase.from('customer_action_items')
        .select('*').eq('customer_id', customerId)
        .order('done', { ascending: true })
        .order('due_date', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true });
      if (!cancelled) { setItems((data ?? []) as ActionItem[]); setLoading(false); }
    })().catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [customerId, tick]);
  return { items, loading, refresh: () => setTick(t => t + 1) };
}

export function useCustomerNotes(customerId: string | null): {
  notes: CustomerNote[]; loading: boolean; refresh: () => void;
} {
  const [notes, setNotes] = useState<CustomerNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!customerId) { setNotes([]); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data } = await supabase.from('customer_notes')
        .select('*').eq('customer_id', customerId).order('created_at', { ascending: false });
      if (!cancelled) { setNotes((data ?? []) as CustomerNote[]); setLoading(false); }
    })().catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [customerId, tick]);
  return { notes, loading, refresh: () => setTick(t => t + 1) };
}

export async function addActionItem(
  customerId: string, text: string, dueDate: string | null = null,
): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from('customer_action_items')
    .insert({ customer_id: customerId, text: text.trim(), due_date: dueDate, created_by: user?.id ?? null });
  if (error) throw error;
  await logAction('action_item_added', customerId, text.trim().slice(0, 120),
    { entityType: 'customer', entityId: customerId });
}

export async function toggleActionItem(id: string, done: boolean): Promise<void> {
  const { error } = await supabase.from('customer_action_items')
    .update({ done, done_at: done ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteActionItem(id: string): Promise<void> {
  const { error } = await supabase.from('customer_action_items').delete().eq('id', id);
  if (error) throw error;
}

export async function addCustomerNote(customerId: string, body: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from('customer_notes')
    .insert({ customer_id: customerId, body: body.trim(), author_id: user?.id ?? null });
  if (error) throw error;
  await logAction('customer_note_added', customerId, body.trim().slice(0, 120),
    { entityType: 'customer', entityId: customerId });
}

export async function deleteCustomerNote(noteId: string, customerId: string): Promise<void> {
  const { error } = await supabase.from('customer_notes').delete().eq('id', noteId);
  if (error) throw error;
  await logAction('customer_note_deleted', customerId, noteId,
    { entityType: 'customer', entityId: customerId });
}

export async function setCustomerManualTags(customerId: string, tags: string[]): Promise<void> {
  const clean = [...new Set(tags.filter(t => VALID_KEYS.has(t)))];
  const { error } = await supabase.from('customers').update({ manual_status_tags: clean }).eq('id', customerId);
  if (error) throw error;
  await logAction('customer_tags_set', customerId, clean.join(', ') || '(none)',
    { entityType: 'customer', entityId: customerId });
}
