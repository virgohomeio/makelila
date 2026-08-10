import { describe, it, expect } from 'vitest';
import {
  onboardingAnchorDate, shouldNotifyAssignment, ownerFirstName,
  ticketStatusSet,
} from './service';

describe('ticketStatusSet', () => {
  it('unions the status column with the tags array', () => {
    expect(ticketStatusSet({ status: 'in_progress', tags: ['queued_for_replacement'] }))
      .toEqual(['in_progress', 'queued_for_replacement']);
  });

  it('returns TICKET_STATUSES order, not tag insertion order', () => {
    expect(ticketStatusSet({ status: 'on_hold', tags: ['queued_for_replacement', 'in_progress'] }))
      .toEqual(['in_progress', 'queued_for_replacement', 'on_hold']);
  });

  it('never duplicates a status that is in both columns', () => {
    expect(ticketStatusSet({ status: 'in_progress', tags: ['in_progress', 'on_hold'] }))
      .toEqual(['in_progress', 'on_hold']);
  });

  it('handles rows written before multi-select (null / empty tags)', () => {
    expect(ticketStatusSet({ status: 'waiting_on_us', tags: null })).toEqual(['waiting_on_us']);
    expect(ticketStatusSet({ status: 'waiting_on_us', tags: [] })).toEqual(['waiting_on_us']);
  });

  // The frontend and DB status vocabularies have drifted before and
  // white-screened the Support tab. Unknown values must survive to the
  // humanize fallback, never be filtered away.
  it('passes through statuses this build does not recognize', () => {
    expect(ticketStatusSet({ status: 'triaging' as never, tags: [] })).toEqual(['triaging']);
    expect(ticketStatusSet({ status: 'in_progress', tags: ['triaging' as never] }))
      .toEqual(['in_progress', 'triaging']);
  });
});

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

describe('shouldNotifyAssignment', () => {
  it('notifies when assigning to a new person other than the actor', () => {
    expect(shouldNotifyAssignment(null, 'reina@virgohome.io', 'huayi@virgohome.io')).toBe(true);
    expect(shouldNotifyAssignment('junaid@virgohome.io', 'reina@virgohome.io', 'huayi@virgohome.io')).toBe(true);
  });

  it('does not notify on self-assignment', () => {
    expect(shouldNotifyAssignment(null, 'huayi@virgohome.io', 'huayi@virgohome.io')).toBe(false);
    // Case-insensitive.
    expect(shouldNotifyAssignment(null, 'Huayi@Virgohome.io', 'huayi@virgohome.io')).toBe(false);
  });

  it('does not notify when the owner is unchanged', () => {
    expect(shouldNotifyAssignment('reina@virgohome.io', 'reina@virgohome.io', 'huayi@virgohome.io')).toBe(false);
  });

  it('does not notify when unassigning (new owner is null/empty)', () => {
    expect(shouldNotifyAssignment('reina@virgohome.io', null, 'huayi@virgohome.io')).toBe(false);
    expect(shouldNotifyAssignment('reina@virgohome.io', '', 'huayi@virgohome.io')).toBe(false);
  });

  it('tolerates a missing actor email (still notifies a real new owner)', () => {
    expect(shouldNotifyAssignment(null, 'reina@virgohome.io', undefined)).toBe(true);
  });
});

describe('ownerFirstName', () => {
  it('capitalizes the local-part before the domain', () => {
    expect(ownerFirstName('reina@virgohome.io')).toBe('Reina');
    expect(ownerFirstName('yueli@virgohome.io')).toBe('Yueli');
  });

  it('splits on separators in the local-part', () => {
    expect(ownerFirstName('mary.jane@virgohome.io')).toBe('Mary');
    expect(ownerFirstName('jon_snow@virgohome.io')).toBe('Jon');
  });
});
