import { describe, it, expect } from 'vitest';
import {
  classifyMixing,
  detectSideMixing,
  RecordType,
  type CurrentSample,
  type LiveData,
  type LiveSample,
} from './dashboard';

const NOW = new Date('2026-06-04T12:00:00Z').getTime();
const MIN = 60_000;
const HOUR = 3_600_000;

function sample(tMs: number, left: number, right: number): LiveSample<CurrentSample> {
  return {
    timestamp: new Date(tMs),
    data: { AcCurrent: left + right, LeftMotorCurrent: left, RightMotorCurrent: right },
  };
}

/** A motor-on burst: `n` samples spaced 3 min apart starting at `startMs`. */
function run(startMs: number, n: number, left: number, right: number): LiveSample<CurrentSample>[] {
  return Array.from({ length: n }, (_, i) => sample(startMs + i * 3 * MIN, left, right));
}

function liveData(currents: LiveSample<CurrentSample>[]): LiveData {
  return {
    [RecordType.Current]: currents,
    [RecordType.Temperature]: [],
    [RecordType.MachineHealth]: [],
    [RecordType.BmeLeft]: [],
    [RecordType.BmeRight]: [],
  };
}

const pickLeft = (d: CurrentSample) => d.LeftMotorCurrent;

describe('detectSideMixing — run grouping', () => {
  it('merges consecutive high samples within the gap window into one run', () => {
    const samples = run(NOW - HOUR, 3, 95, 0); // 3 samples, 3 min apart
    const r = detectSideMixing(samples, pickLeft, NOW);
    expect(r.runCount).toBe(1);
    expect(r.peakAmps).toBe(95);
    expect(r.hasData).toBe(true);
  });

  it('keeps samples within a ≤8 min gap in the same run', () => {
    const samples = [sample(NOW - HOUR, 95, 0), sample(NOW - HOUR + 6 * MIN, 95, 0)];
    expect(detectSideMixing(samples, pickLeft, NOW).runCount).toBe(1);
  });

  it('splits into separate runs across a >8 min gap', () => {
    const samples = [sample(NOW - HOUR, 95, 0), sample(NOW - HOUR + 10 * MIN, 95, 0)];
    expect(detectSideMixing(samples, pickLeft, NOW).runCount).toBe(2);
  });

  it('ignores idle samples below the on-threshold', () => {
    const samples = [sample(NOW - HOUR, 10, 0), sample(NOW - 30 * MIN, 14, 0)];
    const r = detectSideMixing(samples, pickLeft, NOW);
    expect(r.runCount).toBe(0);
    expect(r.mixing).toBe(false);
    expect(r.hasData).toBe(true);
  });
});

describe('classifyMixing — combined verdict', () => {
  it('BOTH when both sides have ≥3 recent runs', () => {
    const currents = [
      ...run(NOW - 5 * HOUR, 3, 95, 95),
      ...run(NOW - 3 * HOUR, 3, 95, 95),
      ...run(NOW - 1 * HOUR, 3, 95, 95),
    ];
    const { verdict, left, right } = classifyMixing(liveData(currents), NOW);
    expect(verdict).toBe('BOTH');
    expect(left.mixing).toBe(true);
    expect(right.mixing).toBe(true);
    expect(left.medianIntervalMin).toBe(120); // runs spaced 2 h apart
  });

  it('RIGHT_ONLY when only the right side mixes (left idle)', () => {
    const currents = [
      ...run(NOW - 5 * HOUR, 3, 2, 95),
      ...run(NOW - 3 * HOUR, 3, 2, 95),
      ...run(NOW - 1 * HOUR, 3, 2, 95),
    ];
    expect(classifyMixing(liveData(currents), NOW).verdict).toBe('RIGHT_ONLY');
  });

  it('LEFT_ONLY when only the left side mixes', () => {
    const currents = [
      ...run(NOW - 5 * HOUR, 3, 95, 1),
      ...run(NOW - 3 * HOUR, 3, 95, 1),
      ...run(NOW - 1 * HOUR, 3, 95, 1),
    ];
    expect(classifyMixing(liveData(currents), NOW).verdict).toBe('LEFT_ONLY');
  });

  it('NEITHER for lone single-sample inrush spikes (1 run < min)', () => {
    const currents = [sample(NOW - HOUR, 200, 200)];
    expect(classifyMixing(liveData(currents), NOW).verdict).toBe('NEITHER');
  });

  it('NEITHER for a steady elevated baseline that never reaches the mixing regime', () => {
    const currents = Array.from({ length: 20 }, (_, i) => sample(NOW - (20 - i) * 30 * MIN, 10, 12));
    expect(classifyMixing(liveData(currents), NOW).verdict).toBe('NEITHER');
  });

  it('flags a side that stopped mixing >12 h ago via the recency check', () => {
    const currents = [
      // left: 3 recent runs → mixing
      ...run(NOW - 5 * HOUR, 3, 95, 2),
      ...run(NOW - 3 * HOUR, 3, 95, 2),
      ...run(NOW - 1 * HOUR, 3, 95, 2),
      // right: 3 runs but all >12 h ago → not recent
      ...run(NOW - 24 * HOUR, 3, 2, 95),
      ...run(NOW - 22 * HOUR, 3, 2, 95),
      ...run(NOW - 20 * HOUR, 3, 2, 95),
    ];
    const { verdict, right } = classifyMixing(liveData(currents), NOW);
    expect(right.runCount).toBe(3);
    expect(right.mixing).toBe(false);
    expect(verdict).toBe('LEFT_ONLY');
  });

  it('NO_DATA when there are no current samples in the window', () => {
    expect(classifyMixing(liveData([]), NOW).verdict).toBe('NO_DATA');
  });

  it('NO_DATA when samples exist but all fall outside the 48 h window', () => {
    const currents = run(NOW - 50 * HOUR, 3, 95, 95);
    expect(classifyMixing(liveData(currents), NOW).verdict).toBe('NO_DATA');
  });
});

// Backlog #70 — NOT_MIXING cross-check
import { classifyMachineStatus, hasRecentHumidityActivity } from './dashboard';

function liveDataWith({
  currents = [],
  bmeLeft = [],
  bmeRight = [],
}: {
  currents?: LiveSample<CurrentSample>[];
  bmeLeft?: Array<{ timestamp: Date; data: { Temperature: number; Humidity: number; Pressure: number; GasResistance: number } }>;
  bmeRight?: Array<{ timestamp: Date; data: { Temperature: number; Humidity: number; Pressure: number; GasResistance: number } }>;
}): LiveData {
  return {
    [RecordType.Current]: currents,
    [RecordType.Temperature]: [],
    [RecordType.MachineHealth]: [],
    [RecordType.BmeLeft]: bmeLeft as never,
    [RecordType.BmeRight]: bmeRight as never,
  };
}

describe('hasRecentHumidityActivity — #70 cross-check', () => {
  it('returns false for a static humidity series (no chamber activity)', () => {
    // 24 samples over 12h, humidity drifts slowly from 40% to 41% — well below threshold
    const series: Array<[Date, number]> = Array.from({ length: 24 }, (_, i) => [
      new Date(NOW - (24 - i) * 30 * MIN), 40 + i * (1 / 24),
    ]);
    expect(hasRecentHumidityActivity({ 1: series })).toBe(false);
  });

  it('returns true when humidity shows real activity (mixing chamber turnover)', () => {
    // Mimic mixing: humidity oscillates 35 → 50 → 38 → 48 over the window
    const series: Array<[Date, number]> = [
      [new Date(NOW - 12 * HOUR), 40],
      [new Date(NOW - 9 * HOUR), 50],
      [new Date(NOW - 6 * HOUR), 35],
      [new Date(NOW - 3 * HOUR), 48],
      [new Date(NOW - 1 * HOUR), 38],
      [new Date(NOW),             45],
    ];
    expect(hasRecentHumidityActivity({ 1: series })).toBe(true);
  });

  it('returns false when given no series', () => {
    expect(hasRecentHumidityActivity({})).toBe(false);
  });
});

describe('classifyMachineStatus — NOT_MIXING cross-check (#70)', () => {
  it('still flags NOT_MIXING when neither side mixes AND humidity is static', () => {
    const lowCurrent = Array.from({ length: 40 }, (_, i) =>
      sample(NOW - (40 - i) * 30 * MIN, 0.01, 0.01),
    );
    const staticBme = Array.from({ length: 24 }, (_, i) => ({
      timestamp: new Date(NOW - (24 - i) * 30 * MIN),
      data: { Temperature: 25, Humidity: 40 + i * 0.05, Pressure: 1013, GasResistance: 30000 },
    }));
    const status = classifyMachineStatus({
      events: [],
      liveData: liveDataWith({ currents: lowCurrent, bmeLeft: staticBme }),
      isReceiving: true,
    });
    expect(status).toBe('NOT_MIXING');
  });

  it('suppresses NOT_MIXING when humidity is varying (current sensor probably miscalibrated)', () => {
    const lowCurrent = Array.from({ length: 40 }, (_, i) =>
      sample(NOW - (40 - i) * 30 * MIN, 0.01, 0.01),
    );
    const activeBme = [
      { timestamp: new Date(NOW - 12 * HOUR), data: { Temperature: 25, Humidity: 40, Pressure: 1013, GasResistance: 30000 } },
      { timestamp: new Date(NOW - 9  * HOUR), data: { Temperature: 25, Humidity: 50, Pressure: 1013, GasResistance: 30000 } },
      { timestamp: new Date(NOW - 6  * HOUR), data: { Temperature: 25, Humidity: 35, Pressure: 1013, GasResistance: 30000 } },
      { timestamp: new Date(NOW - 3  * HOUR), data: { Temperature: 25, Humidity: 48, Pressure: 1013, GasResistance: 30000 } },
      { timestamp: new Date(NOW - 1  * HOUR), data: { Temperature: 25, Humidity: 38, Pressure: 1013, GasResistance: 30000 } },
      { timestamp: new Date(NOW),             data: { Temperature: 25, Humidity: 45, Pressure: 1013, GasResistance: 30000 } },
    ];
    const status = classifyMachineStatus({
      events: [],
      liveData: liveDataWith({ currents: lowCurrent, bmeLeft: activeBme }),
      isReceiving: true,
    });
    // Should NOT be NOT_MIXING. With this humidity range it'll likely be SOAKED_SOIL,
    // DRY_SOIL, or OK depending on the exact pattern — the key assertion is "not NOT_MIXING".
    expect(status).not.toBe('NOT_MIXING');
  });
});
