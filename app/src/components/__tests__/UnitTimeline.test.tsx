import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UnitTimeline } from '../UnitTimeline';
import type { TimelineEvent } from '../../lib/stock';

// ── Mock useUnitTimeline ───────────────────────────────────────────────────────

const { mockReturn } = vi.hoisted(() => ({
  mockReturn: { current: { events: [] as TimelineEvent[], loading: false } },
}));

vi.mock('../../lib/stock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stock')>();
  return {
    ...actual,
    useUnitTimeline: (_serial: string) => mockReturn.current,
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<TimelineEvent> & { id: string; ts: string }): TimelineEvent {
  return {
    kind: 'activity',
    label: 'Test event',
    source: 'activity_log',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('UnitTimeline', () => {
  it('renders empty state when useUnitTimeline returns 0 events', () => {
    mockReturn.current = { events: [], loading: false };
    render(<UnitTimeline unitSerial="LL01-00000000001" />);
    expect(screen.getByText(/no history found/i)).toBeTruthy();
  });

  it('renders events in correct order (most recent first) for 3 mocked events', () => {
    const events: TimelineEvent[] = [
      makeEvent({ id: 'e1', ts: '2026-01-01T00:00:00Z', label: 'Oldest' }),
      makeEvent({ id: 'e2', ts: '2026-03-01T00:00:00Z', label: 'Newest' }),
      makeEvent({ id: 'e3', ts: '2026-02-01T00:00:00Z', label: 'Middle' }),
    ];
    // Sort descending (as mergeTimelineEvents does) to simulate what the hook returns
    const sorted = [...events].sort((a, b) => b.ts.localeCompare(a.ts));
    mockReturn.current = { events: sorted, loading: false };

    render(<UnitTimeline unitSerial="LL01-00000000001" />);

    const labels = screen.getAllByText(/Newest|Middle|Oldest/);
    expect(labels[0].textContent).toBe('Newest');
    expect(labels[1].textContent).toBe('Middle');
    expect(labels[2].textContent).toBe('Oldest');
  });

  it('compact mode shows at most 10 events when 15 are returned', () => {
    const events: TimelineEvent[] = Array.from({ length: 15 }, (_, i) => makeEvent({
      id: `e${i}`,
      ts: new Date(Date.now() - i * 60_000).toISOString(),
      label: `Event ${i}`,
    }));
    mockReturn.current = { events, loading: false };

    render(<UnitTimeline unitSerial="LL01-00000000001" density="compact" />);

    // 10 event rows visible; the rest are hidden behind "+5 more events" button
    const allEventLabels = screen.getAllByText(/^Event \d+$/);
    expect(allEventLabels.length).toBe(10);
    expect(screen.getByText(/\+5 more events/i)).toBeTruthy();
  });

  it('full mode shows all events', () => {
    const events: TimelineEvent[] = Array.from({ length: 15 }, (_, i) => makeEvent({
      id: `e${i}`,
      ts: new Date(Date.now() - i * 60_000).toISOString(),
      label: `Event ${i}`,
    }));
    mockReturn.current = { events, loading: false };

    render(<UnitTimeline unitSerial="LL01-00000000001" density="full" />);

    const allEventLabels = screen.getAllByText(/^Event \d+$/);
    expect(allEventLabels.length).toBe(15);
    // No "more events" button in full mode
    expect(screen.queryByText(/more events/i)).toBeNull();
  });

  it('renders loading state', () => {
    mockReturn.current = { events: [], loading: true };
    render(<UnitTimeline unitSerial="LL01-00000000001" />);
    expect(screen.getByText(/loading history/i)).toBeTruthy();
  });
});
