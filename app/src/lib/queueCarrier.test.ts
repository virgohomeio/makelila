// queueCarrier — the guard between a free-text carrier field and a
// CHECK-constrained column. See lib/queueCarrier.ts for what it cost to learn
// that the difference matters (R-0069, 2026-09-29).
import { describe, it, expect } from 'vitest';
import { QUEUE_CARRIERS, queueCarrier } from './queueCarrier';

describe('queueCarrier', () => {
  it('passes every carrier the column accepts', () => {
    for (const c of QUEUE_CARRIERS) expect(queueCarrier(c)).toBe(c);
  });

  // The whole point: the operator's answer is kept on the order, and this
  // column is simply left alone rather than failing the write.
  it('returns null for a carrier the column would reject', () => {
    expect(queueCarrier('Amazon')).toBeNull();
    expect(queueCarrier('USPS')).toBeNull();
    expect(queueCarrier('dropped off by hand')).toBeNull();
  });

  it('is null for blank, whitespace and absent input', () => {
    expect(queueCarrier('')).toBeNull();
    expect(queueCarrier('   ')).toBeNull();
    expect(queueCarrier(null)).toBeNull();
    expect(queueCarrier(undefined)).toBeNull();
  });

  // Typing "canada post" should not be the difference between a recorded
  // shipment and a half-written one.
  it('normalises spelling and spacing onto the stored casing', () => {
    expect(queueCarrier('canada post')).toBe('Canada Post');
    expect(queueCarrier('  CANADAPOST ')).toBe('Canada Post');
    expect(queueCarrier('ups')).toBe('UPS');
    expect(queueCarrier('FedEx ')).toBe('FedEx');
    expect(queueCarrier('purolator')).toBe('Purolator');
  });

  // A near-miss is not a match. "Canada" alone could be anything, and guessing
  // would put a wrong carrier on a tracking link the customer clicks.
  it('does not match on a prefix', () => {
    expect(queueCarrier('Canada')).toBeNull();
    expect(queueCarrier('Canada Post Expedited')).toBeNull();
  });
});
