import { useEffect, useMemo, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';
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
  dock_picked_up: boolean;
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

/** Step 1: reserve a ready unit for this order; advance 1→2.
 *  Stock (units.status) is the source of truth — flip the unit ready→reserved
 *  and stamp the order on it. The shelf slot is kept in sync for the shelf view. */
export async function assignUnit(queueId: string, serial: string, orderId: string): Promise<void> {
  await currentUserId();
  // Look up the order so we can stamp the unit with who it's going to.
  const { data: order, error: oErr } = await supabase
    .from('orders')
    .select('order_ref, customer_name')
    .eq('id', orderId)
    .single();
  if (oErr) throw oErr;
  // Backlog #57 — if the picked unit is already 'shipped' (Raymond's
  // backfill flow: pairing a unit that left the warehouse before makelila
  // was the system of record), preserve its status and stamp backfill
  // metadata instead of overwriting to 'reserved'.
  const { data: existing, error: rErr } = await supabase
    .from('units').select('status').eq('serial', serial).single();
  if (rErr) throw rErr;
  // quarantine excluded — do not pick quarantined units
  if (existing?.status === 'quarantine') {
    throw new Error(`Unit ${serial} is quarantined and cannot be assigned to a fulfillment order.`);
  }
  const isBackfill = existing?.status === 'shipped';
  const patch: Record<string, unknown> = isBackfill
    ? {
        customer_order_ref: order.order_ref,
        customer_name: order.customer_name,
        backfilled_at: new Date().toISOString(),
        backfill_source: 'manual-backfill',
      }
    : { status: 'reserved', customer_order_ref: order.order_ref, customer_name: order.customer_name };
  const { error: uErr } = await supabase.from('units').update(patch).eq('serial', serial);
  if (uErr) throw uErr;
  // Keep the physical shelf view in sync (no-op if the unit isn't on a slot).
  const { error: slotErr } = await supabase
    .from('shelf_slots')
    .update({ status: 'reserved', updated_at: new Date().toISOString() })
    .eq('serial', serial);
  if (slotErr) throw slotErr;
  // Advance queue row. Backfilled assignments still go to step 2 so the
  // operator can manually click through the remaining steps; downstream
  // step actions are no-ops on an already-shipped unit but the operator
  // sees the trail in the queue.
  const { error: qErr } = await supabase
    .from('fulfillment_queue')
    .update({ assigned_serial: serial, step: 2 })
    .eq('id', queueId);
  if (qErr) throw qErr;
  await logAction(
    isBackfill ? 'fq_assign_backfill' : 'fq_assign',
    queueId,
    isBackfill ? `Backfilled ${serial} (already shipped)` : `Assigned ${serial}`,
  );
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
  const { error: rwErr } = await supabase.from('build_defects').insert({
    unit_serial: serial,
    category: 'assembly',
    subject: `QC flag: ${issue.slice(0, 80)}`,
    description: issue,
    severity: 'high',
    status: 'in_rework',
    found_by: userId,
    found_by_name: flaggedByName,
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

  // Also create a service_tickets row so the Service module's Repair
  // tab picks this up. Idempotent on fulfillment_queue_id; if the
  // ticket insert fails we just log — the QC flag already succeeded.
  try {
    const { data: existing } = await supabase
      .from('service_tickets')
      .select('id')
      .eq('fulfillment_queue_id', queueId)
      .eq('source', 'fulfillment_flag')
      .maybeSingle();
    if (!existing) {
      const { error: tErr } = await supabase
        .from('service_tickets')
        .insert({
          category:             'repair',
          source:               'fulfillment_flag',
          status:               'waiting_on_us',
          priority:             'high',
          unit_serial:          serial,
          subject:              `QC flag: ${issue}`,
          description:          `Flagged at fulfillment QC by ${flaggedByName}.`,
          fulfillment_queue_id: queueId,
          owner_email:          'junaid@virgohome.io',
        });
      if (tErr) console.warn('Service ticket insert failed (non-fatal):', tErr.message);
    }
  } catch (e) {
    console.warn('Service ticket insert threw (non-fatal):', (e as Error).message);
  }
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
 *  counter moves back so the corresponding step UI is shown again. When
 *  rewinding from step 6 (fulfilled), email_sent_at and fulfilled_at are
 *  cleared so Send email can be retried without "email already sent" 409. */
export async function goBackStep(queueId: string, currentStep: FulfillmentStep): Promise<void> {
  await currentUserId();
  if (currentStep <= 1) throw new Error('already at the first step');
  if (currentStep > 6) throw new Error('invalid step');
  const prev = (currentStep - 1) as FulfillmentStep;
  const update: Record<string, unknown> = { step: prev };
  if (currentStep === 6) {
    update.email_sent_at = null;
    update.email_sent_by = null;
    update.fulfilled_at = null;
    update.fulfilled_by = null;
  }
  const { error } = await supabase
    .from('fulfillment_queue')
    .update(update)
    .eq('id', queueId);
  if (error) throw error;
  await logAction('fq_step_back', queueId, `Step ${currentStep} → ${prev}`);
}

/** Step 4: toggle one of the dock checklist booleans. */
export async function toggleDockCheck(
  queueId: string,
  field: 'printed' | 'affixed' | 'docked' | 'notified' | 'picked_up',
  value: boolean,
): Promise<void> {
  const column = ({
    printed: 'dock_printed', affixed: 'dock_affixed',
    docked: 'dock_docked', notified: 'dock_notified',
    picked_up: 'dock_picked_up',
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

/** Step 5: invoke edge function to send the email (advances 5→6).
 *  Uses direct fetch rather than supabase.functions.invoke so the response
 *  body can be read on non-2xx (functions.invoke consumes it internally and
 *  exposes only "Edge Function returned a non-2xx status code"). */
export async function sendFulfillmentEmail(queueId: string): Promise<{ email_id: string }> {
  await currentUserId();
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-fulfillment-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ queue_id: queueId }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    let detail = bodyText;
    try {
      const parsed = JSON.parse(bodyText) as { error?: string };
      if (parsed.error) detail = parsed.error;
    } catch { /* keep raw */ }
    throw new Error(`Send email failed (${res.status}): ${detail}`);
  }
  try { return JSON.parse(bodyText) as { email_id: string }; }
  catch { throw new Error('Send email: response was not JSON'); }
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

// ─── fulfillment_log (historical Excel-imported records) ────────────────────

export type FulfillmentLogRow = {
  id: string;
  source_tab: string;       // 'Canada Shipping' | 'US Shipping' | 'Replacement' | 'Personal Delivery'
  source_row: number | null;
  shipping_date: string | null;
  ticket_date: string | null;
  order_date: string | null;
  delivery_window: string | null;
  customer_name: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  batch: string | null;
  color: string | null;
  serial_number: string | null;
  tracking_number: string | null;
  carrier: string | null;
  price: number | null;
  update_status: string | null;
  replacement_batch: string | null;
  starter_ordered: string | null;
  amazon_tracking_id: string | null;
  starter_delivery: string | null;
  notes: string | null;
  imported_at: string;
};

/** Historical fulfillment records imported from the LILA customer
 *  fulfillment Excel. Used by the Fulfillment module's History tab to
 *  show shipped orders that don't go through the in-app
 *  approval/queue/ship workflow (e.g. older sales, personal-delivery
 *  replacements, anything already shipped before makelila existed). */
export function useFulfillmentLog(): { rows: FulfillmentLogRow[]; loading: boolean } {
  const [rows, setRows] = useState<FulfillmentLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('fulfillment_log')
        .select('*')
        .order('shipping_date', { ascending: false, nullsFirst: false })
        .order('customer_name', { ascending: true });
      if (cancelled) return;
      if (!error && data) setRows(data as FulfillmentLogRow[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);
  return { rows, loading };
}

// ---- Stock-side "Assign to Order" support ----

export type QueueItemForAssignment = {
  queueId: string;
  orderId: string;
  orderRef: string;
  customerName: string | null;
};

/** Returns fulfillment queue rows at step 1 (awaiting unit assignment).
 *  Used by the Stock UnitTable to let operators start from the physical unit. */
export async function fetchUnassignedQueueItems(): Promise<QueueItemForAssignment[]> {
  const { data, error } = await supabase
    .from('fulfillment_queue')
    .select('id, order_id, orders(order_ref, customer_name)')
    .eq('step', 1)
    .is('assigned_serial', null);
  if (error) throw error;
  return (data ?? []).map((r: Record<string, unknown>) => {
    const ord = r.orders as { order_ref: string; customer_name: string | null } | null;
    return {
      queueId:      r.id as string,
      orderId:      r.order_id as string,
      orderRef:     ord?.order_ref ?? (r.order_id as string),
      customerName: ord?.customer_name ?? null,
    };
  });
}
