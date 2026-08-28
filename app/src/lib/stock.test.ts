import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBatch, isStockManager } from './stock';

const { mockInsert, mockLimit, mockGetUser, mockLogAction } = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockLimit: vi.fn(),
  mockGetUser: vi.fn(),
  mockLogAction: vi.fn(),
}));

vi.mock('./supabase', () => ({
  supabase: {
    auth: { getUser: mockGetUser },
    from: (table: string) => ({
      insert: (row: unknown) => mockInsert(table, row),
      select: () => ({ eq: () => ({ limit: mockLimit }) }),
    }),
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
  },
}));

vi.mock('./activityLog', () => ({
  logAction: mockLogAction,
  useActivityForEntity: () => ({ events: [], loading: false }),
}));

vi.mock('./supabaseTelemetry', () => ({
  supabaseTelemetry: null,
  isTelemetryConfigured: () => false,
}));

const validInput = { id: 'P200', unit_count: 200, manufacturer: 'Dongguan LC Technology' };

beforeEach(() => {
  vi.clearAllMocks();
  mockInsert.mockResolvedValue({ error: null });
  mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
});

describe('createBatch', () => {
  it('inserts the batch and writes an activity-log entry', async () => {
    await createBatch(validInput);
    expect(mockInsert).toHaveBeenCalledWith('batches', expect.objectContaining({
      id: 'P200', unit_count: 200, manufacturer: 'Dongguan LC Technology',
    }));
    expect(mockLogAction).toHaveBeenCalledWith(
      'batch_created', 'P200', expect.stringContaining('200 units'),
    );
  });

  it('trims the id and nulls blank optional fields', async () => {
    await createBatch({ ...validInput, id: '  P200  ', version: '   ', notes: '' });
    expect(mockInsert).toHaveBeenCalledWith('batches', expect.objectContaining({
      id: 'P200', version: null, notes: null,
    }));
  });

  it('rejects a blank id before touching the database', async () => {
    await expect(createBatch({ ...validInput, id: '   ' })).rejects.toThrow('Batch ID is required');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects a non-positive unit count', async () => {
    await expect(createBatch({ ...validInput, unit_count: 0 }))
      .rejects.toThrow('Unit count must be a positive whole number');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('turns a PK violation into a readable duplicate message', async () => {
    mockInsert.mockResolvedValue({ error: { code: '23505', message: 'duplicate key value' } });
    await expect(createBatch(validInput)).rejects.toThrow('Batch "P200" already exists');
  });

  it('does not log when the insert fails', async () => {
    mockInsert.mockResolvedValue({ error: { code: '42501', message: 'permission denied' } });
    await expect(createBatch(validInput)).rejects.toThrow('permission denied');
    expect(mockLogAction).not.toHaveBeenCalled();
  });
});

describe('isStockManager', () => {
  it('is true when the allowlist returns a row', async () => {
    mockLimit.mockResolvedValue({ data: [{ profile_id: 'u1' }], error: null });
    expect(await isStockManager()).toBe(true);
  });

  it('is false when the allowlist is empty', async () => {
    mockLimit.mockResolvedValue({ data: [], error: null });
    expect(await isStockManager()).toBe(false);
  });

  it('is false — not thrown — when the query errors', async () => {
    mockLimit.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect(await isStockManager()).toBe(false);
  });

  it('is false when signed out, without querying', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect(await isStockManager()).toBe(false);
    expect(mockLimit).not.toHaveBeenCalled();
  });
});
