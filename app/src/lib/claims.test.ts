import { describe, it, expect } from 'vitest';
import { generateClaimRef, CLAIM_STATUSES, CLAIM_STATUS_META } from './claims';

describe('generateClaimRef', () => {
  it('matches CLM-#####', () => {
    expect(generateClaimRef(() => 0)).toBe('CLM-00000');
    expect(generateClaimRef(() => 0.999999)).toMatch(/^CLM-\d{5}$/);
    expect(generateClaimRef()).toMatch(/^CLM-\d{5}$/);
  });
});

describe('CLAIM_STATUS_META', () => {
  it('has a meta entry for every status', () => {
    for (const s of CLAIM_STATUSES) {
      expect(CLAIM_STATUS_META[s]).toBeTruthy();
      expect(typeof CLAIM_STATUS_META[s].label).toBe('string');
    }
  });
});
