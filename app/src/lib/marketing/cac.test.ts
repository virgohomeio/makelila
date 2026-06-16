import { describe, it, expect } from 'vitest';
import { computeCac } from './cac';
import type { CacInput } from './cac';

const input: CacInput = {
  fbSpendByMonth: [
    { month: '2026-05', spend_cad: 1200 },
    { month: '2026-04', spend_cad: 900 },
  ],
  customersByChannel: [
    { channel: 'facebook', count: 5 },
    { channel: 'organic', count: 3 },
    { channel: 'referral', count: 2 },
  ],
};

describe('computeCac', () => {
  it('computes CAC for Facebook from spend / acquired customers', () => {
    const result = computeCac(input);
    const fb = result.find(r => r.channel === 'facebook');
    // total spend = 2100, customers = 5, CAC = 420
    expect(fb?.cac_cad).toBeCloseTo(420, 1);
    expect(fb?.spend_cad).toBe(2100);
    expect(fb?.customers_acquired).toBe(5);
  });

  it('returns cac_cad = null for organic (no spend)', () => {
    const result = computeCac(input);
    const organic = result.find(r => r.channel === 'organic');
    expect(organic?.cac_cad).toBeNull();
    expect(organic?.spend_cad).toBe(0);
  });

  it('returns cac_cad = null when customers_acquired = 0', () => {
    const noCustomers: CacInput = {
      fbSpendByMonth: [{ month: '2026-05', spend_cad: 500 }],
      customersByChannel: [],
    };
    const result = computeCac(noCustomers);
    const fb = result.find(r => r.channel === 'facebook');
    expect(fb?.cac_cad).toBeNull();
  });
});
