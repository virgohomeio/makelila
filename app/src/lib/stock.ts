import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { logAction, useActivityForEntity } from './activityLog';
import { supabaseTelemetry, isTelemetryConfigured } from './supabaseTelemetry';

export type UnitStatus =
  | 'in-production' | 'inbound' | 'cn-test' | 'ca-test'
  | 'ready' | 'reserved' | 'rework'
  | 'shipped' | 'team-test' | 'scrap' | 'lost' | 'quarantine';

export type StatusCategory = 'inbound' | 'warehouse' | 'out';

export const STATUS_META: Record<UnitStatus, {
  label: string;
  category: StatusCategory;
  color: string;          // text color
  bg: string;             // background
  border: string;
}> = {
  'in-production': { label: 'In Production', category: 'inbound',   color: '#6b46c1', bg: '#faf5ff', border: '#d6bcfa' },
  'inbound':       { label: 'Inbound',       category: 'inbound',   color: '#2b6cb0', bg: '#ebf8ff', border: '#bee3f8' },
  'cn-test':       { label: 'CN Test',       category: 'inbound',   color: '#b7791f', bg: '#fffbeb', border: '#ecc94b' },
  'ca-test':       { label: 'CA Test',       category: 'inbound',   color: '#975a16', bg: '#fffbeb', border: '#f6ad55' },
  'ready':         { label: 'Ready',         category: 'warehouse', color: '#276749', bg: '#f0fff4', border: '#9ae6b4' },
  'reserved':      { label: 'Reserved',      category: 'warehouse', color: '#c05621', bg: '#fffaf0', border: '#fbd38d' },
  'rework':        { label: 'Rework',        category: 'warehouse', color: '#9b2c2c', bg: '#fff5f5', border: '#fc8181' },
  'shipped':       { label: 'Shipped',       category: 'out',       color: '#2b6cb0', bg: '#ebf8ff', border: '#bee3f8' },
  'team-test':     { label: 'Team Test',     category: 'out',       color: '#744210', bg: '#fffbeb', border: '#f6ad55' },
  'scrap':         { label: 'Scrap',         category: 'out',       color: '#9b2c2c', bg: '#fff5f5', border: '#fc8181' },
  'lost':          { label: 'Lost',          category: 'out',       color: '#c53030', bg: '#fff5f5', border: '#fc8181' },
  'quarantine':    { label: 'Quarantined',   category: 'warehouse', color: '#702459', bg: '#fff5f7', border: '#f687b3' },
};

export const STATUS_ORDER: UnitStatus[] = [
  'in-production','inbound','cn-test','ca-test',
  'ready','reserved','rework',
  'shipped','team-test','scrap','lost','quarantine',
];

/** Defensive lookup: if a unit somehow has a status that isn't in
 *  STATUS_META (e.g. a DB migration shipped a new status before the
 *  frontend was redeployed), fall back to a neutral gray pill so the
 *  whole page doesn't blank out on `STATUS_META[status].category`. */
const UNKNOWN_META = {
  label: 'Unknown',
  category: 'warehouse' as StatusCategory,
  color: '#4a5568',
  bg: '#f7fafc',
  border: '#cbd5e1',
};
export function getStatusMeta(s: string | null | undefined) {
  if (!s) return UNKNOWN_META;
  return (STATUS_META as Record<string, typeof UNKNOWN_META>)[s] ?? UNKNOWN_META;
}

export type Batch = {
  id: string;
  version: string | null;
  manufacturer: string;
  manufacturer_short: string | null;
  incoterm: string | null;
  unit_cost_usd: number | null;
  total_cost_usd: number | null;
  unit_count: number;
  invoice_no: string | null;
  invoice_date: string | null;
  arrived_at: string | null;
  destination: string | null;
  notes: string | null;
  phases: Array<{ phase: string; start: string; end: string; label: string }>;
  created_at: string;
};

export type UnitColor = 'White' | 'Black';

export type QcCheck = 'pass' | 'fail' | 'incomplete';

export const QC_CHECK_META: Record<QcCheck, { label: string; color: string; bg: string }> = {
  pass:       { label: 'PASS',       color: '#276749', bg: '#f0fff4' },
  fail:       { label: 'FAIL',       color: '#9b2c2c', bg: '#fff5f5' },
  incomplete: { label: 'INCOMPLETE', color: '#c05621', bg: '#fffaf0' },
};

export type Unit = {
  serial: string;
  batch: string;
  status: UnitStatus;
  color: UnitColor | null;
  location: string | null;
  customer_name: string | null;
  // Canonical FK to customers.id (backlog #67). Set by the migration's
  // one-shot cascade for ~65% of historical units; new units should set
  // this at fulfillment-assignment time (follow-up). customer_name stays
  // as a denormalized display cache for now.
  customer_id: string | null;
  customer_order_ref: string | null;
  carrier: string | null;
  firmware_version: string | null;
  defect_reason: string | null;
  tracking_num: string | null;
  shipped_at: string | null;
  notes: string | null;
  status_updated_at: string;
  status_updated_by: string | null;
  created_at: string;
  // Alpha P2 #5 — machine-level QC tracking (replaces Feishu)
  technician: string | null;
  electrical_check: QcCheck | null;
  mechanical_check: QcCheck | null;
  defect_notes: string | null;
  // Uploaded electrical test report (.md) in the 'test-reports' storage bucket.
  electrical_failed_tests: string | null;  // comma-joined failed test names from the report
  test_report_path: string | null;
  test_report_name: string | null;
  test_report_uploaded_at: string | null;
  // Backlog #59 — true for units the team uses for internal testing.
  // Default-filtered out of Dashboard / Customers / profitability rollups
  // so internal noise doesn't distort real-customer signals.
  is_team_test: boolean;
  // Backlog #57 — non-null on units paired via Raymond's backfill flow
  // (already shipped before makelila tracked them).
  backfilled_at: string | null;
  backfill_source: string | null;
};

// ---------- hooks ----------

export function useBatches(): { batches: Batch[]; loading: boolean } {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('batches')
        .select('*')
        .order('invoice_date', { ascending: true, nullsFirst: false });
      if (cancelled) return;
      if (!error && data) setBatches(data as Batch[]);
      setLoading(false);

      channel = supabase
        .channel('batches:realtime')
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'batches' },
          (payload) => {
            setBatches(prev => {
              if (payload.eventType === 'DELETE' && payload.old) {
                return prev.filter(b => b.id !== (payload.old as { id: string }).id);
              }
              if (payload.new) {
                const row = payload.new as Batch;
                const idx = prev.findIndex(b => b.id === row.id);
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

  return { batches, loading };
}

export function useUnits(): { units: Unit[]; loading: boolean } {
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('units')
        .select('*')
        .order('serial', { ascending: true });
      if (cancelled) return;
      if (!error && data) setUnits(data as Unit[]);
      setLoading(false);

      channel = supabase
        .channel('units:realtime')
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'units' },
          (payload) => {
            setUnits(prev => {
              if (payload.eventType === 'DELETE' && payload.old) {
                return prev.filter(u => u.serial !== (payload.old as { serial: string }).serial);
              }
              if (payload.new) {
                const row = payload.new as Unit;
                const idx = prev.findIndex(u => u.serial === row.serial);
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

  return { units, loading };
}

// ---------- aggregation helpers ----------

export function useStatusCountsByBatch(units: Unit[]): Map<string, Record<UnitStatus, number>> {
  return useMemo(() => {
    const m = new Map<string, Record<UnitStatus, number>>();
    for (const u of units) {
      let row = m.get(u.batch);
      if (!row) {
        row = { 'in-production':0,'inbound':0,'cn-test':0,'ca-test':0,
          'ready':0,'reserved':0,'rework':0,
          'shipped':0,'team-test':0,'scrap':0,'lost':0,'quarantine':0 };
        m.set(u.batch, row);
      }
      row[u.status]++;
    }
    return m;
  }, [units]);
}

// ---------- mutations ----------

async function currentUserId(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error('stock: not authenticated');
  return data.user.id;
}

export async function updateUnitStatus(
  serial: string,
  newStatus: UnitStatus,
  noteAppend?: string,
): Promise<void> {
  const userId = await currentUserId();
  const { data: existing } = await supabase
    .from('units').select('notes, status').eq('serial', serial).single();
  const nextNotes = noteAppend
    ? [existing?.notes ?? '', noteAppend].filter(Boolean).join('\n')
    : existing?.notes ?? null;
  const { error } = await supabase
    .from('units')
    .update({ status: newStatus, status_updated_by: userId, notes: nextNotes })
    .eq('serial', serial);
  if (error) throw error;
  await logAction('stock_status', serial, `${existing?.status ?? '?'} → ${newStatus}`,
    { entityType: 'unit', unitSerial: serial });
}

/** Backlog #69 — explicitly link an unmatched unit to a canonical customer
 *  without modifying the legacy customer_name string (preserves operator
 *  context like "(test)" / "(original)" suffixes that distinguish this
 *  shipment from a regular sale). */
export async function linkUnitToCustomer(serial: string, customerId: string): Promise<void> {
  await currentUserId();
  const { error } = await supabase.from('units').update({ customer_id: customerId }).eq('serial', serial);
  if (error) throw error;
  await logAction('stock_link_customer', serial, `customer_id=${customerId}`,
    { entityType: 'unit', unitSerial: serial });
}

export async function updateUnitFields(
  serial: string,
  patch: Partial<Pick<Unit,
    'color' | 'location' | 'customer_name' | 'customer_order_ref' |
    'carrier' | 'firmware_version' | 'defect_reason' | 'shipped_at' | 'notes' |
    'technician' | 'electrical_check' | 'mechanical_check' | 'defect_notes'
  >>,
): Promise<void> {
  await currentUserId();
  const { error } = await supabase.from('units').update(patch).eq('serial', serial);
  if (error) throw error;
  await logAction('stock_edit', serial, Object.keys(patch).join(', '),
    { entityType: 'unit', unitSerial: serial });
}

// ── UnitTimeline ──────────────────────────────────────────────────────────────

export interface TimelineEvent {
  id: string;
  ts: string;              // ISO timestamp
  kind: 'built' | 'qc_passed' | 'qc_failed' | 'shipped' | 'returned' | 'quarantined'
       | 'ticket_opened' | 'ticket_resolved' | 'telemetry_event' | 'activity';
  label: string;           // short display text
  detail?: string;         // optional sub-text
  source: 'activity_log' | 'service_tickets' | 'returns' | 'unit_test_reports'
         | 'fulfillment_log' | 'telemetry';
}

/** Merge and sort a flat array of timeline events descending by ts. */
export function mergeTimelineEvents(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((a, b) => b.ts.localeCompare(a.ts));
}

/** Telemetry cache: shared across all hook instances for the same serial.
 *  Avoids re-fetching on every render; entries expire after 60 seconds. */
const telemetryCache = new Map<string, { events: TimelineEvent[]; fetchedAt: number }>();
const TELEMETRY_TTL_MS = 60_000;

/** `useUnitTimeline` merges chronological events from multiple sources for a
 *  given unit serial, returning them newest-first. Telemetry is cached for
 *  60 s stale-while-revalidate to avoid hammering the telemetry project. */
export function useUnitTimeline(unitSerial: string): { events: TimelineEvent[]; loading: boolean } {
  // ── 1. Activity log ──────────────────────────────────────────────────────
  const { entries: activityEntries, loading: activityLoading } =
    useActivityForEntity({ unitSerial });

  // ── 2-5. Other tables ────────────────────────────────────────────────────
  const [otherEvents, setOtherEvents] = useState<TimelineEvent[]>([]);
  const [otherLoading, setOtherLoading] = useState(true);

  // ── 6. Telemetry (cached) ────────────────────────────────────────────────
  const [telemetryEvents, setTelemetryEvents] = useState<TimelineEvent[]>([]);
  const telemetryFetchedRef = useRef(false);

  const fetchTelemetry = useCallback(async () => {
    if (!isTelemetryConfigured || !supabaseTelemetry) return;

    const cached = telemetryCache.get(unitSerial);
    if (cached && Date.now() - cached.fetchedAt < TELEMETRY_TTL_MS) {
      setTelemetryEvents(cached.events);
      return;
    }

    const since = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();
    try {
      const { data, error } = await supabaseTelemetry
        .from('events')
        .select('created_at, event_code, event_value')
        .eq('serial_number', unitSerial)
        .neq('event_code', 'OK')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) {
        console.warn('UnitTimeline: telemetry fetch failed', error);
        return;
      }
      if (!data) return;

      const evts: TimelineEvent[] = (data as Array<{
        created_at: string;
        event_code: string | null;
        event_value: string | number | null;
      }>).map((row, idx) => ({
        id: `telemetry-${idx}-${row.created_at}`,
        ts: row.created_at,
        kind: 'telemetry_event',
        label: row.event_code ?? 'Telemetry event',
        detail: row.event_value != null ? String(row.event_value) : undefined,
        source: 'telemetry',
      }));

      telemetryCache.set(unitSerial, { events: evts, fetchedAt: Date.now() });
      setTelemetryEvents(evts);
    } catch (e) {
      console.warn('UnitTimeline: telemetry fetch threw', e);
    }
  }, [unitSerial]);

  useEffect(() => {
    if (!unitSerial) { setOtherLoading(false); return; }

    let cancelled = false;
    telemetryFetchedRef.current = false;

    (async () => {
      const collected: TimelineEvent[] = [];

      // ── 2. service_tickets ───────────────────────────────────────────────
      const { data: tickets } = await supabase
        .from('service_tickets')
        .select('id, created_at, category, status, closed_at')
        .eq('unit_serial', unitSerial);
      if (!cancelled && tickets) {
        for (const t of tickets as Array<{
          id: string;
          created_at: string;
          category: string | null;
          status: string | null;
          closed_at: string | null;
        }>) {
          collected.push({
            id: `ticket-opened-${t.id}`,
            ts: t.created_at,
            kind: 'ticket_opened',
            label: 'Ticket opened',
            detail: t.category ?? undefined,
            source: 'service_tickets',
          });
          if (t.status === 'closed' && t.closed_at) {
            collected.push({
              id: `ticket-resolved-${t.id}`,
              ts: t.closed_at,
              kind: 'ticket_resolved',
              label: 'Ticket closed',
              detail: t.category ?? undefined,
              source: 'service_tickets',
            });
          }
        }
      }

      // ── 3. returns ───────────────────────────────────────────────────────
      const { data: returns } = await supabase
        .from('returns')
        .select('id, created_at, received_at, reason, status')
        .eq('unit_serial', unitSerial);
      if (!cancelled && returns) {
        for (const r of returns as Array<{
          id: string;
          created_at: string;
          received_at: string | null;
          reason: string | null;
          status: string | null;
        }>) {
          const ts = r.received_at ?? r.created_at;
          collected.push({
            id: `return-${r.id}`,
            ts,
            kind: 'returned',
            label: 'Unit returned',
            detail: r.reason ?? undefined,
            source: 'returns',
          });
        }
      }

      // ── 4. units row (built / qc / shipped / quarantine events) ─────────
      // The unit_test_reports migration added columns to the units table,
      // not a separate table. We derive built / qc_passed / qc_failed /
      // shipped / quarantined events from the units row itself.
      const { data: unitRow } = await supabase
        .from('units')
        .select('created_at, electrical_check, mechanical_check, shipped_at, status, status_updated_at, test_report_uploaded_at')
        .eq('serial', unitSerial)
        .maybeSingle();
      if (!cancelled && unitRow) {
        const u = unitRow as {
          created_at: string;
          electrical_check: string | null;
          mechanical_check: string | null;
          shipped_at: string | null;
          status: string | null;
          status_updated_at: string;
          test_report_uploaded_at: string | null;
        };

        // built
        collected.push({
          id: `built-${unitSerial}`,
          ts: u.created_at,
          kind: 'built',
          label: 'Unit registered',
          source: 'unit_test_reports',
        });

        // QC — derive from test_report_uploaded_at if present, else status_updated_at
        if (u.electrical_check === 'pass' && u.mechanical_check === 'pass') {
          collected.push({
            id: `qc-passed-${unitSerial}`,
            ts: u.test_report_uploaded_at ?? u.status_updated_at,
            kind: 'qc_passed',
            label: 'QC passed',
            detail: 'Electrical & mechanical',
            source: 'unit_test_reports',
          });
        } else if (u.electrical_check === 'fail' || u.mechanical_check === 'fail') {
          const which = [
            u.electrical_check === 'fail' ? 'Electrical' : null,
            u.mechanical_check === 'fail' ? 'Mechanical' : null,
          ].filter(Boolean).join(', ');
          collected.push({
            id: `qc-failed-${unitSerial}`,
            ts: u.test_report_uploaded_at ?? u.status_updated_at,
            kind: 'qc_failed',
            label: 'QC failed',
            detail: which || undefined,
            source: 'unit_test_reports',
          });
        }

        // shipped
        if (u.shipped_at) {
          collected.push({
            id: `shipped-${unitSerial}`,
            ts: u.shipped_at,
            kind: 'shipped',
            label: 'Unit shipped',
            source: 'unit_test_reports',
          });
        }

        // quarantined (current status)
        if (u.status === 'quarantine') {
          collected.push({
            id: `quarantined-${unitSerial}`,
            ts: u.status_updated_at,
            kind: 'quarantined',
            label: 'Quarantined',
            source: 'unit_test_reports',
          });
        }
      }

      // ── 5. fulfillment_log ───────────────────────────────────────────────
      const { data: fulfillment } = await supabase
        .from('fulfillment_log')
        .select('id, shipping_date, source_tab')
        .eq('serial_number', unitSerial);
      if (!cancelled && fulfillment) {
        for (const f of fulfillment as Array<{
          id: string;
          shipping_date: string | null;
          source_tab: string | null;
        }>) {
          if (f.shipping_date) {
            collected.push({
              id: `fulfillment-${f.id}`,
              // shipping_date is a date (YYYY-MM-DD); append time so sort is consistent
              ts: `${f.shipping_date}T00:00:00.000Z`,
              kind: 'shipped',
              label: 'Shipped (fulfillment log)',
              detail: f.source_tab ?? undefined,
              source: 'fulfillment_log',
            });
          }
        }
      }

      if (!cancelled) {
        setOtherEvents(collected);
        setOtherLoading(false);
      }

      // Fetch telemetry after the main data (non-blocking)
      if (!cancelled && !telemetryFetchedRef.current) {
        telemetryFetchedRef.current = true;
        void fetchTelemetry();
      }
    })();

    return () => { cancelled = true; };
  }, [unitSerial, fetchTelemetry]);

  // ── Map activity log entries to TimelineEvents ───────────────────────────
  const activityEvents = useMemo<TimelineEvent[]>(() =>
    activityEntries.map(e => ({
      id: `activity-${e.id}`,
      ts: e.ts,
      kind: 'activity' as const,
      label: e.type,
      detail: e.detail || undefined,
      source: 'activity_log' as const,
    })),
    [activityEntries],
  );

  const events = useMemo(() =>
    mergeTimelineEvents([...activityEvents, ...otherEvents, ...telemetryEvents]),
    [activityEvents, otherEvents, telemetryEvents],
  );

  return {
    events,
    loading: activityLoading || otherLoading,
  };
}
