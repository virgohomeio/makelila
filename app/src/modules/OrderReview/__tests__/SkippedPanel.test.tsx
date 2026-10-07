import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { SkippedPanel } from '../SkippedPanel';
import type { ShopifySyncResult, ShopifySkip } from '../../../lib/orders';

const skip = (over: Partial<ShopifySkip>): ShopifySkip => ({
  order_ref: '#1249',
  reason: 'no_shipping_address',
  detail: '',
  placed_at: '2026-09-05T14:44:02Z',
  total: '1.05',
  currency: 'CAD',
  customer: 'Natalie Lanctot',
  items: ['LILA Mini Reservation'],
  ...over,
});

const result = (details: ShopifySkip[]): ShopifySyncResult => ({
  fetched: 252,
  imported: 0,
  refreshed: 221,
  skipped: details.length,
  skippedBreakdown: {},
  journeyBatchesFailed: 0,
  skippedDetails: details,
});

describe('SkippedPanel', () => {
  it('names the order rather than only counting it', () => {
    render(<SkippedPanel result={result([skip({})])} onClose={vi.fn()} />);

    expect(screen.getByText('#1249')).toBeInTheDocument();
    expect(screen.getByText(/LILA Mini Reservation/)).toBeInTheDocument();
    expect(screen.getByText(/Natalie Lanctot/)).toBeInTheDocument();
    expect(screen.getByText(/1\.05 CAD/)).toBeInTheDocument();
  });

  it('groups by reason and puts real failures first', () => {
    const { container } = render(
      <SkippedPanel
        result={result([
          skip({ order_ref: '#1249' }),
          skip({ order_ref: '#1246' }),
          skip({
            order_ref: '#1301',
            reason: 'db_error',
            detail: 'refresh: null value in column "city"',
            items: ['LILA P150'],
          }),
        ])}
        onClose={vi.fn()}
      />,
    );

    const headings = [...container.querySelectorAll('[class*="skipGroupHead"]')]
      .map(el => el.textContent);
    expect(headings[0]).toMatch(/Write failed · 1/);
    expect(headings[1]).toMatch(/No shipping address.*· 2/);
  });

  it('shows the db_error detail so a real failure is diagnosable', () => {
    render(
      <SkippedPanel
        result={result([skip({
          order_ref: '#1301',
          reason: 'db_error',
          detail: 'refresh: deadlock detected',
        })])}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/deadlock detected/)).toBeInTheDocument();
  });

  it('explains why these orders have no home here', () => {
    render(<SkippedPanel result={result([skip({})])} onClose={vi.fn()} />);

    expect(
      screen.getByText(/only stores orders with a US or Canadian shipping address/i),
    ).toBeInTheDocument();
  });

  it('reports the skipped count against what Shopify actually returned', () => {
    render(<SkippedPanel result={result([skip({}), skip({ order_ref: '#1248' })])} onClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog', { name: /not imported/i });
    expect(within(dialog).getByText('2 of 252 Shopify orders not imported')).toBeInTheDocument();
  });

  it('closes', () => {
    const onClose = vi.fn();
    render(<SkippedPanel result={result([skip({})])} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});
