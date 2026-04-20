import { useEffect, useMemo, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { logAction } from './activityLog';

export type FulfillmentStep = 1 | 2 | 3 | 4 | 5 | 6;
export type ShelfSlotStatus = 'available' | 'reserved' | 'rework' | 'empty';

export type FulfillmentQueueRow = {
  id: string;
  order_id: string;
  step: FulfillmentStep;
  assigned_serial: string | null;

  test_report_url: string | null;
  test_confirmed_at: string | null;
  test_confirmed_by: string | null;

  carrier: string | null;
  tracking_num: string | null;
  label_pdf_path: string | null;
  label_confirmed_at: string | null;
  label_confirmed_by: string | null;

  dock_printed: boolean;
  dock_affixed: boolean;
  dock_docked: boolean;
  dock_notified: boolean;
  dock_confirmed_at: string | null;
  dock_confirmed_by: string | null;

  starter_tracking_num: string | null;
  email_sent_at: string | null;
  email_sent_by: string | null;

  fulfilled_at: string | null;
  fulfilled_by: string | null;

  due_date: string | null;
  priority: boolean;
  created_at: string;
};

export type ShelfSlot = {
  skid: string;
  slot_index: number;
  serial: string | null;
  batch: string | null;
  status: ShelfSlotStatus;
  updated_at: string;
};

export type UnitRework = {
  id: number;
  serial: string;
  skid: string | null;
  slot_index: number | null;
  order_id: string | null;
  issue: string;
  flagged_by: string;
  flagged_by_name: string;
  flagged_at: string;
  resolved_by: string | null;
  resolved_by_name: string | null;
  resolved_at: string | null;
  resolution_notes: string | null;
};

// --- useFulfillmentQueue ---

export function useFulfillmentQueue(): {
  all: FulfillmentQueueRow[];
  ready: FulfillmentQueueRow[];
  fulfilled: FulfillmentQueueRow[];
  loading: boolean;
} {
  const [cache, setCache] = useState<FulfillmentQueueRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('fulfillment_queue')
        .select('*')
        .order('due_date', { ascending: true });
      if (cancelled) return;
      if (!error && data) setCache(data as FulfillmentQueueRow[]);
      setLoading(false);

      channel = supabase
        .channel('fulfillment_queue:realtime')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'fulfillment_queue' },
          (payload) => {
            setCache(prev => {
              if (payload.eventType === 'DELETE' && payload.old) {
                return prev.filter(r => r.id !== (payload.old as { id: string }).id);
              }
              if (payload.new) {
                const row = payload.new as FulfillmentQueueRow;
                const idx = prev.findIndex(r => r.id === row.id);
                if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
                return [...prev, row];
              }
              return prev;
            });
          },
        )
        .subscribe();
    })();

    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return useMemo(() => ({
    all: cache,
    ready: cache.filter(r => r.step < 6),
    fulfilled: cache.filter(r => r.step === 6),
    loading,
  }), [cache, loading]);
}

// --- useShelf ---

export function useShelf(): { slots: ShelfSlot[]; loading: boolean } {
  const [slots, setSlots] = useState<ShelfSlot[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('shelf_slots')
        .select('*')
        .order('skid', { ascending: true })
        .order('slot_index', { ascending: true });
      if (cancelled) return;
      if (!error && data) setSlots(data as ShelfSlot[]);
      setLoading(false);

      channel = supabase
        .channel('shelf_slots:realtime')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'shelf_slots' },
          (payload) => {
            setSlots(prev => {
              const row = payload.new as ShelfSlot | null;
              if (!row) return prev;
              const idx = prev.findIndex(s => s.skid === row.skid && s.slot_index === row.slot_index);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [...prev, row];
            });
          },
        )
        .subscribe();
    })();

    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { slots, loading };
}

// --- useOpenReworks ---

export function useOpenReworks(): { reworks: UnitRework[]; loading: boolean } {
  const [reworks, setReworks] = useState<UnitRework[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('unit_reworks')
        .select('*')
        .is('resolved_at', null)
        .order('flagged_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) setReworks(data as UnitRework[]);
      setLoading(false);

      channel = supabase
        .channel('unit_reworks:realtime')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'unit_reworks' },
          (payload) => {
            setReworks(prev => {
              if (payload.eventType === 'INSERT' && payload.new) {
                return [payload.new as UnitRework, ...prev];
              }
              if (payload.eventType === 'UPDATE' && payload.new) {
                const row = payload.new as UnitRework;
                if (row.resolved_at) return prev.filter(r => r.id !== row.id);
                const idx = prev.findIndex(r => r.id === row.id);
                if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              }
              return prev;
            });
          },
        )
        .subscribe();
    })();

    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  return { reworks, loading };
}

// --- action functions ---

async function currentUserId(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error('fulfillment: not authenticated');
  return data.user.id;
}

/** Step 1: reserve the serial for this queue row; advance 1→2. */
export async function assignUnit(queueId: string, serial: string): Promise<void> {
  const userId = await currentUserId();
  // Reserve shelf slot
  const { error: slotErr } = await supabase
    .from('shelf_slots')
    .update({ status: 'reserved', updated_at: new Date().toISOString() })
    .eq('serial', serial);
  if (slotErr) throw slotErr;
  // Advance queue row
  const { error: qErr } = await supabase
    .from('fulfillment_queue')
    .update({ assigned_serial: serial, step: 2 })
    .eq('id', queueId);
  if (qErr) throw qErr;
  await logAction('fq_assign', queueId, `Assigned ${serial}`);
  void userId;
}

/** Step 2 pass: advance 2→3 with optional test report URL. */
export async function confirmTestReport(queueId: string, testReportUrl?: string): Promise<void> {
  const userId = await currentUserId();
  const { error } = await supabase
    .from('fulfillment_queue')
    .update({
      step: 3,
      test_report_url: testReportUrl?.trim() || null,
      test_confirmed_at: new Date().toISOString(),
      test_confirmed_by: userId,
    })
    .eq('id', queueId);
  if (error) throw error;
  await logAction('fq_test_ok', queueId, 'Test verified');
}

/** Step 2 fail: flag rework → drops order back to step 1; flips slot to 'rework'. */
export async function flagRework(
  queueId: string,
  serial: string,
  issue: string,
  flaggedByName: string,
): Promise<void> {
  const userId = await currentUserId();
  // Insert rework row
  const { error: rwErr } = await supabase.from('unit_reworks').insert({
    serial,
    issue,
    flagged_by: userId,
    flagged_by_name: flaggedByName,
  });
  if (rwErr) throw rwErr;
  // Flip shelf slot to rework
  const { error: slotErr } = await supabase
    .from('shelf_slots')
    .update({ status: 'rework', updated_at: new Date().toISOString() })
    .eq('serial', serial);
  if (slotErr) throw slotErr;
  // Drop queue row to step 1 + clear assigned serial
  const { error: qErr } = await supabase
    .from('fulfillment_queue')
    .update({ step: 1, assigned_serial: null })
    .eq('id', queueId);
  if (qErr) throw qErr;
  await logAction('fq_test_flagged', queueId, `${serial}: ${issue}`);
}

/** Step 3: upload PDF (optional) + save LILA carrier/tracking (and US starter tracking); advance 3→4. */
export async function confirmLabel(
  queueId: string,
  input: { carrier: string; tracking_num: string; label_pdf?: File; starter_tracking_num?: string },
): Promise<void> {
  const userId = await currentUserId();
  let label_pdf_path: string | null = null;
  if (input.label_pdf) {
    const path = `${queueId}/label-${Date.now()}.pdf`;
    const { error: upErr } = await supabase.storage
      .from('order-labels')
      .upload(path, input.label_pdf, { contentType: 'application/pdf' });
    if (upErr) throw upErr;
    label_pdf_path = path;
  }
  const starter = input.starter_tracking_num?.trim();
  const { error } = await supabase
    .from('fulfillment_queue')
    .update({
      step: 4,
      carrier: input.carrier,
      tracking_num: input.tracking_num,
      ...(label_pdf_path ? { label_pdf_path } : {}),
      ...(starter ? { starter_tracking_num: starter } : {}),
      label_confirmed_at: new Date().toISOString(),
      label_confirmed_by: userId,
    })
    .eq('id', queueId);
  if (error) throw error;
  await logAction(
    'fq_label_confirmed',
    queueId,
    `${input.carrier} · ${input.tracking_num}${starter ? ` · starter ${starter}` : ''}`,
  );
}

/** Go back one step on a queue row (undo accidental advancement).
 *  Data already saved (test report, label, etc.) is preserved; only the step
 *  counter moves back so the corresponding step UI is shown again. */
export async function goBackStep(queueId: string, currentStep: FulfillmentStep): Promise<void> {
  await currentUserId();
  if (currentStep <= 1) throw new Error('already at the first step');
  if (currentStep >= 6) throw new Error('cannot rewind a fulfilled order');
  const prev = (currentStep - 1) as FulfillmentStep;
  const { error } = await supabase
    .from('fulfillment_queue')
    .update({ step: prev })
    .eq('id', queueId);
  if (error) throw error;
  await logAction('fq_step_back', queueId, `Step ${currentStep} → ${prev}`);
}

/** Step 4: toggle one of the 4 dock checklist booleans. */
export async function toggleDockCheck(
  queueId: string,
  field: 'printed' | 'affixed' | 'docked' | 'notified',
  value: boolean,
): Promise<void> {
  const column = ({
    printed: 'dock_printed', affixed: 'dock_affixed',
    docked: 'dock_docked', notified: 'dock_notified',
  } as const)[field];
  const { error } = await supabase
    .from('fulfillment_queue')
    .update({ [column]: value })
    .eq('id', queueId);
  if (error) throw error;
}

/** Step 4: all 4 checks confirmed → advance 4→5. */
export async function confirmDock(queueId: string): Promise<void> {
  const userId = await currentUserId();
  const { error } = await supabase
    .from('fulfillment_queue')
    .update({
      step: 5,
      dock_confirmed_at: new Date().toISOString(),
      dock_confirmed_by: userId,
    })
    .eq('id', queueId);
  if (error) throw error;
  await logAction('fq_dock_confirmed', queueId, 'Dock check complete');
}

/** Step 5: US-only starter tracking input. */
export async function setStarterTracking(queueId: string, starter_tracking_num: string): Promise<void> {
  const { error } = await supabase
    .from('fulfillment_queue')
    .update({ starter_tracking_num })
    .eq('id', queueId);
  if (error) throw error;
}

/** Step 5: invoke edge function to send the email (advances 5→6). */
export async function sendFulfillmentEmail(queueId: string): Promise<{ email_id: string }> {
  await currentUserId();
  const { data, error } = await supabase.functions.invoke<{ email_id: string }>(
    'send-fulfillment-email',
    { body: { queue_id: queueId } },
  );
  if (error) {
    // FunctionsHttpError's generic message is "Edge Function returned a
    // non-2xx status code" which hides the actual reason. Read the response
    // body (JSON { error } if available, otherwise raw text) so the UI can
    // show something useful.
    const ctx = (error as { context?: Response }).context;
    let detail = '';
    if (ctx && typeof ctx.text === 'function') {
      try {
        const body = await ctx.text();
        try {
          const parsed = JSON.parse(body) as { error?: string };
          detail = parsed.error ?? body;
        } catch { detail = body; }
      } catch { /* swallow */ }
    }
    throw new Error(detail ? `Send email failed: ${detail}` : error.message);
  }
  if (!data) throw new Error('send-fulfillment-email returned no data');
  return data;
}

/** Sales action: flag or un-flag a queue row as priority. Prioritized rows
 *  float to the top of the sidebar so packers see them first. */
export async function setQueuePriority(queueId: string, priority: boolean): Promise<void> {
  await currentUserId();
  const { error } = await supabase
    .from('fulfillment_queue')
    .update({ priority })
    .eq('id', queueId);
  if (error) throw error;
  await logAction(
    priority ? 'fq_prioritized' : 'fq_unprioritized',
    queueId,
    priority ? 'Marked priority' : 'Cleared priority',
  );
}

/** Swap two shelf slots atomically via Postgres RPC.
 *  The UNIQUE(serial) constraint on shelf_slots prevents a client-side two-UPDATE
 *  approach (both slots would briefly share the same serial). The swap_shelf_slots
 *  function runs a 3-step swap (clear A → move A→B → move B→A) in a single
 *  transaction so failure rolls back atomically. */
export async function swapSlots(
  a: { skid: string; slot_index: number },
  b: { skid: string; slot_index: number },
): Promise<void> {
  await currentUserId();
  const { error } = await supabase.rpc('swap_shelf_slots', {
    a_skid: a.skid, a_slot_index: a.slot_index,
    b_skid: b.skid, b_slot_index: b.slot_index,
  });
  if (error) throw error;
}

/** UX checkpoint: logs that the current shelf layout was reviewed. */
export async function confirmShelfLayout(): Promise<void> {
  await currentUserId();
  await logAction('shelf_layout_saved', 'Shelf', 'Layout reviewed');
}

/** Resolve an open rework → flip the slot back to available. */
export async function resolveRework(
  reworkId: number,
  serial: string,
  notes: string | undefined,
  resolvedByName: string,
): Promise<void> {
  const userId = await currentUserId();
  const { error: rwErr } = await supabase
    .from('unit_reworks')
    .update({
      resolved_at: new Date().toISOString(),
      resolved_by: userId,
      resolved_by_name: resolvedByName,
      resolution_notes: notes?.trim() || null,
    })
    .eq('id', reworkId);
  if (rwErr) throw rwErr;
  const { error: slotErr } = await supabase
    .from('shelf_slots')
    .update({ status: 'available', updated_at: new Date().toISOString() })
    .eq('serial', serial);
  if (slotErr) throw slotErr;
  await logAction('rework_resolved', serial, notes ?? 'Resolved');
}
