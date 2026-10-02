import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';
import { logAction } from './activityLog';
import { cancelOrder, returnOrderToReview, type ReviewLanding } from './orders';
import { renderTemplate } from './templates';

export type FulfillmentStep = 1 | 2 | 3 | 4 | 5 | 6;
export type ShelfSlotStatus = 'available' | 'reserved' | 'rework' | 'empty' | 'held';

/** Which building a skid/pallet sits in. Mirrors shelf_slots_location_check. */
export type ShelfLocation = 'VentureLab' | 'Flex Space Logistics' | 'EZTrans' | 'US Warehouse';

/** Section order on the Shelf board. Declared here rather than derived from the
 *  rows so a site with no stock yet still renders as an empty section instead of
 *  silently disappearing. */
export const SHELF_SECTIONS: ReadonlyArray<{
  location: ShelfLocation;
  /** What the `skid` column means inside this section. */
  groupNoun: 'skid' | 'pallet';
  blurb: string;
  /** True while the site exists on paper but has no integration behind it. */
  pending?: boolean;
}> = [
  { location: 'VentureLab', groupNoun: 'skid',
    blurb: 'Our own floor. Machines here can be picked and shipped by the team.' },
  { location: 'Flex Space Logistics', groupNoun: 'pallet',
    blurb: 'No stock held here \u2014 every pallet moved to EZTrans on 14 Sep 2026.' },
  { location: 'EZTrans', groupNoun: 'pallet',
    blurb: 'Held at the 3PL, grouped by the pallet each unit arrived on.' },
  { location: 'US Warehouse', groupNoun: 'pallet',
    blurb: 'Not yet integrated \u2014 no stock is tracked here.', pending: true },
];

export type FulfillmentQueueRow = {
  id: string;
  order_id: string;
  step: FulfillmentStep;
  /** The FIRST unit assigned to this row, and nothing more than that.
   *
   *  It is a real column with a FK to units(serial), and a dozen reads plus the
   *  step-6 sync trigger are built on it, so it stays. On an order for three
   *  machines it names one of the three. Read `assigned_serials` for the set. */
  assigned_serial: string | null;
  /** Every unit assigned to this row, oldest pick first.
   *
   *  Derived from fulfillment_queue_units. Falls back to `[assigned_serial]` on
   *  a database that has not run 20261001130000_fulfillment_queue_units.sql yet
   *  — migrations here are applied by hand, so the board has to work either
   *  way. Never undefined; an unassigned row gives `[]`. */
  assigned_serials: string[];

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

  // The Goorooship day batch (20260929120000_eztrans_daily_batch.sql). Optional
  // because migrations here are applied by hand: select('*') on a database
  // that has not run it yet simply returns rows without them, and the batch
  // footer shows an empty day rather than throwing. See lib/eztransBatch.ts.
  eztrans_confirmed_at?: string | null;
  eztrans_confirmed_by?: string | null;
  eztrans_packing_list?: string | null;
  eztrans_batch_sent_at?: string | null;

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
  location: ShelfLocation;
  updated_at: string;
  // The underlying units.status, merged in by useShelf so the shelf tooltip
  // can explain *why* a slot is its colour (e.g. a 'held' slot because the
  // machine is in team-test vs. quarantine). Not a shelf_slots column.
  unit_status?: string | null;
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

/** A row of the child table as PostgREST embeds it. */
type EmbeddedUnit = { unit_serial: string; assigned_at: string };

/** True when the error is "that table/relationship isn't there" rather than a
 *  real failure. Migrations are applied by hand here, so a frontend deploy can
 *  land before the DDL does, and the queue board must not go blank when it
 *  does: 42P01 is Postgres' undefined_table, PGRST200 is PostgREST failing to
 *  find the embed relationship, and both mean the same thing to us. */
function isMissingRelation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === '42P01'
    || error.code === 'PGRST200'
    || /fulfillment_queue_units/.test(error.message ?? '');
}

/** The assigned set for a row, oldest pick first, with the single-serial
 *  fallback for a database that has not run the migration. */
function serialsOf(row: FulfillmentQueueRow & { fulfillment_queue_units?: EmbeddedUnit[] }): string[] {
  // Step 1 IS the assign step, so a row sitting on it has nothing assigned by
  // definition. Any link still attached is stale — a QC flag used to drop the
  // row back here while leaving its child rows behind — and showing it tells
  // the operator a machine is reserved for this customer when none is (#1286
  // carried six). Never surface it; assignUnits clears the rows for good the
  // next time the order is picked.
  if (row.step <= 1) return [];
  const embedded = row.fulfillment_queue_units;
  if (embedded && embedded.length > 0) {
    return [...embedded]
      .sort((a, b) => a.assigned_at.localeCompare(b.assigned_at))
      .map(u => u.unit_serial);
  }
  return row.assigned_serial ? [row.assigned_serial] : [];
}

/** Read the queue with its assigned units attached. Returns null if the read
 *  failed outright, so a caller can leave the last good cache in place. */
async function fetchQueueRows(): Promise<FulfillmentQueueRow[] | null> {
  const embedded = await supabase
    .from('fulfillment_queue')
    .select('*, fulfillment_queue_units(unit_serial, assigned_at)')
    .order('due_date', { ascending: true });

  if (!embedded.error && embedded.data) {
    return (embedded.data as Array<FulfillmentQueueRow & { fulfillment_queue_units?: EmbeddedUnit[] }>)
      .map(r => {
        const { fulfillment_queue_units: _embed, ...rest } = r;
        return { ...rest, assigned_serials: serialsOf(r) } as FulfillmentQueueRow;
      });
  }
  // Only fall back for a missing table — a genuine error should not be
  // papered over with a half-populated board.
  if (!isMissingRelation(embedded.error)) return null;

  const plain = await supabase
    .from('fulfillment_queue')
    .select('*')
    .order('due_date', { ascending: true });
  if (plain.error || !plain.data) return null;
  return (plain.data as FulfillmentQueueRow[])
    .map(r => ({
      ...r,
      assigned_serials: r.step > 1 && r.assigned_serial ? [r.assigned_serial] : [],
    }));
}

export function useFulfillmentQueue(): {
  all: FulfillmentQueueRow[];
  ready: FulfillmentQueueRow[];
  fulfilled: FulfillmentQueueRow[];
  loading: boolean;
  /** Re-read the queue from the DB. Call after a mutation whose result the
   *  operator is about to act on again — see the rejoin note below. */
  refresh: () => Promise<void>;
} {
  const [cache, setCache] = useState<FulfillmentQueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const liveRef = useRef(true);

  const refresh = useCallback(async () => {
    const rows = await fetchQueueRows();
    if (!liveRef.current) return;
    if (rows) setCache(rows);
  }, []);

  useEffect(() => {
    liveRef.current = true;
    let channel: RealtimeChannel | null = null;
    let unitsChannel: RealtimeChannel | null = null;
    let joined = false;

    (async () => {
      await refresh();
      if (!liveRef.current) return;
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
                // A realtime payload is the fulfillment_queue row alone — the
                // child table is not in it — so taking it wholesale would drop
                // the assigned set on every step move. Carry the known set
                // over; the unit channel below re-reads when it actually
                // changes. assigned_serial is the floor, for the row that was
                // just assigned on a database with no child table.
                const known = idx >= 0 ? prev[idx].assigned_serials : [];
                const merged = known.length > 0
                  ? known
                  : (row.assigned_serial ? [row.assigned_serial] : []);
                // …except back at step 1, where nothing is assigned: a flag
                // that rewinds the row must not leave the old set on screen.
                const next_row = {
                  ...row,
                  assigned_serials: row.step <= 1 ? [] : merged,
                };
                if (idx >= 0) { const next = [...prev]; next[idx] = next_row; return next; }
                return [...prev, next_row];
              }
              return prev;
            });
          },
        )
        // Every step move is written straight to the DB and nothing else here
        // re-reads, so realtime is the board's only route to seeing it. When the
        // socket drops, the cache freezes and the operator is left re-clicking an
        // action that already landed (prod, 2026-09-10: order #1252 rewound 5→4
        // four times in thirty seconds, all four writes landing, the step never
        // moving). Re-read on each rejoin so the gap heals itself. The first join
        // is skipped — the fetch above is current.
        .subscribe((status) => {
          if (status !== 'SUBSCRIBED') return;
          if (!joined) { joined = true; return; }
          void refresh();
        });

      // Assigning a second unit to a row writes only to the child table, so
      // the channel above would never hear about it. Re-read on any change
      // there rather than trying to patch the set from the payload. Silent
      // and harmless on a database with no such table — nothing ever fires.
      unitsChannel = supabase
        .channel('fulfillment_queue_units:realtime')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'fulfillment_queue_units' },
          () => { void refresh(); },
        )
        .subscribe();
    })();

    return () => {
      liveRef.current = false;
      // removeChannel, not unsubscribe: unsubscribe leaves the channel on the
      // client, so remounting the board opens a second channel on the same
      // topic, and that duplicate join is enough to take realtime down for the
      // rest of the session.
      if (channel) void supabase.removeChannel(channel);
      if (unitsChannel) void supabase.removeChannel(unitsChannel);
    };
  }, [refresh]);

  return useMemo(() => ({
    all: cache,
    ready: cache.filter(r => r.step < 6),
    fulfilled: cache.filter(r => r.step === 6),
    loading,
    refresh,
  }), [cache, loading, refresh]);
}

// --- useShelf ---

export function useShelf(): { slots: ShelfSlot[]; loading: boolean } {
  const [slots, setSlots] = useState<ShelfSlot[]>([]);
  const [unitStatus, setUnitStatus] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    // Merge units.status in by hand (no FK from shelf_slots.serial -> units)
    // so the tooltip can report the machine's actual state.
    const loadUnitStatuses = async (serials: string[]) => {
      if (!serials.length) return;
      const { data } = await supabase.from('units').select('serial, status').in('serial', serials);
      if (cancelled || !data) return;
      setUnitStatus(prev => {
        const next = { ...prev };
        for (const u of data as { serial: string; status: string }[]) next[u.serial] = u.status;
        return next;
      });
    };

    (async () => {
      const { data, error } = await supabase
        .from('shelf_slots')
        .select('*')
        .order('skid', { ascending: true })
        .order('slot_index', { ascending: true });
      if (cancelled) return;
      const rows = (!error && data) ? data as ShelfSlot[] : [];
      setSlots(rows);
      await loadUnitStatuses(rows.map(r => r.serial).filter(Boolean) as string[]);
      setLoading(false);

      channel = supabase
        .channel('shelf_slots:realtime')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'shelf_slots' },
          (payload) => {
            const row = payload.new as ShelfSlot | null;
            setSlots(prev => {
              if (!row) return prev;
              const idx = prev.findIndex(s => s.skid === row.skid && s.slot_index === row.slot_index);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [...prev, row];
            });
            // The status-sync trigger flips the slot whenever units.status
            // changes, so a shelf event is our cue to refresh the machine
            // status that drives the tooltip.
            if (row?.serial) void loadUnitStatuses([row.serial]);
          },
        )
        .subscribe();
    })();

    return () => { cancelled = true; if (channel) void channel.unsubscribe(); };
  }, []);

  const merged = useMemo(
    () => slots.map(s => (s.serial ? { ...s, unit_status: unitStatus[s.serial] ?? null } : s)),
    [slots, unitStatus],
  );

  return { slots: merged, loading };
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
/** How many machines an order is actually for.
 *
 *  Advisory, and deliberately not a gate: the picker shows it so an operator
 *  filling a three-machine order can see they have picked two, but it never
 *  blocks a confirm. What is physically on the pallet beats what a line item
 *  says, and a sale line can be something that is not a machine at all — one
 *  real order carries a line called "Unlock 30% Off in Cart" with qty 1.
 *
 *  So: replacement lines count only where they are a unit or a base, and legacy
 *  Shopify sale lines count only where the name looks like one of our machines.
 *  Anything unrecognised falls back to 1, never 0 — "assign at least one" is
 *  true of every order that reaches this step. */
export function orderUnitTarget(lineItems: unknown): number {
  if (!Array.isArray(lineItems)) return 1;
  let total = 0;
  for (const raw of lineItems) {
    if (!raw || typeof raw !== 'object') continue;
    const li = raw as { kind?: string; name?: string; qty?: number };
    const qty = Number.isFinite(li.qty) ? Number(li.qty) : 0;
    if (qty <= 0) continue;
    if (li.kind) {
      // A replacement line says what it is.
      if (['unit', 'unit_pending', 'base', 'base_pending'].includes(li.kind)) total += qty;
      continue;
    }
    // A legacy sale line does not, so go by the product name.
    if (/lila/i.test(li.name ?? '')) total += qty;
  }
  return total > 0 ? total : 1;
}

/** Every unit currently assigned to a queue row, oldest pick first.
 *
 *  Reads the child table, falling back to the row's own assigned_serial where
 *  the migration has not been applied (or for a row written straight to step 6
 *  by the replacement backfill path, which sets assigned_serial and no child
 *  rows). */
export async function assignedSerials(queueId: string, fallback: string | null): Promise<string[]> {
  const { data, error } = await supabase
    .from('fulfillment_queue_units')
    .select('unit_serial, assigned_at')
    .eq('queue_id', queueId)
    .order('assigned_at', { ascending: true });
  if (error) {
    if (!isMissingRelation(error)) throw new Error(`Could not read the assigned units: ${error.message}`);
    return fallback ? [fallback] : [];
  }
  const serials = (data ?? []).map(r => (r as { unit_serial: string }).unit_serial);
  if (serials.length > 0) return serials;
  return fallback ? [fallback] : [];
}

/** Assign one or more ready units to a queue row and advance it to step 2.
 *
 *  An order for three machines needs three machines reserved against it, or the
 *  other two stay sellable and get picked for somebody else. The queue row's
 *  own assigned_serial can hold one, so the set lives in
 *  fulfillment_queue_units and assigned_serial keeps the first — see the
 *  migration for why it is kept rather than replaced.
 *
 *  Ordering matters. The child-table insert goes FIRST, before any unit or
 *  shelf slot is touched: it is the write that can fail for a reason the
 *  operator cannot see coming (the table isn't there yet — migrations here are
 *  applied by hand), and failing it after reserving three machines would leave
 *  three units stamped against an order the queue has no record of. The one
 *  exception is a single-unit pick, which is allowed to proceed without the
 *  child table so the step keeps working exactly as it did before this feature
 *  on a database that has not run the migration.
 *
 *  Not transactional, as with the rest of this module. If it fails partway the
 *  recovery is in activity_log: a logged assignment with units still 'ready' is
 *  the signature, and re-running the assignment is safe (the insert ignores
 *  duplicates and the unit stamps are idempotent). */
export async function assignUnits(queueId: string, serials: string[], orderId: string): Promise<void> {
  const userId = await currentUserId();
  const picked = [...new Set(serials.map(s => s.trim()).filter(Boolean))];
  if (picked.length === 0) throw new Error('Pick at least one unit to assign.');

  // Look up the order so we can stamp each unit with who it's going to.
  const { data: order, error: oErr } = await supabase
    .from('orders')
    .select('order_ref, customer_name')
    .eq('id', orderId)
    .single();
  if (oErr) throw oErr;

  // Self-heal before reserving anything, and before the pickable check below —
  // a leftover reservation from this very row would otherwise fail that check.
  //
  // A row on step 1 is unassigned by definition, so whatever is still linked to
  // it is a leftover: from the old flag path, which rewound the row without
  // releasing, or from a release that died partway. Leaving it there means the
  // order holds two reservations for every machine it is actually for, and that
  // the step-6 trigger marks all of them shipped to this customer. Releasing is
  // safe — anything genuinely meant for this order is picked again, in this
  // call.
  const { data: qBefore, error: qbErr } = await supabase
    .from('fulfillment_queue')
    .select('step, assigned_serial')
    .eq('id', queueId)
    .maybeSingle();
  if (qbErr) throw qbErr;
  if ((qBefore?.step ?? 1) <= 1) {
    const stale = await releaseAssignedUnits(
      queueId,
      (qBefore?.assigned_serial as string | null) ?? null,
    );
    if (stale.length > 0) {
      await logAction(
        'fq_assign_cleared_stale',
        queueId,
        `Released ${stale.join(', ')} left over on step 1`,
      );
    }
  }

  // Backlog #57 — a unit that is already 'shipped' is being paired, not
  // picked (the historical-backfill flow): keep its status and stamp backfill
  // metadata instead of overwriting to 'reserved'. Read every picked unit in
  // one go so a bad pick is caught before anything is written.
  const { data: existing, error: rErr } = await supabase
    .from('units')
    .select('serial, status')
    .in('serial', picked);
  if (rErr) throw rErr;
  const statuses = new Map(
    (existing ?? []).map(u => [(u as { serial: string }).serial, (u as { status: string }).status]),
  );
  // Only 'ready' units are pickable; 'shipped' is allowed for the backfill
  // flow. Everything else — team-test, quarantine, scrap, lost, in-production,
  // etc. — is out of circulation and must not be reserved onto an order.
  const PICKABLE: ReadonlyArray<string> = ['ready', 'shipped'];
  for (const serial of picked) {
    const status = statuses.get(serial);
    if (!status || !PICKABLE.includes(status)) {
      throw new Error(
        `Unit ${serial} is '${status ?? 'unknown'}' and cannot be assigned to a fulfillment order.`,
      );
    }
  }

  // The fallible write, first — see the ordering note above.
  const { error: linkErr } = await supabase
    .from('fulfillment_queue_units')
    .upsert(
      picked.map(serial => ({
        queue_id: queueId,
        unit_serial: serial,
        assigned_by: userId,
        is_backfill: statuses.get(serial) === 'shipped',
      })),
      { onConflict: 'queue_id,unit_serial', ignoreDuplicates: true },
    );
  if (linkErr) {
    if (!isMissingRelation(linkErr)) {
      throw new Error(`Could not record the assigned units: ${linkErr.message}`);
    }
    if (picked.length > 1) {
      throw new Error(
        `Assigning ${picked.length} units needs a database migration that has not been applied yet `
        + '(20261001130000_fulfillment_queue_units.sql). Run the "Deploy Supabase backend" workflow '
        + 'with "Also run supabase db push" ticked, then try again. One unit at a time still works.',
      );
    }
    // Single pick on a pre-migration database: carry on, exactly as before.
  }

  for (const serial of picked) {
    const isBackfill = statuses.get(serial) === 'shipped';
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
  }

  // Advance the queue row. Backfilled assignments still go to step 2 so the
  // operator can manually click through the remaining steps; downstream
  // step actions are no-ops on an already-shipped unit but the operator
  // sees the trail in the queue.
  //
  // assigned_serial takes the first pick and is NOT overwritten on a later
  // top-up: it is what the FK and the older reads point at, and moving it
  // would silently re-point them at a different machine.
  const existingFirst = await assignedSerials(queueId, null);
  const first = existingFirst[0] ?? picked[0];
  const { error: qErr } = await supabase
    .from('fulfillment_queue')
    .update({ assigned_serial: first, step: 2 })
    .eq('id', queueId);
  if (qErr) throw qErr;

  const backfilled = picked.filter(s => statuses.get(s) === 'shipped');
  await logAction(
    backfilled.length === picked.length ? 'fq_assign_backfill' : 'fq_assign',
    queueId,
    backfilled.length === picked.length
      ? `Backfilled ${picked.join(', ')} (already shipped)`
      : `Assigned ${picked.join(', ')}`
        + (backfilled.length > 0 ? ` (${backfilled.join(', ')} already shipped — backfilled)` : ''),
  );
}

/** Single-unit assignment. Kept as the one-serial case of assignUnits. */
export async function assignUnit(queueId: string, serial: string, orderId: string): Promise<void> {
  return assignUnits(queueId, [serial], orderId);
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

/** Step 2 fail: flag rework → drops the order back to step 1 and releases
 *  every machine it had reserved.
 *
 *  A flag is Junaid's problem now, not the customer's: the flagged machine goes
 *  to rework and stops being owed to anybody, and its siblings go back into
 *  ready stock. Clearing `assigned_serial` alone is what this did before, and
 *  it left the real assignment behind in three places — the unit still stamped
 *  with the customer's name and order, the child-table link still naming it,
 *  and the step-6 sync trigger still ready to mark it 'shipped' to that
 *  customer. Order #1286 collected six such links across six flag/re-pick
 *  cycles, three of them machines already in rework.
 *
 *  The flagged unit is left 'rework' (the build_defects insert below promotes
 *  it by trigger) — only its customer stamps are cleared. Its siblings are
 *  still 'reserved', so the shared release path returns them to 'ready'. */
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

  // The flagged machine stops being this customer's. It stays 'rework' — it is
  // not sellable until Junaid clears the defect — but nothing should still
  // read it as reserved for the order.
  const { error: unstampErr } = await supabase
    .from('units')
    .update({ customer_order_ref: null, customer_name: null })
    .eq('serial', serial);
  if (unstampErr) throw new Error(`Failed to unassign ${serial}: ${unstampErr.message}`);

  // Everything else the row had reserved goes back into ready stock, and every
  // link is dropped: the row is about to sit on step 1, which means unassigned.
  const { data: qRow } = await supabase
    .from('fulfillment_queue')
    .select('assigned_serial')
    .eq('id', queueId)
    .maybeSingle();
  const released = await releaseAssignedUnits(
    queueId,
    (qRow?.assigned_serial as string | null) ?? null,
  );

  // Drop queue row to step 1 + clear assigned serial
  const { error: qErr } = await supabase
    .from('fulfillment_queue')
    .update({ step: 1, assigned_serial: null })
    .eq('id', queueId);
  if (qErr) throw qErr;
  await logAction(
    'fq_test_flagged',
    queueId,
    `${serial}: ${issue}`
    + (released.length > 0 ? ` — released ${released.join(', ')} back to ready` : ''),
  );

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
 *  cleared so Send email can be retried without "email already sent" 409.
 *  When rewinding from step 2 (assign), the reserved unit is released back
 *  to 'ready' so it becomes available for other orders (#26). */
export async function goBackStep(queueId: string, currentStep: FulfillmentStep): Promise<void> {
  await currentUserId();
  if (currentStep <= 1) throw new Error('already at the first step');
  if (currentStep > 6) throw new Error('invalid step');
  const prev = (currentStep - 1) as FulfillmentStep;
  const update: Record<string, unknown> = { step: prev };

  if (currentStep === 2) {
    // Undo the assignment: release EVERY unit on the row back to 'ready', not
    // just assigned_serial. Rewinding a three-machine order and freeing one of
    // them would leave two reserved against an order that is back at step 1
    // with nothing assigned — stock Sales cannot sell and the picker will not
    // offer. Backfilled (already-shipped) units are left alone, as ever; they
    // were never flipped to 'reserved' in the first place.
    const { data: qRow } = await supabase
      .from('fulfillment_queue')
      .select('assigned_serial')
      .eq('id', queueId)
      .single();
    await releaseAssignedUnits(queueId, (qRow?.assigned_serial as string | null) ?? null);
    update.assigned_serial = null;
  }

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
/** Carrier-specific pre-filled tracking URL. Mirrors trackingUrl() in the
 *  send-fulfillment-email edge function — keep the two switches in sync. */
export function trackingUrlFor(carrier: string | null, tracking: string | null): string {
  if (!tracking) return 'https://www.ups.com/track?loc=en_US';
  switch (carrier) {
    case 'UPS':          return `https://www.ups.com/track?tracknum=${encodeURIComponent(tracking)}`;
    case 'FedEx':        return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(tracking)}`;
    case 'Purolator':    return `https://www.purolator.com/en/shipping/tracker?pin=${encodeURIComponent(tracking)}`;
    case 'Canada Post':  return `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${encodeURIComponent(tracking)}`;
    case 'Canpar':       return `https://www.canpar.com/en/track/TrackingAction.do?reference=${encodeURIComponent(tracking)}`;
    case 'GLS':          return `https://gls-us.com/tracking?trackingNumber=${encodeURIComponent(tracking)}`;
    // Day & Ross has no documented deep link — their form posts the number
    // rather than reading it off the query string — so this is the search page
    // itself. Unprefilled, but the customer's own carrier: the default below
    // would hand a Day & Ross shipment a UPS tracking page.
    case 'Day & Ross':   return 'https://dayross.com/track-shipments';
    default:             return 'https://www.ups.com/track?loc=en_US';
  }
}

/** The {{variables}} the 'shipment_confirmation' template is rendered against.
 *  Built here so the Step-5 preview and the edge function agree on every value. */
export function shipmentEmailVars(
  row: Pick<FulfillmentQueueRow, 'carrier' | 'tracking_num' | 'starter_tracking_num'>,
  order: { customer_name: string; order_ref: string; country: 'US' | 'CA' },
): Record<string, string> {
  // US orders ship the compost starter kit separately through Amazon. Empty
  // on every CA order, which is why renderShipmentEmail strips the placeholder
  // rather than printing it.
  const starterBlock = order.country === 'US' && row.starter_tracking_num
    ? `\nCompost Starter Kit (ships separately via Amazon)\n\n` +
      `Starter Tracking Number: ${row.starter_tracking_num}\n`
    : '';
  return {
    customer_first_name: order.customer_name.split(' ')[0] ?? order.customer_name,
    order_ref: order.order_ref,
    carrier: row.carrier ?? '',
    tracking_num: row.tracking_num ?? '',
    tracking_url: trackingUrlFor(row.carrier, row.tracking_num),
    starter_block: starterBlock,
  };
}

/** renderTemplate() plus the starter_block exception: a missing variable stays
 *  visible as {{name}}, but an empty starter block is removed along with the
 *  newline after it. Mirrors render() in the send-fulfillment-email edge
 *  function — keep the two in sync. */
export function renderShipmentEmail(template: string, vars: Record<string, string>): string {
  const withBlock = template.replace(
    // No newline is consumed: the placeholder sits alone on its own line, so
    // dropping just the text leaves the blank line that separates the sections.
    /\{\{\s*starter_block\s*\}\}/g,
    () => vars.starter_block || '',
  );
  return renderTemplate(withBlock, vars);
}

/** Sends the Step-5 shipment confirmation.
 *
 *  `content` is the rendered subject/body exactly as the operator sees it in
 *  the queue — the edge function keeps no copy of the wording, so this is what
 *  gets sent. `edited` records whether they changed it by hand, for the audit
 *  row. Omitting `content` falls back to the stored template server-side. */
export async function sendFulfillmentEmail(
  queueId: string,
  content?: { subject: string; body: string; edited: boolean },
): Promise<{ email_id: string }> {
  await currentUserId();
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-fulfillment-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({
      queue_id: queueId,
      subject: content?.subject,
      body: content?.body,
      edited: content?.edited ?? false,
    }),
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

// ─── Leaving the queue: cancelled, or not ready to ship ─────────────────────

/** Release the unit a queue row picked at step 1 back into ready stock. Mirrors
 *  the step-2 rewind in goBackStep: only a unit that is still 'reserved' is
 *  touched, so a backfilled pairing (already 'shipped') is left alone. */
async function releaseAssignedUnit(serial: string | null): Promise<boolean> {
  if (!serial) return false;
  const { data: unit } = await supabase
    .from('units').select('status').eq('serial', serial).maybeSingle();
  if (unit?.status !== 'reserved') return false;
  const { error: uErr } = await supabase
    .from('units')
    .update({ status: 'ready', customer_order_ref: null, customer_name: null })
    .eq('serial', serial);
  if (uErr) throw new Error(`Failed to release unit ${serial}: ${uErr.message}`);
  const { error: sErr } = await supabase
    .from('shelf_slots')
    .update({ status: 'available', updated_at: new Date().toISOString() })
    .eq('serial', serial);
  if (sErr) throw new Error(`Failed to free the shelf slot for ${serial}: ${sErr.message}`);
  return true;
}

/** Put every unit assigned to a queue row back into sellable stock, and forget
 *  the assignments.
 *
 *  Releasing only assigned_serial would leave the other machines on a
 *  three-unit order reserved against an order that no longer exists — stock
 *  that Sales cannot sell and that no screen explains. Returns the serials
 *  actually released (a backfilled, already-shipped unit is left alone, as it
 *  always was). */
async function releaseAssignedUnits(queueId: string, fallback: string | null): Promise<string[]> {
  const serials = await assignedSerials(queueId, fallback);
  // Nothing linked, nothing to free — and no reason to issue a delete. The
  // common case (a first assignment on a clean row) should not write at all.
  if (serials.length === 0) return [];
  const released: string[] = [];
  for (const serial of serials) {
    if (await releaseAssignedUnit(serial)) released.push(serial);
  }
  // Delete after releasing: if a release throws, the links survive and the
  // operator can retry. Deleting first would lose the record of what to free.
  // (A deleted queue row takes its child rows with it via ON DELETE CASCADE;
  // this call is for the rewind case, where the row stays.)
  const { error } = await supabase
    .from('fulfillment_queue_units')
    .delete()
    .eq('queue_id', queueId);
  if (error && !isMissingRelation(error)) {
    throw new Error(`Failed to clear the assigned units: ${error.message}`);
  }
  return released;
}

type LeavingQueueRow = {
  id: string; order_id: string; step: number;
  assigned_serial: string | null; fulfilled_at: string | null;
};

/** Read the queue row and refuse to act on one that has already shipped —
 *  a fulfilled order is a returns/refunds problem, not a queue problem. */
async function loadRemovableQueueRow(queueId: string, action: string): Promise<LeavingQueueRow> {
  const { data, error } = await supabase
    .from('fulfillment_queue')
    .select('id, order_id, step, assigned_serial, fulfilled_at')
    .eq('id', queueId)
    .single();
  if (error || !data) throw new Error(`Queue row not found: ${error?.message ?? 'no row'}`);
  const row = data as LeavingQueueRow;
  if (row.step === 6 || row.fulfilled_at) {
    throw new Error(`This order has already shipped and cannot be ${action} from the queue.`);
  }
  return row;
}

/** Delete the queue row, verifying it actually went: an RLS-blocked delete
 *  returns 0 rows with no error, which would otherwise read as success. Done
 *  before any other write so a refusal leaves the order untouched. */
async function deleteQueueRow(queueId: string): Promise<void> {
  const { data, error } = await supabase
    .from('fulfillment_queue').delete().eq('id', queueId).select('id');
  if (error) throw new Error(`Could not remove the order from the queue: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error('The order was not removed from the queue (no permission, or it is already gone).');
  }
}

/** Take an order out of the fulfillment queue because its money went back.
 *
 *  Called when a refund is executed. The order may or may not be queued —
 *  usually it is not, which is why this reports a boolean rather than throwing.
 *  When it IS queued and has not shipped, the row goes and the machine picked
 *  for it returns to sellable stock: continuing to hold a unit for an order we
 *  have already refunded is a second loss on top of the first.
 *
 *  An order that has already shipped is left exactly as it is. The box is gone;
 *  that is a returns problem, and deleting the row would erase the only record
 *  of the shipment. */
export async function withdrawOrderFromQueue(orderId: string, reason: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('fulfillment_queue')
    .select('id, order_id, step, assigned_serial, fulfilled_at')
    .eq('order_id', orderId)
    .is('fulfilled_at', null)
    .maybeSingle();
  if (error || !data) return false;

  const row = data as LeavingQueueRow;
  if (row.step === 6 || row.fulfilled_at) return false;

  // Release before the row goes: deleting it cascades its unit links away,
  // and then nothing knows which machines to put back on the shelf.
  await releaseAssignedUnits(row.id, row.assigned_serial);
  await deleteQueueRow(row.id);
  await logAction('fq_withdrawn_refunded', row.id, reason);
  return true;
}

/** What releasing a hold actually did, so the banner can say it in one line. */
export type HoldRelease = {
  landing: ReviewLanding;
  /** True when a live fulfillment_queue row was pulled as part of the release. */
  queueRowRemoved: boolean;
  /** Serials actually put back into sellable stock. Plural because an order
   *  can be for more than one machine; empty when nothing was released (an
   *  unassigned row, or a backfilled unit that was never reserved). */
  releasedSerials: string[];
};

/** Order Review action — "Release hold". The way back out of a hold, and the
 *  mirror of disposition(order, 'held').
 *
 *  A hold had no exit. Holding is one click, but the only way back out of the
 *  Held tab was Confirm — which is gated on the pre-ship checks and sends the
 *  order straight to fulfillment. So an order held precisely BECAUSE it should
 *  never have been confirmed (#1214, confirmed and held 40 seconds apart) had
 *  nowhere to go, and the only fix was an UPDATE run by hand against the
 *  database.
 *
 *  A release returns the order to review, not to Confirmed: a hold means
 *  somebody stopped this order, so it earns its confirmation again rather than
 *  inheriting the one that was in place before.
 *
 *  It also pulls the queue row. A hold placed after a mis-click leaves one
 *  behind — auto_enqueue_approved_order fires on the confirm and nothing
 *  withdraws the row when the order is held again, so #1214 sat Held in Sales
 *  and step-1 Ready-to-ship in Fulfillment at the same time for 29 days. An
 *  order sitting in review must not still be pickable, so the row goes and its
 *  machine goes back on the shelf.
 *
 *  An order that has already shipped is refused outright: releasing it would
 *  put a shipped order back into Pending, and the box is already gone. */
export async function releaseHold(orderId: string, note?: string): Promise<HoldRelease> {
  await currentUserId();

  const { data: order, error: oErr } = await supabase
    .from('orders')
    .select('id, order_ref, status')
    .eq('id', orderId)
    .single();
  if (oErr || !order) throw new Error(`Order not found: ${oErr?.message ?? 'no row'}`);
  if (order.status !== 'held') throw new Error('This order is not on hold.');

  // Queue first. If this half refuses, the order stays Held rather than landing
  // in Pending with a live queue row still pointing at it.
  const { data: queued, error: qErr } = await supabase
    .from('fulfillment_queue')
    .select('id, order_id, step, assigned_serial, fulfilled_at')
    .eq('order_id', orderId)
    .maybeSingle();
  if (qErr) throw new Error(`Could not check the fulfillment queue: ${qErr.message}`);

  const row = (queued ?? null) as LeavingQueueRow | null;
  if (row && (row.step === 6 || row.fulfilled_at)) {
    throw new Error(
      `${order.order_ref} has already shipped, so its hold cannot be released here — `
      + 'handle it as a return or a refund instead.',
    );
  }

  let releasedSerials: string[] = [];
  if (row) {
    releasedSerials = await releaseAssignedUnits(row.id, row.assigned_serial);
    await deleteQueueRow(row.id);
  }

  // 'pending' is the intake state, so the disposition stamps go with it: the
  // order is back to having no decision on record, not still carrying the hold's.
  const landing = await returnOrderToReview(orderId, {
    dispositioned_by: null,
    dispositioned_at: null,
  });

  await logAction('order_hold_released', order.order_ref, note?.trim() || landing.label);
  return { landing, queueRowRemoved: !!row, releasedSerials };
}

/** Queue header action — "Cancel Order". The whole order is dead: it leaves the
 *  fulfillment queue, its unit goes back on the shelf, and the order is marked
 *  cancelled so it disappears from every Order Review tab. A cancelled sale
 *  surfaces in Shipping › Cancellations for the refund team (see cancelOrder). */
export async function cancelOrderFromQueue(queueId: string, reason: string): Promise<void> {
  await currentUserId();
  if (!reason.trim()) throw new Error('A reason is required to cancel an order.');
  const row = await loadRemovableQueueRow(queueId, 'cancelled');

  await releaseAssignedUnits(queueId, row.assigned_serial);
  await deleteQueueRow(queueId);
  await cancelOrder(row.order_id, reason);
  await logAction('fq_order_cancelled', queueId, reason.trim());
}

/** Queue header action — "Shipment Not Ready — Move Back to Orders". The order
 *  is fine, it just isn't shipping today: it leaves the queue, the unit picked
 *  for it goes back into ready stock, and the order returns to Order Review
 *  (Pending for a sale; Replacement › Ready or Awaiting Stock / Batch for a
 *  replacement, decided by the stock actually on hand). Approving it again
 *  re-enqueues it from scratch. */
export async function returnQueueRowToOrders(queueId: string, note?: string): Promise<ReviewLanding> {
  await currentUserId();
  const row = await loadRemovableQueueRow(queueId, 'moved back');

  await releaseAssignedUnits(queueId, row.assigned_serial);
  await deleteQueueRow(queueId);
  const landing = await returnOrderToReview(row.order_id);
  await logAction('fq_returned_to_orders', queueId, note?.trim() || landing.label);
  return landing;
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
