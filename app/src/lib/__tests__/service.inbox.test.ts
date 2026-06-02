import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promoteToTicket, setInboxDisposition } from '../service';

// Minimal Supabase chain mock that captures the last .update() / .eq() call.
const updateMock = vi.fn().mockResolvedValue({ data: null, error: null });
const eqMock = vi.fn(() => ({ then: (cb: any) => cb({ data: null, error: null }) }));
const updateChainMock = vi.fn(() => ({ eq: eqMock }));

vi.mock('../supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      update: updateChainMock,
    })),
  },
  SUPABASE_URL: '', SUPABASE_ANON_KEY: '',
}));

vi.mock('../activityLog', () => ({ logAction: vi.fn().mockResolvedValue(undefined) }));

beforeEach(() => {
  updateMock.mockClear();
  eqMock.mockClear();
  updateChainMock.mockClear();
});

describe('promoteToTicket', () => {
  it('flips kind to ticket, sets promoted disposition + category + owner', async () => {
    await promoteToTicket('row-1', {
      category: 'support',
      owner_email: 'reina@virgohome.io',
    });
    expect(updateChainMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'ticket',
      inbox_disposition: 'promoted',
      category: 'support',
      owner_email: 'reina@virgohome.io',
      status: 'triaging',
    }));
    expect(eqMock).toHaveBeenCalledWith('id', 'row-1');
  });
});

describe('setInboxDisposition', () => {
  it('updates disposition without flipping kind for sales/follow_up/dismissed', async () => {
    await setInboxDisposition('row-2', 'sales');
    expect(updateChainMock).toHaveBeenCalledWith({ inbox_disposition: 'sales' });
    expect(eqMock).toHaveBeenCalledWith('id', 'row-2');
  });

  it('clears disposition when passed null', async () => {
    await setInboxDisposition('row-3', null);
    expect(updateChainMock).toHaveBeenCalledWith({ inbox_disposition: null });
  });
});
