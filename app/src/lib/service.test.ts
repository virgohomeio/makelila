import { describe, it, expect } from 'vitest';
import { onboardingAnchorDate } from './service';

describe('onboardingAnchorDate', () => {
  it('uses the latest onboarding call date, sliced to YYYY-MM-DD', () => {
    const tickets = [
      { calendly_event_start: '2026-06-01T15:00:00Z' },
      { calendly_event_start: '2026-06-10T18:30:00Z' },
    ];
    expect(onboardingAnchorDate(tickets, '2026-06-20T00:00:00Z')).toBe('2026-06-10');
  });

  it('falls back to the completion date when there is no Calendly call', () => {
    expect(onboardingAnchorDate([], '2026-06-20T12:00:00Z')).toBe('2026-06-20');
    expect(onboardingAnchorDate([{ calendly_event_start: null }], '2026-06-20T12:00:00Z')).toBe('2026-06-20');
  });

  it('ignores null starts and picks the latest real one', () => {
    const tickets = [
      { calendly_event_start: null },
      { calendly_event_start: '2026-05-05T09:00:00Z' },
    ];
    expect(onboardingAnchorDate(tickets, '2026-07-01T00:00:00Z')).toBe('2026-05-05');
  });

  it('is order-independent (latest wins regardless of array order)', () => {
    const tickets = [
      { calendly_event_start: '2026-06-10T18:30:00Z' },
      { calendly_event_start: '2026-06-01T15:00:00Z' },
    ];
    expect(onboardingAnchorDate(tickets, '2026-06-20T00:00:00Z')).toBe('2026-06-10');
  });
});
