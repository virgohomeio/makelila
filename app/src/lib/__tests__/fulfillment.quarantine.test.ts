import { describe, it, expect, vi, beforeEach } from 'vitest';

// Table-aware supabase mock: orders returns a valid row, units returns controllable status.
const { fromMock, unitStatus } = vi.hoisted(() => {
  const unitStatus = { value: 'ready' };

  const orderSingle = vi.fn().mockResolvedValue({
    data: { order_ref: '#TEST-001', customer_name: 'Test Customer' },
    error: null,
  });

  const unitSingle = vi.fn(() =>
    Promise.resolve({ data: { status: unitStatus.value }, error: null }),
  );

  const ordersChain = { eq: vi.fn(() => ({ single: orderSingle })) };
  const unitsSelectChain = { eq: vi.fn(() => ({ single: unitSingle })) };
  const unitsUpdateChain = { eq: vi.fn().mockResolvedValue({ error: null }) };
  const shelfChain = { eq: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })) };

  const fromMock = vi.fn((table: string) => {
    if (table === 'orders') return { select: vi.fn(() => ordersChain) };
    if (table === 'shelf_slots') return { update: vi.fn(() => shelfChain) };
    // units: handle both select and update
    return {
      select: vi.fn(() => unitsSelectChain),
      update: vi.fn(() => unitsUpdateChain),
    };
  });

  return { fromMock, unitStatus };
});

vi.mock('../supabase', () => ({
  supabase: {
    from: fromMock,
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
  },
}));
vi.mock('../activityLog', () => ({ logAction: vi.fn().mockResolvedValue(undefined) }));

import { assignUnit } from '../fulfillment';

describe('assignUnit — quarantine guard', () => {
  beforeEach(() => {
    fromMock.mockClear();
    unitStatus.value = 'ready';
  });

  it('throws when the target unit is quarantined', async () => {
    unitStatus.value = 'quarantine';
    await expect(assignUnit('queue-1', 'LL01-TEST-001', 'order-1')).rejects.toThrow(
      /quarantined and cannot be assigned/i,
    );
  });

  it('does not throw for a ready unit', async () => {
    unitStatus.value = 'ready';
    await expect(assignUnit('queue-1', 'LL01-TEST-001', 'order-1')).resolves.not.toThrow();
  });

  it('does not throw for a shipped (backfill) unit', async () => {
    unitStatus.value = 'shipped';
    await expect(assignUnit('queue-1', 'LL01-TEST-001', 'order-1')).resolves.not.toThrow();
  });
});
