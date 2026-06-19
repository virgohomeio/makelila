import { describe, it, expect } from 'vitest';
import { MANUAL_TAGS, mergeManualTags } from './followups';
import type { FollowUpStatusKey } from './followupStatus';

describe('MANUAL_TAGS', () => {
  it('excludes the date-derived keys', () => {
    for (const k of ['overdue', 'due_today', 'due_7d', 'fu_on_hold', 'diag_followup_due'] as FollowUpStatusKey[]) {
      expect(MANUAL_TAGS.includes(k)).toBe(false);
    }
  });
  it('includes the state-like keys', () => {
    expect(MANUAL_TAGS).toContain('active');
    expect(MANUAL_TAGS).toContain('awaiting_response');
  });
});

describe('mergeManualTags', () => {
  it('unions manual tags into the derived set (ignoring unknown strings)', () => {
    const derived = new Set<FollowUpStatusKey>(['overdue']);
    const out = mergeManualTags(derived, ['active', 'bogus', 'returned']);
    expect([...out].sort()).toEqual(['active', 'overdue', 'returned']);
  });
  it('handles null/empty manual tags', () => {
    const derived = new Set<FollowUpStatusKey>(['active']);
    expect([...mergeManualTags(derived, null)]).toEqual(['active']);
  });
});
