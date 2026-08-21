import { describe, it, expect } from 'vitest';
import {
  daysSincePlaced, slaTier, slaPercent, slaLabel,
  SLA_TICKS, SLA_DAYS, OVERDUE_DAYS,
} from '../sla';

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-21T12:00:00Z');
const agoDays = (n: number) => new Date(NOW - n * DAY).toISOString();

describe('daysSincePlaced', () => {
  it('counts whole days back from now', () => {
    expect(daysSincePlaced(agoDays(0), NOW)).toBe(0);
    expect(daysSincePlaced(agoDays(3), NOW)).toBe(3);
    expect(daysSincePlaced(agoDays(41), NOW)).toBe(41);
  });

  it('treats a missing or unparseable timestamp as zero days', () => {
    expect(daysSincePlaced(null, NOW)).toBe(0);
    expect(daysSincePlaced(undefined, NOW)).toBe(0);
    expect(daysSincePlaced('not a date', NOW)).toBe(0);
  });

  // Shopify rows arrive with the store's clock, which can run ahead of ours.
  it('clamps a future timestamp to zero rather than going negative', () => {
    expect(daysSincePlaced(new Date(NOW + 2 * DAY).toISOString(), NOW)).toBe(0);
  });
});

describe('slaTier', () => {
  it('is on time up to and including the SLA day', () => {
    expect(slaTier(0)).toBe('ontime');
    expect(slaTier(SLA_DAYS)).toBe('ontime');
  });

  it('is due between the SLA and the overdue ceiling', () => {
    expect(slaTier(SLA_DAYS + 1)).toBe('due');
    expect(slaTier(OVERDUE_DAYS)).toBe('due');
  });

  it('is late past the ceiling', () => {
    expect(slaTier(OVERDUE_DAYS + 1)).toBe('late');
    expect(slaTier(400)).toBe('late');
  });
});

describe('slaPercent', () => {
  it('spans 0–100 and never leaves the track', () => {
    for (const d of [-5, 0, 1, 2, 3, 4, 7, 13, 14, 90, 900]) {
      const p = slaPercent(d);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(100);
    }
  });

  it('never moves backwards as an order ages', () => {
    let prev = -1;
    for (let d = 0; d <= 40; d++) {
      const p = slaPercent(d);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  // The axis is only readable if the ticks the header draws land exactly where
  // a row of that age lands. This is the assertion that keeps them in step.
  it.each([
    [0, 'today'], [SLA_DAYS, '2d'], [OVERDUE_DAYS, '4d'], [7, '1w'], [14, '2w+'],
  ])('a %i-day order sits exactly on the "%s" tick', (days, label) => {
    const tick = SLA_TICKS.find(t => t.label === label);
    expect(tick, `no tick labelled ${label}`).toBeDefined();
    expect(slaPercent(days as number)).toBeCloseTo(tick!.pct, 6);
  });

  it('compresses the tail — a fortnight and a year both sit at the end', () => {
    expect(slaPercent(14)).toBe(100);
    expect(slaPercent(365)).toBe(100);
  });
});

describe('slaLabel', () => {
  it('reads in days inside a fortnight and weeks beyond it', () => {
    expect(slaLabel(0)).toBe('today');
    expect(slaLabel(1)).toBe('1d');
    expect(slaLabel(14)).toBe('14d');
    expect(slaLabel(21)).toBe('3w');
  });
});
