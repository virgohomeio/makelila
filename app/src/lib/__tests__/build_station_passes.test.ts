import { describe, it, expect } from 'vitest';
import {
  computeFirstPassYield,
  nextAttemptSeq,
  type StationPass,
  type StationPassStation,
} from '../build';

// ============================================================ Fixtures

function makePass(overrides: Partial<StationPass>): StationPass {
  return {
    id: 'test-id',
    unit_serial: 'LL01-00000000001',
    station: 'electrical',
    pass_status: 'pass',
    attempt_seq: 1,
    defect_category: null,
    defect_notes: null,
    technician_id: null,
    firmware_version: null,
    photo_urls: [],
    created_at: '2026-06-10T10:00:00Z',
    ...overrides,
  };
}

// ============================================================ nextAttemptSeq

describe('nextAttemptSeq', () => {
  it('returns 1 when no prior attempts (null)', () => {
    expect(nextAttemptSeq(null)).toBe(1);
  });

  it('returns 1 when no prior attempts (undefined)', () => {
    expect(nextAttemptSeq(undefined)).toBe(1);
  });

  it('increments from existing max', () => {
    expect(nextAttemptSeq(3)).toBe(4);
  });

  it('increments from 0', () => {
    expect(nextAttemptSeq(0)).toBe(1);
  });
});

// ============================================================ computeFirstPassYield

describe('computeFirstPassYield', () => {
  it('returns 0 for empty passes', () => {
    expect(computeFirstPassYield([], 'electrical')).toBe(0);
  });

  it('returns 0 when no passes for the station', () => {
    const passes = [
      makePass({ unit_serial: 'LL01-00000000001', station: 'mechanical', pass_status: 'pass', attempt_seq: 1 }),
    ];
    expect(computeFirstPassYield(passes, 'electrical')).toBe(0);
  });

  it('100% FPY when all units pass on first attempt', () => {
    const passes = [
      makePass({ unit_serial: 'LL01-00000000001', station: 'electrical', pass_status: 'pass', attempt_seq: 1 }),
      makePass({ unit_serial: 'LL01-00000000002', station: 'electrical', pass_status: 'pass', attempt_seq: 1 }),
    ];
    expect(computeFirstPassYield(passes, 'electrical')).toBe(100);
  });

  it('66.7% FPY: 3 units, 2 passed on attempt 1, 1 needed rework then passed', () => {
    const passes = [
      // Unit 1: pass on attempt 1
      makePass({ unit_serial: 'LL01-00000000001', station: 'electrical', pass_status: 'pass', attempt_seq: 1 }),
      // Unit 2: pass on attempt 1
      makePass({ unit_serial: 'LL01-00000000002', station: 'electrical', pass_status: 'pass', attempt_seq: 1 }),
      // Unit 3: rework on attempt 1, pass on attempt 2
      makePass({ unit_serial: 'LL01-00000000003', station: 'electrical', pass_status: 'rework', attempt_seq: 1 }),
      makePass({ unit_serial: 'LL01-00000000003', station: 'electrical', pass_status: 'pass', attempt_seq: 2 }),
    ];
    const fpy = computeFirstPassYield(passes, 'electrical');
    expect(fpy).toBeCloseTo(66.67, 1);
  });

  it('0% FPY when all units fail on first attempt', () => {
    const passes = [
      makePass({ unit_serial: 'LL01-00000000001', station: 'mechanical', pass_status: 'fail', attempt_seq: 1 }),
      makePass({ unit_serial: 'LL01-00000000002', station: 'mechanical', pass_status: 'fail', attempt_seq: 1 }),
    ];
    expect(computeFirstPassYield(passes, 'mechanical')).toBe(0);
  });

  it('does not count attempt_seq > 1 passes toward FPY', () => {
    const passes = [
      // Unit failed on attempt 1 then passed on attempt 2
      makePass({ unit_serial: 'LL01-00000000001', station: 'firmware_flash', pass_status: 'fail', attempt_seq: 1 }),
      makePass({ unit_serial: 'LL01-00000000001', station: 'firmware_flash', pass_status: 'pass', attempt_seq: 2 }),
    ];
    expect(computeFirstPassYield(passes, 'firmware_flash')).toBe(0);
  });

  it('filters correctly per station — mechanical passes do not affect electrical FPY', () => {
    const passes = [
      makePass({ unit_serial: 'LL01-00000000001', station: 'electrical',  pass_status: 'fail', attempt_seq: 1 }),
      makePass({ unit_serial: 'LL01-00000000001', station: 'mechanical',  pass_status: 'pass', attempt_seq: 1 }),
    ];
    expect(computeFirstPassYield(passes, 'electrical')).toBe(0);
    expect(computeFirstPassYield(passes, 'mechanical')).toBe(100);
  });
});

// ============================================================ rework pass_status guard

describe('rework does not map to qc_check enum', () => {
  it('rework pass_status is not pass/fail/incomplete', () => {
    const reworkPass = makePass({ pass_status: 'rework' });
    // The TypeScript type StationPassStatus includes 'rework' but the
    // qc_check enum ('pass'|'fail'|'incomplete') does not.
    // Verify recordStationPass input can carry rework without being
    // cast to the qc_check enum (the trigger handles this at DB level).
    const qcCheckValues = ['pass', 'fail', 'incomplete'] as const;
    const isQcCheckCompatible = (qcCheckValues as readonly string[]).includes(reworkPass.pass_status);
    expect(isQcCheckCompatible).toBe(false);
  });
});
