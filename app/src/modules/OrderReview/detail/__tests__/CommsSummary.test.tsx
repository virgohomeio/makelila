import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CommsSummary } from '../CommsSummary';
import type { OrderCommAssessment } from '../../../../lib/orderComms';

const requestCommAssessment = vi.fn();
vi.mock('../../../../lib/orderComms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/orderComms')>();
  return { ...actual, requestCommAssessment: (id: string) => requestCommAssessment(id) };
});

const assessment = (over: Partial<OrderCommAssessment> = {}): OrderCommAssessment => ({
  order_id: 'o1',
  verdict: 'clear',
  headline: 'Clear to ship — nothing in recent contact affects this shipment',
  concerns: [],
  evidence: [],
  channels_scanned: {
    quo:   { connected: true,  last_synced_at: '2026-09-09T00:00:00Z', message_count: 4 },
    email: { connected: false, last_synced_at: null, message_count: 0 },
  },
  message_count: 4,
  last_message_at: '2026-09-09T00:00:00Z',
  model: 'Claude',
  assessed_at: '2026-09-10T00:00:00Z',
  error: null,
  ...over,
});

beforeEach(() => requestCommAssessment.mockReset());

describe('CommsSummary', () => {
  it('says it is still checking while loading', () => {
    render(<CommsSummary orderId="o1" assessment={null} loading />);
    expect(screen.getByText(/checking recent customer communication/i)).toBeTruthy();
  });

  it('says so plainly when no assessment exists yet', () => {
    render(<CommsSummary orderId="o1" assessment={null} loading={false} />);
    expect(screen.getByText(/not yet checked/i)).toBeTruthy();
  });

  it('shows the clearance headline', () => {
    render(<CommsSummary orderId="o1" assessment={assessment()} loading={false} />);
    expect(screen.getByText(/clear to ship/i)).toBeTruthy();
  });

  it('distinguishes a clearance from silence', () => {
    render(<CommsSummary orderId="o1" assessment={assessment({
      verdict: 'no_contact',
      headline: 'Clear to ship — no support contact on file',
    })} loading={false} />);
    expect(screen.getByText(/no support contact on file/i)).toBeTruthy();
  });

  it('names the concern, quotes the customer, and asks for confirmation when unclear', () => {
    render(<CommsSummary orderId="o1" assessment={assessment({
      verdict: 'unclear',
      headline: 'Communication unclear (wants to cancel) — confirm the desire to ship',
      concerns: ['cancel_intent'],
      evidence: [{
        channel: 'quo',
        direction: 'inbound',
        sent_at: '2026-09-03T01:00:54Z',
        excerpt: 'we are going to put it in the trash pile and call it a total loss',
      }],
    })} loading={false} />);

    expect(screen.getByText(/confirm the desire to ship/i)).toBeTruthy();
    expect(screen.getByText('Wants to cancel')).toBeTruthy();
    expect(screen.getByText(/trash pile/)).toBeTruthy();
    expect(screen.getByText(/SMS · customer · Sep 3/)).toBeTruthy();
  });

  it('states outright that support email was not read', () => {
    render(<CommsSummary orderId="o1" assessment={assessment()} loading={false} />);
    // Without this line an SMS-only clearance reads as an all-channels one.
    expect(screen.getByText(/Support email not connected/)).toBeTruthy();
  });

  it('surfaces a stored failure rather than presenting a stale verdict as fresh', () => {
    render(<CommsSummary orderId="o1" assessment={assessment({ error: 'Claude 429: rate limited' })} loading={false} />);
    expect(screen.getByText(/last check failed/i)).toBeTruthy();
    expect(screen.getByText(/rate limited/)).toBeTruthy();
  });

  it('offers a re-check', () => {
    render(<CommsSummary orderId="o1" assessment={assessment()} loading={false} />);
    expect(screen.getByRole('button', { name: /re-check/i })).toBeTruthy();
  });
});
