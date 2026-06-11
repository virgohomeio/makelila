import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { logAction } from './activityLog';

// ============================================================ Types

export type POStatus = 'placed' | 'in_production' | 'ready_to_ship' | 'shipped' | 'cancelled';
export type FreightStatus = 'booked' | 'on_boat' | 'in_customs' | 'in_transit' | 'arrived';
export type DefectCategory =
  | 'electrical' | 'mechanical' | 'aesthetic' | 'firmware'
  | 'assembly' | 'packaging' | 'legacy_rework' | 'legacy_iqc_notion' | 'other';
export type DefectSeverity = 'critical' | 'high' | 'medium' | 'low';
export type DefectStatus = 'open' | 'in_rework' | 'resolved' | 'accepted_with_note' | 'scrapped';
export type BurnInResult = 'pass' | 'fail' | 'aborted';

export type FactoryOrder = {
  id: string;
  po_number: string;
  batch: string;
  qty_ordered: number;
  unit_cost_usd: number | null;
  manufacturer: string;
  ship_target_date: string | null;
  status: POStatus;
  notes: string | null;
  placed_at: string;
  placed_by: string | null;
  created_at: string;
  updated_at: string;
};

export type FreightShipment = {
  id: string;
  po_id: string;
  carrier: string | null;
  container_no: string | null;
  bill_of_lading: string | null;
  etd_china: string | null;
  etd_actual: string | null;
  eta_canada: string | null;
  eta_actual: string | null;
  customs_cleared_at: string | null;
  arrived_at_warehouse_at: string | null;
  status: FreightStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type BuildDefect = {
  id: string;
  unit_serial: string;
  category: DefectCategory;
  subject: string;
  description: string | null;
  severity: DefectSeverity;
  status: DefectStatus;
  found_by: string | null;
  found_by_name: string | null;
  resolved_by: string | null;
  resolved_by_name: string | null;
  resolution_note: string | null;
  source_notion_url: string | null;
  found_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type BuildAttachment = {
  id: string;
  defect_id: string;
  file_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
  uploaded_by: string | null;
};

export type BurnInTest = {
  id: string;
  unit_serial: string;
  started_at: string;
  ended_at: string | null;
  duration_target_hours: number;
  result: BurnInResult | null;
  failure_mode: string | null;
  notes: string | null;
  operator_email: string | null;
  created_at: string;
};

// ============================================================ Display metadata

export const PO_STATUS_META: Record<POStatus, { label: string; color: string; bg: string }> = {
  placed:         { label: 'Placed',         color: '#2b6cb0', bg: '#ebf8ff' },
  in_production:  { label: 'In production',  color: '#553c9a', bg: '#faf5ff' },
  ready_to_ship:  { label: 'Ready to ship',  color: '#c05621', bg: '#fffaf0' },
  shipped:        { label: 'Shipped',        color: '#276749', bg: '#f0fff4' },
  cancelled:      { label: 'Cancelled',      color: '#a0aec0', bg: '#edf2f7' },
};

export const FREIGHT_STATUS_META: Record<FreightStatus, { label: string; color: string; bg: string }> = {
  booked:      { label: 'Booked',      color: '#2b6cb0', bg: '#ebf8ff' },
  on_boat:     { label: 'On boat',     color: '#553c9a', bg: '#faf5ff' },
  in_customs:  { label: 'In customs',  color: '#c05621', bg: '#fffaf0' },
  in_transit:  { label: 'In transit',  color: '#9a4a0a', bg: '#fff1d6' },
  arrived:     { label: 'Arrived',     color: '#276749', bg: '#f0fff4' },
};

export const DEFECT_CATEGORY_META: Record<DefectCategory, { label: string; color: string; bg: string }> = {
  electrical:        { label: 'Electrical',        color: '#c53030', bg: '#fff5f5' },
  mechanical:        { label: 'Mechanical',        color: '#c05621', bg: '#fffaf0' },
  aesthetic:         { label: 'Aesthetic',         color: '#856a0a', bg: '#fff8d6' },
  firmware:          { label: 'Firmware',          color: '#553c9a', bg: '#faf5ff' },
  assembly:          { label: 'Assembly',          color: '#2b6cb0', bg: '#ebf8ff' },
  packaging:         { label: 'Packaging',         color: '#718096', bg: '#f7fafc' },
  legacy_rework:     { label: 'Legacy rework',     color: '#a0aec0', bg: '#edf2f7' },
  legacy_iqc_notion: { label: 'Legacy IQC (Notion)', color: '#a0aec0', bg: '#edf2f7' },
  other:             { label: 'Other',             color: '#a0aec0', bg: '#edf2f7' },
};

export const SEVERITY_META: Record<DefectSeverity, { label: string; color: string }> = {
  critical: { label: 'Critical', color: '#a51b1b' },
  high:     { label: 'High',     color: '#9a4a0a' },
  medium:   { label: 'Medium',   color: '#856a0a' },
  low:      { label: 'Low',      color: '#718096' },
};

export const DEFECT_STATUS_META: Record<DefectStatus, { label: string; color: string; bg: string }> = {
  open:               { label: 'Open',               color: '#a51b1b', bg: '#fff5f5' },
  in_rework:          { label: 'In rework',          color: '#c05621', bg: '#fffaf0' },
  resolved:           { label: 'Resolved',           color: '#276749', bg: '#f0fff4' },
  accepted_with_note: { label: 'Accepted',           color: '#856a0a', bg: '#fff8d6' },
  scrapped:           { label: 'Scrapped',           color: '#a0aec0', bg: '#edf2f7' },
};

// ============================================================ Hooks

export function useFactoryOrders(): { orders: FactoryOrder[]; loading: boolean } {
  const [orders, setOrders] = useState<FactoryOrder[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let ch: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('factory_orders')
        .select('*')
        .order('placed_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) setOrders(data as FactoryOrder[]);
      setLoading(false);
      ch = supabase
        .channel('factory_orders:realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'factory_orders' }, (p) => {
          setOrders(prev => {
            if (p.eventType === 'DELETE' && p.old) return prev.filter(o => o.id !== (p.old as { id: string }).id);
            if (p.new) {
              const row = p.new as FactoryOrder;
              const idx = prev.findIndex(o => o.id === row.id);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [row, ...prev];
            }
            return prev;
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (ch) void ch.unsubscribe(); };
  }, []);
  return { orders, loading };
}

export function useFreightShipments(): { shipments: FreightShipment[]; loading: boolean } {
  const [shipments, setShipments] = useState<FreightShipment[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let ch: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('freight_shipments')
        .select('*')
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) setShipments(data as FreightShipment[]);
      setLoading(false);
      ch = supabase
        .channel('freight_shipments:realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'freight_shipments' }, (p) => {
          setShipments(prev => {
            if (p.eventType === 'DELETE' && p.old) return prev.filter(s => s.id !== (p.old as { id: string }).id);
            if (p.new) {
              const row = p.new as FreightShipment;
              const idx = prev.findIndex(s => s.id === row.id);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [row, ...prev];
            }
            return prev;
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (ch) void ch.unsubscribe(); };
  }, []);
  return { shipments, loading };
}

export function useBuildDefects(unitSerial?: string): { defects: BuildDefect[]; loading: boolean } {
  const [defects, setDefects] = useState<BuildDefect[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let ch: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      let q = supabase.from('build_defects').select('*').order('found_at', { ascending: false });
      if (unitSerial) q = q.eq('unit_serial', unitSerial);
      const { data, error } = await q;
      if (cancelled) return;
      if (!error && data) setDefects(data as BuildDefect[]);
      setLoading(false);
      ch = supabase
        .channel(`build_defects:${unitSerial ?? 'all'}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'build_defects' }, (p) => {
          setDefects(prev => {
            if (p.eventType === 'DELETE' && p.old) return prev.filter(d => d.id !== (p.old as { id: string }).id);
            if (p.new) {
              const row = p.new as BuildDefect;
              if (unitSerial && row.unit_serial !== unitSerial) return prev;
              const idx = prev.findIndex(d => d.id === row.id);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [row, ...prev];
            }
            return prev;
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (ch) void ch.unsubscribe(); };
  }, [unitSerial]);
  return { defects, loading };
}

export function useBurnInTests(unitSerial?: string): { tests: BurnInTest[]; loading: boolean } {
  const [tests, setTests] = useState<BurnInTest[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let ch: RealtimeChannel | null = null;
    let cancelled = false;
    (async () => {
      let q = supabase.from('burn_in_tests').select('*').order('started_at', { ascending: false });
      if (unitSerial) q = q.eq('unit_serial', unitSerial);
      const { data, error } = await q;
      if (cancelled) return;
      if (!error && data) setTests(data as BurnInTest[]);
      setLoading(false);
      ch = supabase
        .channel(`burn_in_tests:${unitSerial ?? 'all'}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'burn_in_tests' }, (p) => {
          setTests(prev => {
            if (p.eventType === 'DELETE' && p.old) return prev.filter(t => t.id !== (p.old as { id: string }).id);
            if (p.new) {
              const row = p.new as BurnInTest;
              if (unitSerial && row.unit_serial !== unitSerial) return prev;
              const idx = prev.findIndex(t => t.id === row.id);
              if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
              return [row, ...prev];
            }
            return prev;
          });
        })
        .subscribe();
    })();
    return () => { cancelled = true; if (ch) void ch.unsubscribe(); };
  }, [unitSerial]);
  return { tests, loading };
}

export function useBuildAttachments(defectId: string | null): { attachments: BuildAttachment[]; loading: boolean } {
  const [attachments, setAttachments] = useState<BuildAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!defectId) { setAttachments([]); setLoading(false); return; }
    let ch: RealtimeChannel | null = null;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from('build_attachments')
        .select('*')
        .eq('defect_id', defectId)
        .order('uploaded_at', { ascending: true });
      if (cancelled) return;
      if (!error && data) setAttachments(data as BuildAttachment[]);
      setLoading(false);
      ch = supabase
        .channel(`build_attachments:${defectId}`)
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'build_attachments', filter: `defect_id=eq.${defectId}` },
          (p) => {
            setAttachments(prev => {
              if (p.eventType === 'DELETE' && p.old) return prev.filter(a => a.id !== (p.old as { id: string }).id);
              if (p.new) {
                const row = p.new as BuildAttachment;
                const idx = prev.findIndex(a => a.id === row.id);
                if (idx >= 0) { const next = [...prev]; next[idx] = row; return next; }
                return [...prev, row];
              }
              return prev;
            });
          })
        .subscribe();
    })();
    return () => { cancelled = true; if (ch) void ch.unsubscribe(); };
  }, [defectId]);
  return { attachments, loading };
}

// ============================================================ Mutations

export async function createPO(input: {
  po_number: string; batch: string; qty_ordered: number;
  unit_cost_usd?: number; manufacturer?: string; ship_target_date?: string;
}): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('factory_orders')
    .insert(input)
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('createPO failed');
  await logAction('po_created', input.po_number, `${input.batch} x${input.qty_ordered}`);
  return { id: data.id as string };
}

export async function updatePOStatus(id: string, status: POStatus): Promise<void> {
  const { error } = await supabase.from('factory_orders').update({ status }).eq('id', id);
  if (error) throw error;
  await logAction('po_status_changed', id, status);
}

export async function createFreight(input: {
  po_id: string; carrier?: string; container_no?: string; etd_china?: string; eta_canada?: string;
}): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('freight_shipments')
    .insert(input)
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('createFreight failed');
  return { id: data.id as string };
}

export async function updateFreightStatus(id: string, status: FreightStatus): Promise<void> {
  const patch: Record<string, unknown> = { status };
  if (status === 'arrived') patch.arrived_at_warehouse_at = new Date().toISOString();
  const { error } = await supabase.from('freight_shipments').update(patch).eq('id', id);
  if (error) throw error;
  await logAction('freight_status_changed', id, status);
}

export async function assignSerial(input: {
  serial: string; batch: string; po_id?: string;
}): Promise<void> {
  // Create unit at IQC station. Trigger units_create_lifecycle_on_ship doesn't
  // fire because we start at 'ca-test', not 'shipped'.
  const { error } = await supabase.from('units').insert({
    serial: input.serial,
    batch: input.batch,
    status: 'ca-test',
  });
  if (error) throw error;
  await logAction('serial_assigned', input.serial, input.batch,
    { entityType: 'unit', unitSerial: input.serial });
}

export async function logDefect(input: {
  unit_serial: string;
  category: DefectCategory;
  subject: string;
  description?: string;
  severity?: DefectSeverity;
  status?: DefectStatus;
  found_by_name?: string;
}): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('build_defects')
    .insert({
      unit_serial: input.unit_serial,
      category: input.category,
      subject: input.subject,
      description: input.description ?? null,
      severity: input.severity ?? 'medium',
      status: input.status ?? 'in_rework',
      found_by_name: input.found_by_name ?? null,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('logDefect failed');
  await logAction('defect_logged', input.unit_serial, input.subject,
    { entityType: 'unit', unitSerial: input.unit_serial });
  return { id: data.id as string };
}

export async function resolveDefect(id: string, resolution_note: string, resolved_by_name?: string): Promise<void> {
  const { error } = await supabase
    .from('build_defects')
    .update({
      status: 'resolved',
      resolution_note,
      resolved_by_name: resolved_by_name ?? null,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw error;
  await logAction('defect_resolved', id, resolution_note.slice(0, 80));
}

export async function startBurnIn(unit_serial: string, duration_target_hours = 24, operator_email?: string): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('burn_in_tests')
    .insert({
      unit_serial,
      duration_target_hours,
      operator_email: operator_email ?? null,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('startBurnIn failed');
  await logAction('burnin_started', unit_serial, `${duration_target_hours}h target`,
    { entityType: 'unit', unitSerial: unit_serial });
  return { id: data.id as string };
}

export async function endBurnIn(id: string, result: BurnInResult, failure_mode?: string, notes?: string): Promise<void> {
  const { error } = await supabase
    .from('burn_in_tests')
    .update({
      result,
      failure_mode: failure_mode ?? null,
      notes: notes ?? null,
      ended_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw error;
  await logAction('burnin_ended', id, result);
}

export async function releaseToFulfillment(unit_serial: string): Promise<void> {
  const { error: uErr } = await supabase.from('units').update({ status: 'ready' }).eq('serial', unit_serial);
  if (uErr) throw uErr;
  // Flip the shelf slot to 'available' so Fulfillment's serial picker sees it.
  // If no shelf_slots row exists for this serial yet (unit not physically racked),
  // the update affects 0 rows silently — that's a separate operator workflow problem.
  const { error: sErr } = await supabase
    .from('shelf_slots')
    .update({ status: 'available', updated_at: new Date().toISOString() })
    .eq('serial', unit_serial);
  if (sErr) throw sErr;
  await logAction('released_to_fulfillment', unit_serial, 'unit ready for fulfillment',
    { entityType: 'unit', unitSerial: unit_serial });
}

export async function attachmentSignedUrl(file_path: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from('build-attachments')
    .createSignedUrl(file_path, 3600);
  if (error || !data) return null;
  return data.signedUrl;
}

// ============================================================ Station Pass Types

export type StationPassStation = 'electrical' | 'mechanical' | 'firmware_flash' | 'final_qa';
export type StationPassStatus = 'pass' | 'fail' | 'incomplete' | 'rework';
export type StationPassDefectCategory =
  | 'solder_issue' | 'loose_connection' | 'firmware_flash_failed'
  | 'display_issue' | 'motor_issue' | 'sensor_issue' | 'mechanical_alignment' | 'other';

export type StationPass = {
  id: string;
  unit_serial: string;
  station: StationPassStation;
  pass_status: StationPassStatus;
  attempt_seq: number;
  defect_category: StationPassDefectCategory | null;
  defect_notes: string | null;
  technician_id: string | null;
  firmware_version: string | null;
  photo_urls: string[];
  created_at: string;
};

export type BuildQCStat = {
  station: StationPassStation;
  total: number;
  pass: number;
  fail: number;
  rework: number;
  first_pass_yield: number; // pct 0-100
};

export type TechnicianStat = {
  technician_id: string;
  technician_name: string | null;
  total: number;
  pass: number;
  fail: number;
  by_category: Record<string, number>;
};

// ============================================================ Pure helpers (exported for tests)

/** first_pass_yield = units that passed on attempt_seq=1 / total units that attempted */
export function computeFirstPassYield(passes: StationPass[], station: StationPassStation): number {
  const stationPasses = passes.filter(p => p.station === station);
  if (stationPasses.length === 0) return 0;
  const unitSerials = [...new Set(stationPasses.map(p => p.unit_serial))];
  const firstAttempts = stationPasses.filter(p => p.attempt_seq === 1);
  const firstPassCount = firstAttempts.filter(p => p.pass_status === 'pass').length;
  return unitSerials.length === 0 ? 0 : (firstPassCount / unitSerials.length) * 100;
}

/** Pure: compute next attempt_seq given the current max (null if no prior attempts). */
export function nextAttemptSeq(currentMax: number | null | undefined): number {
  return (currentMax ?? 0) + 1;
}

// ============================================================ Station Pass Hooks

export function useStationPasses(unit_serial: string): { passes: StationPass[]; loading: boolean } {
  const [passes, setPasses] = useState<StationPass[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!unit_serial) { setPasses([]); setLoading(false); return; }
    let cancelled = false;
    let ch: RealtimeChannel | null = null;
    (async () => {
      const { data, error } = await supabase
        .from('build_station_passes')
        .select('*')
        .eq('unit_serial', unit_serial)
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (!error && data) setPasses(data as StationPass[]);
      setLoading(false);
      ch = supabase
        .channel(`station_passes:${unit_serial}`)
        .on('postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'build_station_passes', filter: `unit_serial=eq.${unit_serial}` },
          (p) => {
            if (p.new) {
              const row = p.new as StationPass;
              setPasses(prev => [row, ...prev]);
            }
          })
        .subscribe();
    })();
    return () => { cancelled = true; if (ch) void ch.unsubscribe(); };
  }, [unit_serial]);
  return { passes, loading };
}

export function useBuildQCStat(
  date_from: string,
  date_to: string,
  batch?: string,
): { qcStats: BuildQCStat[]; techStats: TechnicianStat[]; loading: boolean } {
  const [qcStats, setQcStats] = useState<BuildQCStat[]>([]);
  const [techStats, setTechStats] = useState<TechnicianStat[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      let q = supabase
        .from('build_station_passes')
        .select('station, pass_status, defect_category, technician_id, unit_serial, attempt_seq, created_at')
        .gte('created_at', date_from)
        .lte('created_at', date_to);
      if (batch) {
        // Join to units to filter by batch
        const { data: unitSerials } = await supabase
          .from('units')
          .select('serial')
          .eq('batch', batch);
        if (unitSerials && unitSerials.length > 0) {
          const serials = (unitSerials as { serial: string }[]).map(u => u.serial);
          q = q.in('unit_serial', serials);
        }
      }
      const { data, error } = await q;
      if (cancelled) return;
      if (error || !data) { setLoading(false); return; }

      const rows = data as StationPass[];

      // QC stats by station
      const stations: StationPassStation[] = ['electrical', 'mechanical', 'firmware_flash', 'final_qa'];
      const computed: BuildQCStat[] = stations.map(station => {
        const stationRows = rows.filter(r => r.station === station);
        const total = stationRows.length;
        const pass = stationRows.filter(r => r.pass_status === 'pass').length;
        const fail = stationRows.filter(r => r.pass_status === 'fail').length;
        const rework = stationRows.filter(r => r.pass_status === 'rework').length;
        const fpy = computeFirstPassYield(rows, station);
        return { station, total, pass, fail, rework, first_pass_yield: fpy };
      });
      setQcStats(computed);

      // Technician stats
      const techMap = new Map<string, TechnicianStat>();
      for (const row of rows) {
        const tid = row.technician_id ?? 'unknown';
        if (!techMap.has(tid)) {
          techMap.set(tid, {
            technician_id: tid,
            technician_name: null,
            total: 0,
            pass: 0,
            fail: 0,
            by_category: {},
          });
        }
        const stat = techMap.get(tid)!;
        stat.total++;
        if (row.pass_status === 'pass') stat.pass++;
        if (row.pass_status === 'fail') stat.fail++;
        if (row.defect_category) {
          stat.by_category[row.defect_category] = (stat.by_category[row.defect_category] ?? 0) + 1;
        }
      }
      setTechStats([...techMap.values()]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [date_from, date_to, batch]);

  return { qcStats, techStats, loading };
}

// ============================================================ Station Pass Mutations

export async function recordStationPass(input: {
  unit_serial: string;
  station: StationPassStation;
  pass_status: StationPassStatus;
  defect_category?: StationPassDefectCategory | null;
  defect_notes?: string | null;
  firmware_version?: string | null;
  photo_urls?: string[];
}): Promise<{ id: string }> {
  const { unit_serial, station } = input;

  // Compute next attempt_seq
  const { data: maxRow } = await supabase
    .from('build_station_passes')
    .select('attempt_seq')
    .eq('unit_serial', unit_serial)
    .eq('station', station)
    .order('attempt_seq', { ascending: false })
    .limit(1)
    .maybeSingle();
  const attempt_seq = nextAttemptSeq((maxRow as { attempt_seq: number } | null)?.attempt_seq);

  const { data: authData } = await supabase.auth.getUser();
  const technician_id = authData.user?.id ?? null;

  const { data, error } = await supabase
    .from('build_station_passes')
    .insert({
      unit_serial,
      station,
      pass_status: input.pass_status,
      attempt_seq,
      defect_category: input.defect_category ?? null,
      defect_notes: input.defect_notes ?? null,
      technician_id,
      firmware_version: input.firmware_version ?? null,
      photo_urls: input.photo_urls ?? [],
    })
    .select('id')
    .single();

  if (error || !data) throw error ?? new Error('recordStationPass failed');

  await logAction(
    'station_pass_recorded',
    unit_serial,
    `${station}: ${input.pass_status} (attempt ${attempt_seq})`,
    { entityType: 'unit', entityId: unit_serial, unitSerial: unit_serial },
  );

  return { id: (data as { id: string }).id };
}
