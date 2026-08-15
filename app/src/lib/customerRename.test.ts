import { describe, it, expect, vi, beforeEach } from 'vitest';

const { rpcMock, logActionMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  logActionMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('./supabase', () => ({
  supabase: { rpc: rpcMock },
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
}));

vi.mock('./activityLog', () => ({ logAction: logActionMock }));

import {
  previewCustomerRename, renameCustomer, renameRowCount,
  type CustomerRenameResult,
} from './customers';

const ok = (over: Partial<CustomerRenameResult> = {}) => ({
  data: {
    old_name: 'Dhruv Talwar',
    new_name: 'Dhruv Talwer',
    ambiguous: false,
    updated: { service_tickets: 8, orders: 4 },
    skipped: [],
    ...over,
  },
  error: null,
});

beforeEach(() => {
  rpcMock.mockReset();
  logActionMock.mockClear();
});

describe('previewCustomerRename', () => {
  it('asks for a dry run and writes no activity log', async () => {
    rpcMock.mockResolvedValue(ok());

    const result = await previewCustomerRename('c1', 'Dhruv', 'Talwer');

    expect(rpcMock).toHaveBeenCalledWith('rename_customer', {
      p_customer_id: 'c1',
      p_first_name: 'Dhruv',
      p_last_name: 'Talwer',
      p_dry_run: true,
    });
    expect(result.updated).toEqual({ service_tickets: 8, orders: 4 });
    expect(logActionMock).not.toHaveBeenCalled();
  });

  it('surfaces the skipped rows when the old name is ambiguous', async () => {
    rpcMock.mockResolvedValue(ok({
      ambiguous: true,
      skipped: [{ table: 'units', id: 'LILA-0142', label: null }],
    }));

    const result = await previewCustomerRename('c1', 'Dhruv', 'Talwer');

    expect(result.ambiguous).toBe(true);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].id).toBe('LILA-0142');
  });
});

describe('renameCustomer', () => {
  it('applies the rename and logs it with the row count', async () => {
    rpcMock.mockResolvedValue(ok());

    await renameCustomer('c1', 'Dhruv', 'Talwer');

    expect(rpcMock).toHaveBeenCalledWith('rename_customer', {
      p_customer_id: 'c1',
      p_first_name: 'Dhruv',
      p_last_name: 'Talwer',
      p_dry_run: false,
    });
    expect(logActionMock).toHaveBeenCalledWith(
      'customer_renamed',
      'c1',
      'Dhruv Talwar → Dhruv Talwer (12 records)',
      { entityType: 'customer', entityId: 'c1' },
    );
  });

  it('labels a previously nameless customer in the log', async () => {
    rpcMock.mockResolvedValue(ok({ old_name: '', updated: { units: 1 } }));

    await renameCustomer('c1', 'Dhruv', 'Talwer');

    expect(logActionMock).toHaveBeenCalledWith(
      'customer_renamed',
      'c1',
      '(no name) → Dhruv Talwer (1 records)',
      { entityType: 'customer', entityId: 'c1' },
    );
  });

  it('throws the database message so the UI can show it', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'A customer needs at least a first or last name.' },
    });

    await expect(renameCustomer('c1', '', '')).rejects.toThrow(
      'A customer needs at least a first or last name.',
    );
    expect(logActionMock).not.toHaveBeenCalled();
  });

  it('tolerates a response missing the optional collections', async () => {
    rpcMock.mockResolvedValue({
      data: { old_name: 'A B', new_name: 'A C', ambiguous: false },
      error: null,
    });

    const result = await renameCustomer('c1', 'A', 'C');

    expect(result.updated).toEqual({});
    expect(result.skipped).toEqual([]);
  });
});

describe('renameRowCount', () => {
  it('totals every table', () => {
    expect(renameRowCount({
      old_name: 'a', new_name: 'b', ambiguous: false,
      updated: { orders: 4, units: 3, fulfillment_log: 2 },
      skipped: [],
    })).toBe(9);
  });

  it('is zero when nothing changes', () => {
    expect(renameRowCount({
      old_name: 'a', new_name: 'b', ambiguous: false, updated: {}, skipped: [],
    })).toBe(0);
  });
});
