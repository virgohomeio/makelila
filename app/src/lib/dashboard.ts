import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase as supabaseMain } from './supabase';
import { supabaseTelemetry } from './supabaseTelemetry';
import { logAction } from './activityLog';

// Non-null assertion: the App.tsx route guard ensures Dashboard (and
// therefore this module's hooks) is only mounted when telemetry is
// configured. supabaseTelemetry was made nullable so importing this file
// doesn't crash unrelated routes like /login when env vars are missing.
const supabase = supabaseTelemetry!;

// ── Types ─────────────────────────────────────────────────────────────────────

export const RecordType = {
  Current: 1,
  Temperature: 2,
  MachineHealth: 3,
  BmeLeft: 5,
  BmeRight: 6,
} as const;
export type RecordType = (typeof RecordType)[keyof typeof RecordType];

export type MachineStatus =
  | 'OK'
  | 'NEW_FOOD'
  | 'DRY_SOIL'
  | 'SOAKED_SOIL'
  | 'DIAGNOSE'
  | 'NOT_MIXING'
  | 'OPEN_LID';

export interface EventRow {
  created_at: string;
  serial_number: string;
  event_code: string | null;
  sensor_name: string | null;
  event_value: number | string | null;
}

export interface AcCurrentRow {
  created_at: string;
  serial_number: string;
  chamber_motor_left: number | null;
  chamber_motor_right: number | null;
  total_current: number | null;
}

export interface BmeSensorRow {
  created_at: string;
  serial_number: string;
  num_bme: 1 | 2;
  temperature: number | null;
  humidity: number | null;
  pressure: number | null;
  gasres: number | null;
}

export interface TemperatureSensorRow {
  created_at: string;
  serial_number: string;
  pad_heater_left: number | null;
  pad_heater_right: number | null;
  ptc_intake: number | null;
  ptc_internal: number | null;
  inner_shell_target: number | null;
  pwm_blower: number | null;
}

export interface MachineHealthRow {
  created_at: string;
  serial_number: string;
  error_code: number | null;
  state: number | null;
  rssi: number | null;
}

export interface ParsedEvent {
  timestamp: Date;
  partName: string;
  state: 0 | 1 | 2;
  value: number;
}

export interface LiveSample<T> {
  timestamp: Date;
  data: T;
}

export interface CurrentSample {
  AcCurrent: number;
  LeftMotorCurrent: number;
  RightMotorCurrent: number;
}

export interface TemperatureSample {
  LeftPadTemperature?: number;
  RightPadTemperature?: number;
  IntakeTemperature?: number;
  InternalTemperature?: number;
  InnerShellTemperature?: number;
  BlowerPwm?: number;
}

export interface MachineHealthSample {
  error_code?: number;
  state?: number;
  rssi?: number;
}

export interface BmeSample {
  Temperature: number;
  Humidity: number;
  Pressure: number;
  GasResistance: number;
}

export interface LiveData {
  [RecordType.Current]: LiveSample<CurrentSample>[];
  [RecordType.Temperature]: LiveSample<TemperatureSample>[];
  [RecordType.MachineHealth]: LiveSample<MachineHealthSample>[];
  [RecordType.BmeLeft]: LiveSample<BmeSample>[];
  [RecordType.BmeRight]: LiveSample<BmeSample>[];
}

// ── Constants (mirrored from dashboard.py) ────────────────────────────────────

export const DATA_RETENTION_HOURS = 48;
export const LOW_VALID_HUMIDITY = 5.0;
export const DRY_SOIL_LOW_HUMIDITY = 15.0;
export const DRY_SOIL_DROP_SLOPE = -10.0;
export const DRY_SOIL_DROP_LOOKBACK_HOURS = 24;
export const DRY_SOIL_DROP_MIN_SEGMENT_MINUTES = 10.0;
export const WET_SOIL_HUMIDITY = 60.0;
export const WET_SOIL_PERIOD_HOURS = 12;
export const NEW_FOOD_RISE_SLOPE = 10.0;
export const NEW_FOOD_SINGLE_CHAMBER_RISE_SLOPE = 20.0;
export const NEW_FOOD_CHAMBER_IMBALANCE_SLOPE = 4.0;
export const NEW_FOOD_GRADIENT_LOOKBACK_HOURS = 24;
export const NEW_FOOD_GRADIENT_MIN_SEGMENT_MINUTES = 30.0;
// Per-side mixing detection. Motor current is bimodal: idle ≈ 0–15 A,
// active mixing ≈ 80–110 A (calibrated against the `ac_current` telemetry).
// A healthy side fires short ~3–7 min runs roughly every ~90 min, pausing
// overnight, with occasional lone single-sample inrush spikes (110–278 A).
export const MIX_ON_AMPS = 30;                   // ≥ this ⇒ motor actively driving
export const MIX_RUN_MERGE_GAP_MS = 8 * 60_000;  // bridge ≤8 min gaps (~2.5× the 3-min cadence) within one run
export const MIX_MIN_RUNS = 3;                   // valid runs needed to call a side "mixing"
export const MIX_RECENCY_HOURS = 12;             // most recent run must be within this
export const MIX_WINDOW_HOURS = DATA_RETENTION_HOURS; // 48
export const LID_SENSOR_NAMES = ['FrontMicroswitch', 'RearMicroswitch'] as const;
export const LID_OPEN_STATE = 1;
export const RECENT_RECEIVING_WINDOW_MINUTES = 10;

export const STATUS_COLORS: Record<MachineStatus, string> = {
  OK:          '#27ae60',
  NEW_FOOD:    '#1abc9c',
  DRY_SOIL:    '#e67e22',
  SOAKED_SOIL: '#2980b9',
  DIAGNOSE:    '#e74c3c',
  NOT_MIXING:  '#9b59b6',
  OPEN_LID:    '#f39c12',
};

export const STATUS_DESCRIPTIONS: Record<MachineStatus, string> = {
  OK:          'Machine operating normally.',
  NEW_FOOD:    'Rapid humidity rise detected — food likely just added.',
  DRY_SOIL:    'Humidity below 15% or dropping faster than 10%/hr.',
  SOAKED_SOIL: 'Humidity above 60% sustained for 12+ hours.',
  DIAGNOSE:    'No data received in the last 10 minutes.',
  NOT_MIXING:  'Chamber motors not running as expected.',
  OPEN_LID:    'Lid open condition detected.',
};

export type MixingVerdict = 'BOTH' | 'LEFT_ONLY' | 'RIGHT_ONLY' | 'NEITHER' | 'NO_DATA';

export const MIXING_VERDICT_META: Record<MixingVerdict, { label: string; color: string; bg: string }> = {
  BOTH:       { label: 'Both sides mixing',     color: '#27ae60', bg: '#eafaf0' },
  LEFT_ONLY:  { label: 'Left side only mixing',  color: '#e67e22', bg: '#fdf2e6' },
  RIGHT_ONLY: { label: 'Right side only mixing', color: '#e67e22', bg: '#fdf2e6' },
  NEITHER:    { label: 'Neither side mixing',    color: '#e74c3c', bg: '#fdecea' },
  NO_DATA:    { label: 'No current data',        color: '#95a5a6', bg: '#f4f6f6' },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const SENSOR_STATE_PASSTHROUGH = new Set([
  'LeftBME688', 'RightBME688', 'IntakeBME688', 'ExhaustBME688',
  'LeftMass', 'RightMass',
]);

function eventValueToState(partName: string, eventValue: unknown): 0 | 1 | 2 {
  const n = Number(eventValue);
  const v = Number.isFinite(n) ? Math.trunc(n) : 0;
  if (SENSOR_STATE_PASSTHROUGH.has(partName)) {
    return v === 1 ? 1 : v === 2 ? 2 : 0;
  }
  return v === 0 ? 1 : v === 1 ? 0 : v === 2 ? 2 : 0;
}

function parseTs(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function safeInt(v: unknown, def = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

const sortByTs = <T extends { timestamp: Date }>(arr: T[]): T[] =>
  arr.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

// ── Status classifier ────────────────────────────────────────────────────────

export interface GradientMetrics {
  segmentGradients: number[];
  latestGradient: number | null;
}

export function humidityGradientMetrics(
  series: Array<[Date, number]>,
  lookbackHours = 24,
  minSegmentMinutes = 10.0,
): GradientMetrics {
  const empty: GradientMetrics = { segmentGradients: [], latestGradient: null };
  if (series.length < 2) return empty;
  const tEnd = series[series.length - 1][0].getTime();
  const lookbackMs = lookbackHours * 3_600_000;
  const recent = series.filter(([t]) => t.getTime() >= tEnd - lookbackMs);
  if (recent.length < 2) return empty;

  const minDtMs = minSegmentMinutes * 60_000;
  const window = 5;
  const half = 2;
  const segments: number[] = [];
  let smoothed: Array<number | null> | null = null;

  if (recent.length < window) {
    for (let i = 0; i < recent.length - 1; i++) {
      const dtMs = recent[i + 1][0].getTime() - recent[i][0].getTime();
      if (dtMs > 0 && dtMs >= minDtMs) {
        segments.push((recent[i + 1][1] - recent[i][1]) / (dtMs / 3_600_000));
      }
    }
  } else {
    smoothed = new Array(recent.length).fill(null);
    for (let i = 0; i < recent.length; i++) {
      const s = i - half;
      const e = i + half + 1;
      if (s >= 0 && e <= recent.length) {
        let sum = 0;
        for (let j = s; j < e; j++) sum += recent[j][1];
        smoothed[i] = sum / window;
      }
    }
    for (let i = 0; i < recent.length - 1; i++) {
      const a = smoothed[i];
      const b = smoothed[i + 1];
      if (a == null || b == null) continue;
      const dtMs = recent[i + 1][0].getTime() - recent[i][0].getTime();
      if (dtMs > 0 && dtMs >= minDtMs) {
        segments.push((b - a) / (dtMs / 3_600_000));
      }
    }
  }

  let latest: number | null = null;
  if (smoothed) {
    const validIdx: number[] = [];
    for (let i = 0; i < smoothed.length; i++) if (smoothed[i] != null) validIdx.push(i);
    if (validIdx.length >= 2) {
      const fi = validIdx[0];
      const li = validIdx[validIdx.length - 1];
      const dtMs = recent[li][0].getTime() - recent[fi][0].getTime();
      if (dtMs >= minDtMs) {
        const dtH = dtMs / 3_600_000;
        if (dtH > 0) latest = ((smoothed[li] as number) - (smoothed[fi] as number)) / dtH;
      }
    }
  } else {
    const dtMs = recent[recent.length - 1][0].getTime() - recent[0][0].getTime();
    if (dtMs >= minDtMs) {
      const dtH = dtMs / 3_600_000;
      if (dtH > 0) latest = (recent[recent.length - 1][1] - recent[0][1]) / dtH;
    }
  }

  return { segmentGradients: segments, latestGradient: latest };
}

export function gradientCrossesThreshold(
  metrics: GradientMetrics,
  opts: { minSlope?: number; maxSlope?: number } = {},
): boolean {
  const vals: number[] = [];
  if (metrics.latestGradient != null) vals.push(metrics.latestGradient);
  vals.push(...metrics.segmentGradients);
  if (!vals.length) return false;
  const { minSlope, maxSlope } = opts;
  if (minSlope != null && vals.some((v) => v <= minSlope)) return true;
  if (maxSlope != null && vals.some((v) => v >= maxSlope)) return true;
  return false;
}

function validBmeHumidity(h: unknown): number | null {
  if (h == null) return null;
  const v = Number(h);
  return Number.isFinite(v) && v > LOW_VALID_HUMIDITY ? v : null;
}

export function bmeHumidityFromLiveData(
  liveData: LiveData,
): Partial<Record<1 | 2, Array<[Date, number]>>> {
  const BME_FAULTY_LOW = 10.0;
  const BME_HEALTHY_HIGH = 40.0;
  const result: Partial<Record<1 | 2, Array<[Date, number]>>> = {};

  for (const [rec, nb] of [
    [RecordType.BmeLeft, 1],
    [RecordType.BmeRight, 2],
  ] as const) {
    const series: Array<[Date, number]> = [];
    for (const pt of liveData[rec]) {
      const h = validBmeHumidity(pt.data.Humidity);
      if (h != null) series.push([pt.timestamp, h]);
    }
    if (series.length) result[nb] = series;
  }

  const left = result[1];
  const right = result[2];
  if (left && right) {
    const ll = left[left.length - 1][1];
    const rl = right[right.length - 1][1];
    if (ll < BME_FAULTY_LOW && rl > BME_HEALTHY_HIGH) result[1] = [...right];
    else if (rl < BME_FAULTY_LOW && ll > BME_HEALTHY_HIGH) result[2] = [...left];
  }
  return result;
}

function humidityAboveThresholdForPeriod(
  series: Array<[Date, number]>,
  threshold = WET_SOIL_HUMIDITY,
  periodHours = WET_SOIL_PERIOD_HOURS,
): boolean {
  if (series.length < 2) return false;
  const tEnd = series[series.length - 1][0].getTime();
  const periodMs = periodHours * 3_600_000;
  const recent = series.filter(([t]) => t.getTime() >= tEnd - periodMs);
  if (recent.length < 2) return false;
  if (recent[recent.length - 1][0].getTime() - recent[0][0].getTime() < periodMs * 0.8) return false;
  const above = recent.filter(([, h]) => h > threshold).length;
  return above / recent.length > 0.5;
}

export function isDrySoilFromBme(
  bySensor: Partial<Record<1 | 2, Array<[Date, number]>>>,
): boolean {
  for (const series of Object.values(bySensor)) {
    if (!series || !series.length) continue;
    if (series[series.length - 1][1] < DRY_SOIL_LOW_HUMIDITY) return true;
    if (
      gradientCrossesThreshold(
        humidityGradientMetrics(series, DRY_SOIL_DROP_LOOKBACK_HOURS, DRY_SOIL_DROP_MIN_SEGMENT_MINUTES),
        { minSlope: DRY_SOIL_DROP_SLOPE },
      )
    ) {
      return true;
    }
  }
  return false;
}

export function wetSoilNewFoodFromBme(
  bySensor: Partial<Record<1 | 2, Array<[Date, number]>>>,
): { wetSoil: boolean; newFood: boolean } {
  const left = bySensor[1] ?? [];
  const right = bySensor[2] ?? [];
  let wetSoil = false;
  let newFood = false;

  if (left.length && right.length) {
    wetSoil = humidityAboveThresholdForPeriod(left) && humidityAboveThresholdForPeriod(right);
    const lm = humidityGradientMetrics(left, NEW_FOOD_GRADIENT_LOOKBACK_HOURS, NEW_FOOD_GRADIENT_MIN_SEGMENT_MINUTES);
    const rm = humidityGradientMetrics(right, NEW_FOOD_GRADIENT_LOOKBACK_HOURS, NEW_FOOD_GRADIENT_MIN_SEGMENT_MINUTES);
    if (lm.latestGradient != null && rm.latestGradient != null) {
      const rapidRise =
        gradientCrossesThreshold(lm, { maxSlope: NEW_FOOD_RISE_SLOPE }) ||
        gradientCrossesThreshold(rm, { maxSlope: NEW_FOOD_RISE_SLOPE });
      newFood = rapidRise && Math.abs(lm.latestGradient - rm.latestGradient) > NEW_FOOD_CHAMBER_IMBALANCE_SLOPE;
    }
  } else {
    const only = left.length ? left : right;
    if (only.length) {
      wetSoil = humidityAboveThresholdForPeriod(only);
      newFood = gradientCrossesThreshold(
        humidityGradientMetrics(only, NEW_FOOD_GRADIENT_LOOKBACK_HOURS, NEW_FOOD_GRADIENT_MIN_SEGMENT_MINUTES),
        { maxSlope: NEW_FOOD_SINGLE_CHAMBER_RISE_SLOPE },
      );
    }
  }
  return { wetSoil, newFood };
}

export function isOpenLid(events: ParsedEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if ((LID_SENSOR_NAMES as readonly string[]).includes(ev.partName)) {
      return ev.state === LID_OPEN_STATE;
    }
  }
  return false;
}

export interface SideMixing {
  mixing: boolean;
  runCount: number;
  lastRunAt: Date | null;
  medianIntervalMin: number | null;
  peakAmps: number;
  hasData: boolean;
}

/**
 * Detects whether one chamber side is mixing by grouping high-current samples
 * into "runs" (a motor-on burst) and requiring repeated, recent runs.
 *
 * `pick` selects the side's current (LeftMotorCurrent / RightMotorCurrent).
 * `now` is passed in (not read via Date.now) so the logic is deterministically
 * testable.
 */
export function detectSideMixing(
  samples: LiveSample<CurrentSample>[],
  pick: (d: CurrentSample) => number,
  now: number,
): SideMixing {
  const windowStart = now - MIX_WINDOW_HOURS * 3_600_000;

  // Window-filtered samples in ascending time order.
  const inWindow = samples
    .filter((s) => s.timestamp.getTime() >= windowStart)
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  if (inWindow.length === 0) {
    return { mixing: false, runCount: 0, lastRunAt: null, medianIntervalMin: null, peakAmps: 0, hasData: false };
  }

  let peakAmps = 0;
  for (const s of inWindow) {
    const a = pick(s.data) ?? 0;
    if (a > peakAmps) peakAmps = a;
  }

  // Group consecutive motor-on samples into runs, bridging short gaps.
  const runStarts: number[] = [];
  let lastRunEnd: number | null = null;
  let prevOnTs: number | null = null;

  for (const s of inWindow) {
    const a = pick(s.data) ?? 0;
    if (a < MIX_ON_AMPS) continue;
    const t = s.timestamp.getTime();
    if (prevOnTs === null || t - prevOnTs > MIX_RUN_MERGE_GAP_MS) {
      runStarts.push(t); // start of a new run
    }
    prevOnTs = t;
    lastRunEnd = t;
  }

  const runCount = runStarts.length;

  // Median gap between consecutive run starts (diagnostic only — not gating).
  let medianIntervalMin: number | null = null;
  if (runStarts.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < runStarts.length; i++) gaps.push(runStarts[i] - runStarts[i - 1]);
    gaps.sort((a, b) => a - b);
    const mid = Math.floor(gaps.length / 2);
    const medianMs = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
    medianIntervalMin = medianMs / 60_000;
  }

  const recentEnough = lastRunEnd !== null && now - lastRunEnd <= MIX_RECENCY_HOURS * 3_600_000;
  const mixing = runCount >= MIX_MIN_RUNS && recentEnough;

  return {
    mixing,
    runCount,
    lastRunAt: lastRunEnd !== null ? new Date(lastRunEnd) : null,
    medianIntervalMin,
    peakAmps,
    hasData: true,
  };
}

export interface MixingResult {
  verdict: MixingVerdict;
  left: SideMixing;
  right: SideMixing;
}

/** Combines per-side mixing detection into a single verdict for the machine. */
export function classifyMixing(liveData: LiveData, now: number = Date.now()): MixingResult {
  const currents = liveData[RecordType.Current];
  const left = detectSideMixing(currents, (d) => d.LeftMotorCurrent, now);
  const right = detectSideMixing(currents, (d) => d.RightMotorCurrent, now);

  let verdict: MixingVerdict;
  if (!left.hasData && !right.hasData) verdict = 'NO_DATA';
  else if (left.mixing && right.mixing) verdict = 'BOTH';
  else if (left.mixing) verdict = 'LEFT_ONLY';
  else if (right.mixing) verdict = 'RIGHT_ONLY';
  else verdict = 'NEITHER';

  return { verdict, left, right };
}

export function classifyMachineStatus(args: {
  events: ParsedEvent[];
  liveData: LiveData;
  isReceiving: boolean;
}): MachineStatus {
  if (!args.isReceiving) return 'DIAGNOSE';
  if (isOpenLid(args.events)) return 'OPEN_LID';
  // NOT_MIXING only when neither side is mixing. If at least one side is still
  // mixing (Left only / Right only), the machine is mixing — don't flag it.
  // NO_DATA falls through so we don't flag machines with no current telemetry.
  const mix = classifyMixing(args.liveData);
  if (mix.verdict === 'NEITHER') return 'NOT_MIXING';
  const bySensor = bmeHumidityFromLiveData(args.liveData);
  if (!bySensor[1] && !bySensor[2]) return 'OK';
  if (isDrySoilFromBme(bySensor)) return 'DRY_SOIL';
  const { wetSoil, newFood } = wetSoilNewFoodFromBme(bySensor);
  if (wetSoil) return 'SOAKED_SOIL';
  if (newFood) return 'NEW_FOOD';
  return 'OK';
}

// ── Row processing ────────────────────────────────────────────────────────────

function processEvents(rows: EventRow[]): ParsedEvent[] {
  const out: ParsedEvent[] = [];
  for (const r of rows) {
    const ts = parseTs(r.created_at);
    if (!ts || r.sensor_name == null) continue;
    out.push({
      timestamp: ts,
      partName: r.sensor_name,
      state: eventValueToState(r.sensor_name, r.event_value),
      value: safeInt(r.event_value),
    });
  }
  return out;
}

function processAcCurrent(rows: AcCurrentRow[]): LiveSample<CurrentSample>[] {
  const out: LiveSample<CurrentSample>[] = [];
  for (const r of rows) {
    const ts = parseTs(r.created_at);
    if (!ts) continue;
    out.push({
      timestamp: ts,
      data: {
        AcCurrent: r.total_current ?? 0,
        LeftMotorCurrent: r.chamber_motor_left ?? 0,
        RightMotorCurrent: r.chamber_motor_right ?? 0,
      },
    });
  }
  return out;
}

function processTemperature(rows: TemperatureSensorRow[]): LiveSample<TemperatureSample>[] {
  const out: LiveSample<TemperatureSample>[] = [];
  for (const r of rows) {
    const ts = parseTs(r.created_at);
    if (!ts) continue;
    const data: TemperatureSample = {};
    if (r.pad_heater_left != null)    data.LeftPadTemperature = r.pad_heater_left;
    if (r.pad_heater_right != null)   data.RightPadTemperature = r.pad_heater_right;
    if (r.ptc_intake != null)         data.IntakeTemperature = r.ptc_intake;
    if (r.ptc_internal != null)       data.InternalTemperature = r.ptc_internal;
    if (r.inner_shell_target != null) data.InnerShellTemperature = r.inner_shell_target;
    if (r.pwm_blower != null)         data.BlowerPwm = r.pwm_blower;
    if (Object.keys(data).length) out.push({ timestamp: ts, data });
  }
  return out;
}

function processMachineHealth(rows: MachineHealthRow[]): LiveSample<MachineHealthSample>[] {
  const out: LiveSample<MachineHealthSample>[] = [];
  for (const r of rows) {
    const ts = parseTs(r.created_at);
    if (!ts) continue;
    const data: MachineHealthSample = {};
    if (r.error_code != null) data.error_code = r.error_code;
    if (r.state != null)      data.state = r.state;
    if (r.rssi != null)       data.rssi = r.rssi;
    if (Object.keys(data).length) out.push({ timestamp: ts, data });
  }
  return out;
}

function processBme(rows: BmeSensorRow[]): {
  left: LiveSample<BmeSample>[];
  right: LiveSample<BmeSample>[];
} {
  const left: LiveSample<BmeSample>[] = [];
  const right: LiveSample<BmeSample>[] = [];
  for (const r of rows) {
    const ts = parseTs(r.created_at);
    if (!ts || r.num_bme == null) continue;
    const sample: BmeSample = {
      Temperature: r.temperature ?? 0,
      Humidity: r.humidity ?? 0,
      Pressure: r.pressure ?? 0,
      GasResistance: r.gasres ?? 0,
    };
    (r.num_bme === 1 ? left : right).push({ timestamp: ts, data: sample });
  }
  return { left, right };
}

function emptyLiveData(): LiveData {
  return {
    [RecordType.Current]: [],
    [RecordType.Temperature]: [],
    [RecordType.MachineHealth]: [],
    [RecordType.BmeLeft]: [],
    [RecordType.BmeRight]: [],
  };
}

// ── Pagination ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 5_000;
const ROW_CAP = 200_000;

async function fetchAllRows<T>(
  table: string,
  serialNumber: string,
  columns: string,
  windowStartIso: string,
): Promise<T[]> {
  const all: T[] = [];
  let start = 0;
  while (all.length < ROW_CAP) {
    const end = start + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq('serial_number', serialNumber)
      .gte('created_at', windowStartIso)
      .order('created_at', { ascending: false })
      .range(start, end);
    if (error) throw error;
    const rows = (data as T[] | null) ?? [];
    if (!rows.length) break;
    all.push(...rows);
    start += rows.length;
  }
  return all;
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

export interface DashboardData {
  events: ParsedEvent[];
  liveData: LiveData;
  lastFetched: Date | null;
}

export function useDashboardData(serialNumber: string | null, hours = DATA_RETENTION_HOURS) {
  const [data, setData] = useState<DashboardData>({
    events: [],
    liveData: emptyLiveData(),
    lastFetched: null,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    if (!serialNumber) {
      setData({ events: [], liveData: emptyLiveData(), lastFetched: null });
      return;
    }
    setLoading(true);
    setError(null);
    const windowStart = new Date(Date.now() - hours * 3_600_000).toISOString();

    (async () => {
      try {
        const [evRows, acRows, tempRows, mhRows, bmeRows] = await Promise.all([
          fetchAllRows<EventRow>(
            'events', serialNumber,
            'created_at, sensor_name, event_value', windowStart,
          ),
          fetchAllRows<AcCurrentRow>(
            'ac_current', serialNumber,
            'created_at, chamber_motor_left, chamber_motor_right, total_current', windowStart,
          ),
          fetchAllRows<TemperatureSensorRow>(
            'temperature_sensors', serialNumber,
            'created_at, pad_heater_left, pad_heater_right, ptc_intake, ptc_internal, inner_shell_target, pwm_blower',
            windowStart,
          ),
          fetchAllRows<MachineHealthRow>(
            'machine_health', serialNumber,
            'created_at, error_code, state, rssi', windowStart,
          ),
          fetchAllRows<BmeSensorRow>(
            'bme_sensors', serialNumber,
            'created_at, num_bme, temperature, humidity, pressure, gasres', windowStart,
          ),
        ]);
        if (cancelled.current) return;

        const bme = processBme(bmeRows);
        const liveData: LiveData = {
          [RecordType.Current]:       sortByTs(processAcCurrent(acRows)),
          [RecordType.Temperature]:   sortByTs(processTemperature(tempRows)),
          [RecordType.MachineHealth]: sortByTs(processMachineHealth(mhRows)),
          [RecordType.BmeLeft]:       sortByTs(bme.left),
          [RecordType.BmeRight]:      sortByTs(bme.right),
        };
        setData({
          events: sortByTs(processEvents(evRows)),
          liveData,
          lastFetched: new Date(),
        });
      } catch (e) {
        if (!cancelled.current) setError(e as Error);
      } finally {
        if (!cancelled.current) setLoading(false);
      }
    })();

    return () => {
      cancelled.current = true;
    };
  }, [serialNumber, hours, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, refresh };
}

export function useAvailableSerials() {
  const [data, setData] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows, error: err } = await supabase.from('lila').select('serial_number');
      if (cancelled) return;
      if (err) {
        setError(err as unknown as Error);
        setLoading(false);
        return;
      }
      const serials = Array.from(
        new Set(
          (rows ?? [])
            .map((r) => (r as { serial_number: unknown }).serial_number)
            .filter((s): s is string => typeof s === 'string' && s.length > 0),
        ),
      ).sort();
      setData(serials);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading, error };
}

/** Reads the makelila system-of-record `units.customer_name` for every
 *  serial. Used by the Dashboard so machines display as "Linda Smith"
 *  instead of "LL01-284". Source: main makelila supabase (NOT telemetry).
 *  Falls through to `useSerialToUser` (telemetry `lila.user`) for serials
 *  with no units row yet. */
export function useUnitCustomerMap() {
  const [data, setData] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows, error: err } = await supabaseMain
        .from('units')
        .select('serial, customer_name')
        .not('customer_name', 'is', null);
      if (cancelled) return;
      if (err) {
        setError(err as unknown as Error);
        setLoading(false);
        return;
      }
      const map: Record<string, string> = {};
      for (const r of (rows ?? []) as Array<{ serial: string; customer_name: string | null }>) {
        if (r.customer_name && r.customer_name.trim()) map[r.serial] = r.customer_name.trim();
      }
      setData(map);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { data, loading, error, refresh };
}

// ── Backlog #60 + #66: status-keyed customer SMS ────────────────────────────
//
// Operators can send a customer-facing SMS keyed off the live machine status.
// Three statuses get a discovery (wellness-check) template, OPEN_LID gets a
// prescriptive template, the rest are no-op. A 48h same-status cooldown
// prevents accidental spam if the status flickers.

export type StatusSmsKind = 'wellness' | 'lid' | null;

export const STATUS_SMS_KIND: Record<MachineStatus, StatusSmsKind> = {
  OK:          null,
  NEW_FOOD:    null,
  DRY_SOIL:    'wellness',
  SOAKED_SOIL: 'wellness',
  NOT_MIXING:  'wellness',
  OPEN_LID:    'lid',
  DIAGNOSE:    null,
};

export const STATUS_SMS_TEMPLATES: Record<NonNullable<StatusSmsKind>, {
  label: string;
  body: (firstName: string) => string;
}> = {
  wellness: {
    label: 'Wellness-check SMS',
    body: (n) => `Hi ${n} — quick check-in on your LILA composter! We're seeing some unusual signals in the data and wanted to make sure things are still looking good on your end. How's the compost coming along? Any noises, smells, or anything that doesn't seem right? Reply here and we'll dig in.`,
  },
  lid: {
    label: 'Lid alert SMS',
    body: (n) => `Hi ${n} — heads up, your LILA's lid sensor is reporting open. The unit pauses heating + mixing while the lid is open, so it'll resume once it's closed. Reply if you think the sensor is mis-reading and we'll take a look!`,
  },
};

const STATUS_SMS_COOLDOWN_MS = 48 * 3600 * 1000;

/** Look up the customer record linked to a unit serial. Returns null when
 *  the unit isn't tied to a customer or the customer can't be resolved.
 *  Used by the Dashboard status-SMS flow.
 *
 *  Resolution order:
 *    0. units.customer_id (the canonical FK, backlog #67) — 65% of units
 *       are linked this way after the one-shot backfill; new units should
 *       get linked at fulfillment-assignment time (separate follow-up).
 *    1. units.customer_name exact case-insensitive match on full_name
 *    2. Last-name match + first-name starts-with (handles spouse-joined
 *       names like "Amila & Rob Smith" vs unit name "Amila Smith")
 *  Step 2 returns null if >1 customer matches — better to surface
 *  "no customer linked" than silently text the wrong person. */
export async function customerForSerial(serial: string): Promise<{
  id: string; full_name: string; first_name: string | null; phone: string | null;
} | null> {
  const { data: unit } = await supabaseMain
    .from('units')
    .select('customer_id, customer_name, is_team_test')
    .eq('serial', serial)
    .maybeSingle();
  if (!unit || unit.is_team_test) return null;

  // 0. FK — canonical link (backlog #67)
  if (unit.customer_id) {
    const { data: byId } = await supabaseMain
      .from('customers')
      .select('id, full_name, first_name, phone')
      .eq('id', unit.customer_id)
      .maybeSingle();
    if (byId) return byId;
  }

  // Fallback path for units the backfill couldn't resolve uniquely.
  if (!unit.customer_name) return null;
  const name = unit.customer_name.trim();

  // 1. Exact (case-insensitive) full_name match
  const { data: exact } = await supabaseMain
    .from('customers')
    .select('id, full_name, first_name, phone')
    .ilike('full_name', name)
    .limit(1)
    .maybeSingle();
  if (exact) return exact;

  // 2. Token cascade: first + last word from the unit's name
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0];
    const last  = parts[parts.length - 1];
    const { data: byTokens } = await supabaseMain
      .from('customers')
      .select('id, full_name, first_name, phone')
      .ilike('last_name', last)
      .ilike('first_name', `${first}%`)
      .limit(2);
    if (byTokens && byTokens.length === 1) return byTokens[0];
  }

  return null;
}

/** Returns the timestamp of the most recent `dashboard_status_sms` log entry
 *  for this serial+status within the cooldown window, or null. */
export async function lastStatusSmsAt(serial: string, status: MachineStatus): Promise<Date | null> {
  const cutoff = new Date(Date.now() - STATUS_SMS_COOLDOWN_MS).toISOString();
  const { data } = await supabaseMain
    .from('activity_log')
    .select('ts, detail')
    .eq('type', 'dashboard_status_sms')
    .eq('entity', serial)
    .gte('ts', cutoff)
    .order('ts', { ascending: false })
    .limit(10);
  for (const row of (data ?? []) as Array<{ ts: string; detail: string | null }>) {
    if ((row.detail ?? '').startsWith(`${status}:`)) return new Date(row.ts);
  }
  return null;
}

/** Backlog #59. Returns the set of unit serials flagged as internal team
 *  test units (units.is_team_test=true). The Dashboard filters these out
 *  of the live machine sidebar by default — operators can toggle to show
 *  them when they need to diagnose a test unit. */
export function useTeamTestSerials() {
  const [data, setData] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows, error } = await supabaseMain
        .from('units')
        .select('serial')
        .eq('is_team_test', true);
      if (cancelled) return;
      if (!error && rows) {
        setData(new Set(rows.map((r: { serial: string }) => r.serial)));
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading };
}

/** Writes `units.customer_name` for the given serial via the makelila
 *  supabase, then logs to activity_log. Throws if the units row doesn't
 *  exist (the operator should add the unit to Stock first).
 *  System-of-record per CLAUDE.md: makelila `units` is the truth; the
 *  telemetry `lila.user` field is downstream display only. */
export async function assignCustomerToSerial(serial: string, customerName: string): Promise<void> {
  const trimmed = customerName.trim();
  if (!trimmed) throw new Error('Customer name required.');
  const { data: existing, error: lookupErr } = await supabaseMain
    .from('units')
    .select('serial, customer_name')
    .eq('serial', serial)
    .maybeSingle();
  if (lookupErr) throw lookupErr;
  if (!existing) {
    throw new Error(
      `No units row for ${serial}. Add the unit to Stock first, then assign the customer there.`,
    );
  }
  const prev = existing.customer_name ?? '(unassigned)';
  const { error: updateErr } = await supabaseMain
    .from('units')
    .update({ customer_name: trimmed })
    .eq('serial', serial);
  if (updateErr) throw updateErr;
  await logAction('stock_edit', serial, `customer_name: ${prev} → ${trimmed} (dashboard)`);
}

export function useSerialToUser() {
  const [data, setData] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows, error: err } = await supabase.from('lila').select('serial_number, user');
      if (cancelled) return;
      if (err) {
        setError(err as unknown as Error);
        setLoading(false);
        return;
      }
      const map: Record<string, string> = {};
      for (const r of (rows ?? []) as Array<{ serial_number?: string; user?: string }>) {
        if (typeof r.serial_number === 'string') {
          map[r.serial_number] = r.user && typeof r.user === 'string' ? r.user : r.serial_number;
        }
      }
      setData(map);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading, error };
}

export async function isRecentlyReceiving(
  serialNumber: string,
  windowMinutes = RECENT_RECEIVING_WINDOW_MINUTES,
): Promise<boolean> {
  const startIso = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const { data: ev } = await supabase
    .from('events')
    .select('created_at')
    .eq('serial_number', serialNumber)
    .gte('created_at', startIso)
    .limit(1);
  if (ev && ev.length) return true;
  const { data: ts } = await supabase
    .from('temperature_sensors')
    .select('created_at')
    .eq('serial_number', serialNumber)
    .gte('created_at', startIso)
    .limit(1);
  return !!(ts && ts.length);
}

export function useMachineStatus(serialNumber: string | null) {
  const { data } = useDashboardData(serialNumber);
  const [isReceiving, setIsReceiving] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!serialNumber) {
      setIsReceiving(null);
      return;
    }
    isRecentlyReceiving(serialNumber)
      .then((v) => {
        if (!cancelled) setIsReceiving(v);
      })
      .catch(() => {
        if (!cancelled) setIsReceiving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serialNumber, data.lastFetched]);

  if (!serialNumber || isReceiving == null) {
    return { status: null as MachineStatus | null, color: null as string | null };
  }
  const status = classifyMachineStatus({
    events: data.events,
    liveData: data.liveData,
    isReceiving,
  });
  return { status, color: STATUS_COLORS[status] };
}

/**
 * Returns the subset of `serials` that have transmitted within the last
 * `windowMinutes`. Re-checks periodically so the sidebar stays fresh.
 */
export function useLiveSerials(serials: string[], pollMs = 60_000) {
  const [live, setLive] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState(false);

  const key = serials.join(',');
  useEffect(() => {
    if (!serials.length) {
      setLive(new Set());
      setChecked(true);
      return;
    }
    let cancelled = false;

    const run = async () => {
      const results = await Promise.all(
        serials.map(async (sn) => {
          try {
            return [sn, await isRecentlyReceiving(sn)] as const;
          } catch {
            return [sn, false] as const;
          }
        }),
      );
      if (cancelled) return;
      const next = new Set<string>();
      for (const [sn, isLive] of results) if (isLive) next.add(sn);
      setLive(next);
      setChecked(true);
    };

    run();
    const id = window.setInterval(run, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pollMs]);

  return { live, checked };
}

// ── Display helpers ──────────────────────────────────────────────────────────

export function formatAgo(dt: Date | null): string {
  if (!dt) return '—';
  const mins = Math.max(0, Math.floor((Date.now() - dt.getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

export function latestHumidity(liveData: LiveData): number | null {
  for (const rec of [RecordType.BmeLeft, RecordType.BmeRight] as const) {
    const pts = liveData[rec];
    if (pts.length) {
      const h = pts[pts.length - 1].data.Humidity;
      if (h > LOW_VALID_HUMIDITY) return h;
    }
  }
  return null;
}

export function lastReceived(data: DashboardData): Date | null {
  const candidates: Date[] = [];
  if (data.events.length) candidates.push(data.events[data.events.length - 1].timestamp);
  for (const v of Object.values(data.liveData)) {
    if (v.length) candidates.push(v[v.length - 1].timestamp);
  }
  return candidates.length ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : null;
}
