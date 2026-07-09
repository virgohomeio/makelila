import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { fromMock, invokeMock } = vi.hoisted(() => {
  const limitMock = vi.fn().mockResolvedValue({
    data: [
      {
        campaign_id: 'c-1',
        campaign_name: 'Spring Launch',
        status: 'ACTIVE',
        objective: 'LEAD_GENERATION',
        date_start: '2026-05-01',
        date_stop: '2026-05-31',
        spend_cad: 500,
        impressions: 10000,
        clicks: 200,
        leads: 15,
        cpl_cad: 33.33,
        synced_at: '2026-06-01T00:00:00Z',
      },
    ],
    error: null,
  });
  const orderMock = vi.fn(() => ({ limit: limitMock }));
  const selectMock = vi.fn(() => ({ order: orderMock }));
  const fromMock = vi.fn(() => ({ select: selectMock }));
  const invokeMock = vi.fn().mockResolvedValue({ data: { synced: 3 }, error: null });
  return { fromMock, invokeMock };
});

vi.mock('../supabase', () => {
  const channelMock = () => {
    const ch = { on: () => ch, subscribe: () => ch };
    return ch;
  };
  return {
    supabase: {
      from: fromMock,
      functions: { invoke: invokeMock },
      channel: channelMock,
      removeChannel: vi.fn(),
    },
  };
});

import { useFbCampaigns, triggerFbSync } from './facebook';

describe('useFbCampaigns', () => {
  it('returns campaigns from Supabase', async () => {
    const { result } = renderHook(() => useFbCampaigns());
    await waitFor(() => expect(result.current.campaigns).toHaveLength(1));
    expect(result.current.campaigns[0].campaign_name).toBe('Spring Launch');
  });
});

describe('triggerFbSync', () => {
  it('invokes sync-facebook-ads and returns synced count', async () => {
    const result = await triggerFbSync();
    expect(result.synced).toBe(3);
    expect(invokeMock).toHaveBeenCalledWith('sync-facebook-ads');
  });
});
