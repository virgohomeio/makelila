// Marketplace orders (process change 2026-11-19): which orders count, the
// Sales channel filter, the Needs-attention reason, the Ship By write, and the
// arrival alert's recipients and copy (shared with sync-shopify-orders).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state, logMock } = vi.hoisted(() => ({
  state: {
    updates: [] as Array<{ table: string; patch: any; match: Record<string, any> }>,
    returned: [{ id: 'q-1' }] as any[],
    error: null as any,
  },
  logMock: vi.fn(async (..._args: any[]) => {}),
}));

vi.mock('./supabase', () => ({
  supabase: {
    from: (table: string) => ({
      update: (patch: any) => {
        const match: Record<string, any> = {};
        const c: any = {
          eq: (col: string, val: any) => { match[col] = val; return c; },
          select: () => {
            state.updates.push({ table, patch, match });
            return Promise.resolve({ data: state.returned, error: state.error });
          },
        };
        return c;
      },
    }),
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: () => {},
  },
}));
vi.mock('./activityLog', () => ({ logAction: logMock }));

import {
  isMarketplaceChannel, marketplaceOf, matchesChannel, attentionReason,
  setMarketplaceShipBy, isIsoDay, formatIsoDay,
} from './marketplace';
import {
  marketplaceAlertRecipients, DEFAULT_MARKETPLACE_ALERT_TO, arrivalVariables,
  renderTemplate, ARRIVAL_FALLBACK_SUBJECT, ARRIVAL_FALLBACK_BODY,
} from '../../../supabase/functions/_shared/marketplace.ts';

beforeEach(() => {
  state.updates = [];
  state.returned = [{ id: 'q-1' }];
  state.error = null;
  logMock.mockClear();
});

describe('which channels are marketplaces', () => {
  it('names the three marketplaces from the sync labels', () => {
    expect(marketplaceOf('Walmart')).toBe('Walmart');
    expect(marketplaceOf('Best Buy')).toBe('Best Buy');
    expect(marketplaceOf('BestBuy Canada')).toBe('Best Buy');
    expect(marketplaceOf('Marketplace (Mirakl)')).toBe('Mirakl');
  });

  it('is not a marketplace: our website, subscriptions, Collective, blank', () => {
    for (const c of ['Our Website', 'subscription_contract_checkout_one', 'Shopify Collective',
      'Manual / Draft', '', null, undefined]) {
      expect(isMarketplaceChannel(c)).toBe(false);
    }
  });

  it('filters the Sales rail by channel', () => {
    const w = { sales_channel: 'Walmart' };
    const site = { sales_channel: 'Our Website' };
    const old = { sales_channel: null };
    expect(matchesChannel(w, 'marketplace')).toBe(true);
    expect(matchesChannel(site, 'marketplace')).toBe(false);
    expect(matchesChannel(old, 'website')).toBe(true);
    expect(matchesChannel(w, 'website')).toBe(false);
    expect(matchesChannel(w, 'all')).toBe(true);
  });
});

describe('Needs attention reason', () => {
  const note = (body: string, created_at: string, author_name = 'Reina') => ({ body, created_at, author_name });

  it('reads the newest Held note for a held order', () => {
    const r = attentionReason({ status: 'held', customer_phone: '555' }, [
      note('Held: waiting on customer', '2026-11-01T00:00:00Z'),
      note('Held: address change requested', '2026-11-03T00:00:00Z'),
      note('Flagged: wrong item', '2026-11-04T00:00:00Z'),
    ]);
    expect(r.text).toBe('address change requested');
    expect(r.by).toBe('Reina');
  });

  it('reads a flag raised from the fulfillment queue, and says so', () => {
    const r = attentionReason({ status: 'flagged', customer_phone: '555' }, [
      note('Flagged from the fulfillment queue: Address is a PO box', '2026-11-02T00:00:00Z', 'Junaid'),
    ]);
    expect(r.text).toBe('From the queue: Address is a PO box');
  });

  it('names the automatic no-phone flag when there is no note', () => {
    expect(attentionReason({ status: 'flagged', customer_phone: null }, []).text)
      .toMatch(/no phone number/i);
  });

  it('says plainly when no reason was recorded', () => {
    expect(attentionReason({ status: 'held', customer_phone: '555' }, [
      note('Some unrelated note', '2026-11-02T00:00:00Z'),
    ]).text).toBe('No reason recorded');
  });
});

describe('Ship By date', () => {
  it('accepts only real calendar days', () => {
    expect(isIsoDay('2026-11-30')).toBe(true);
    expect(isIsoDay('2026-02-30')).toBe(false);
    expect(isIsoDay('11/30/2026')).toBe(false);
    expect(isIsoDay('')).toBe(false);
  });

  it('shows a date column as the same calendar day (no UTC slip)', () => {
    expect(formatIsoDay('2026-11-30')).toBe('Nov 30, 2026');
  });

  it('sets the queue due date to the Ship By date and marks it priority', async () => {
    await setMarketplaceShipBy({ id: 'o-1', order_ref: '#1363' }, '2026-11-27');
    expect(state.updates).toEqual([{
      table: 'fulfillment_queue',
      patch: { due_date: '2026-11-27', priority: true },
      match: { order_id: 'o-1' },
    }]);
    expect(logMock).toHaveBeenCalledWith('fq_ship_by_set', '#1363', 'Ship By 2026-11-27',
      { entityType: 'order', entityId: 'o-1' });
  });

  it('fails loudly when the order has no queue row, rather than saving nowhere', async () => {
    state.returned = [];
    await expect(setMarketplaceShipBy({ id: 'o-1', order_ref: '#1363' }, '2026-11-27'))
      .rejects.toThrow(/no fulfillment queue row/);
    expect(logMock).not.toHaveBeenCalled();
  });

  it('refuses a malformed date without touching the database', async () => {
    await expect(setMarketplaceShipBy({ id: 'o-1', order_ref: '#1363' }, '2026-13-01'))
      .rejects.toThrow(/not a valid date/);
    expect(state.updates).toHaveLength(0);
  });
});

describe('arrival alert', () => {
  it('defaults to a primary and a backup recipient', () => {
    expect(marketplaceAlertRecipients(undefined)).toEqual(DEFAULT_MARKETPLACE_ALERT_TO);
    expect(DEFAULT_MARKETPLACE_ALERT_TO.length).toBeGreaterThanOrEqual(2);
  });

  it('takes recipients from the env value, deduped and trimmed', () => {
    expect(marketplaceAlertRecipients(' a@x.io, b@x.io ,a@x.io,not-an-email '))
      .toEqual(['a@x.io', 'b@x.io']);
  });

  it('renders the fallback copy with every variable filled', () => {
    const vars = arrivalVariables({
      order_ref: '#1363', sales_channel: 'Walmart', customer_name: 'Pat Doe',
      city: 'Austin', region_state: 'TX', country: 'US', total_usd: 699, currency: 'USD',
      placed_at: '2026-11-24T06:31:55Z',
    });
    const subject = renderTemplate(ARRIVAL_FALLBACK_SUBJECT, vars);
    const body = renderTemplate(ARRIVAL_FALLBACK_BODY, vars);
    expect(subject).toBe('New Walmart order #1363: check its Ship By date');
    expect(body).toContain('Ship to: Austin, TX · US');
    expect(body).toContain('Total: 699.00 USD');
    expect(`${subject}${body}`).not.toMatch(/\{\{/);
  });
});
