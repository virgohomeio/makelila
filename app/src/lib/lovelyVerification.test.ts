import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, rpcMock, approveMock, logActionMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  approveMock: vi.fn(),
  logActionMock: vi.fn(),
}));

vi.mock('./supabase', () => ({ supabase: { from: fromMock, rpc: rpcMock } }));
vi.mock('./lovely', () => ({ approveLovelyUser: approveMock }));
vi.mock('./activityLog', () => ({ logAction: logActionMock }));

import {
  diagnoseUser, fetchVerificationContext, addSerialAndVerify,
  type CustomerSerialRecord,
} from './lovelyVerification';
import type { LovelyUser } from './lovely';

const cust = (over: Partial<CustomerSerialRecord>): CustomerSerialRecord => ({
  id: 'c1', email: 'jane@x.com', full_name: 'Jane Doe', serials: null, ...over,
});

const user = (over: Partial<LovelyUser>): LovelyUser => ({
  id: 'u1', email: 'jane@x.com', first_name: 'Jane', last_name: 'Doe',
  serial_number: 'LL01-00000000307', onboarding_step: 'pairing',
  is_verified: false, verified_at: null, mailing_list: null,
  last_login_at: null, login_count: null, created_at: null, updated_at: null,
  ...over,
});

// PostgREST-ish chain: .select().or(), .select().overlaps(), and
// .select().ilike() all resolve. The or/overlaps/ilike mocks are exposed
// directly so tests can assert exactly what filter string/args were passed.
function tableMock(rows: unknown[], error: unknown = null) {
  const result = Promise.resolve({ data: rows, error });
  const orMock = vi.fn().mockReturnValue(result);
  const overlapsMock = vi.fn().mockReturnValue(result);
  const ilikeMock = vi.fn().mockReturnValue(result);
  return {
    select: vi.fn().mockReturnValue({ or: orMock, overlaps: overlapsMock, ilike: ilikeMock }),
    orMock,
    overlapsMock,
    ilikeMock,
  };
}

beforeEach(() => {
  fromMock.mockReset(); rpcMock.mockReset();
  approveMock.mockReset(); logActionMock.mockReset();
});

describe('diagnoseUser', () => {
  it('no_serial when the user has no paired serial', () => {
    const d = diagnoseUser({ email: 'jane@x.com', serial_number: null }, [cust({})], []);
    expect(d.verdict).toBe('no_serial');
  });

  it('no_serial when the serial is whitespace only', () => {
    const d = diagnoseUser({ email: 'jane@x.com', serial_number: '   ' }, [cust({})], []);
    expect(d.verdict).toBe('no_serial');
  });

  it('no_customer when no customer shares the email', () => {
    const d = diagnoseUser(
      { email: 'nobody@x.com', serial_number: 'LL01-00000000307' },
      [cust({ email: 'jane@x.com' })], [],
    );
    expect(d.verdict).toBe('no_customer');
    expect(d.matchedCustomers).toHaveLength(0);
  });

  it('will_auto_verify when email + serial match the same customer (case/space-insensitive both sides)', () => {
    const d = diagnoseUser(
      { email: '  Jane@X.com ', serial_number: 'll01-00000000307' },
      [cust({ serials: [' LL01-00000000307 '] })], [],
    );
    expect(d.verdict).toBe('will_auto_verify');
    expect(d.matchedCustomers).toHaveLength(1);
  });

  it('serial_mismatch when the email matches but no array contains the serial', () => {
    const d = diagnoseUser(
      { email: 'jane@x.com', serial_number: 'LL01-00000000999' },
      [cust({ serials: ['LL01-00000000307'] })], [],
    );
    expect(d.verdict).toBe('serial_mismatch');
    expect(d.matchedCustomers[0].id).toBe('c1');
  });

  it('checks every duplicate customer row sharing the email', () => {
    const d = diagnoseUser(
      { email: 'jane@x.com', serial_number: 'LL01-00000000307' },
      [
        cust({ id: 'c1', serials: ['LL01-00000000111'] }),
        cust({ id: 'c2', serials: ['LL01-00000000307'] }),
      ], [],
    );
    expect(d.verdict).toBe('will_auto_verify');
    expect(d.matchedCustomers).toHaveLength(2);
  });

  it('flags serialOwner when a DIFFERENT customer holds the serial', () => {
    const owner = cust({ id: 'c9', email: 'other@x.com', serials: ['LL01-00000000307'] });
    const d = diagnoseUser(
      { email: 'jane@x.com', serial_number: 'LL01-00000000307' },
      [cust({ serials: null })],
      [owner],
    );
    expect(d.verdict).toBe('serial_mismatch');
    expect(d.serialOwner?.id).toBe('c9');
  });

  it('does NOT set serialOwner when the holder is the matched customer itself', () => {
    const same = cust({ serials: ['LL01-00000000307'] });
    const d = diagnoseUser(
      { email: 'jane@x.com', serial_number: 'LL01-00000000307' },
      [same], [same],
    );
    expect(d.verdict).toBe('will_auto_verify');
    expect(d.serialOwner).toBeNull();
  });

  it('ignores non-string junk inside serials arrays', () => {
    const d = diagnoseUser(
      { email: 'jane@x.com', serial_number: 'LL01-00000000307' },
      [cust({ serials: [null as unknown as string, 'LL01-00000000307'] })], [],
    );
    expect(d.verdict).toBe('will_auto_verify');
  });
});

describe('fetchVerificationContext', () => {
  it('queries customers by email (ilike or-chain) and by serial overlap', async () => {
    const emailTable = tableMock([{ id: 'c1', email: 'jane@x.com', full_name: 'Jane', serials: [] }]);
    const serialTable = tableMock([{ id: 'c9', email: 'o@x.com', full_name: 'O', serials: ['LL01-00000000307'] }]);
    fromMock.mockReturnValueOnce(emailTable).mockReturnValueOnce(serialTable);

    const ctx = await fetchVerificationContext([user({})]);

    expect(fromMock).toHaveBeenNthCalledWith(1, 'customers');
    expect(fromMock).toHaveBeenNthCalledWith(2, 'customers');
    expect(emailTable.select).toHaveBeenCalledWith('id, email, full_name, serials');
    expect(emailTable.orMock).toHaveBeenCalledWith('email.ilike.jane@x.com');
    expect(serialTable.overlapsMock).toHaveBeenCalledWith('serials', ['LL01-00000000307']);
    expect(ctx.customersByEmail).toHaveLength(1);
    expect(ctx.serialOwners).toHaveLength(1);
  });

  it('escapes ILIKE wildcards in the or-chain filter', async () => {
    const emailTable = tableMock([]);
    const serialTable = tableMock([]);
    fromMock.mockReturnValueOnce(emailTable).mockReturnValueOnce(serialTable);

    await fetchVerificationContext([user({ email: 'j_ane@x.com' })]);

    expect(emailTable.orMock).toHaveBeenCalledWith('email.ilike.j\\_ane@x.com');
  });

  it('queries a comma-containing email individually while a normal email uses the or-chain', async () => {
    const emailTable = tableMock([{ id: 'c1', email: 'jane@x.com', full_name: 'Jane', serials: [] }]);
    const ilikeTable = tableMock([{ id: 'c2', email: '"a,b"@x.com', full_name: 'A B', serials: [] }]);
    const serialTable = tableMock([]);
    fromMock
      .mockReturnValueOnce(emailTable)
      .mockReturnValueOnce(ilikeTable)
      .mockReturnValueOnce(serialTable);

    const ctx = await fetchVerificationContext([
      user({ id: 'u1', email: 'jane@x.com', serial_number: 'LL01-00000000307' }),
      user({ id: 'u2', email: '"a,b"@x.com', serial_number: 'LL01-00000000401' }),
    ]);

    expect(emailTable.orMock).toHaveBeenCalledWith('email.ilike.jane@x.com');
    expect(ilikeTable.ilikeMock).toHaveBeenCalledWith('email', '"a,b"@x.com');
    expect(ctx.customersByEmail).toHaveLength(2);
    expect(ctx.customersByEmail.map(c => c.email)).toEqual(
      expect.arrayContaining(['jane@x.com', '"a,b"@x.com']),
    );
  });

  it('skips the serial query when no pending user has a serial', async () => {
    const emailTable = tableMock([]);
    fromMock.mockReturnValueOnce(emailTable);

    const ctx = await fetchVerificationContext([user({ serial_number: null })]);

    expect(fromMock).toHaveBeenCalledTimes(1);
    expect(ctx.serialOwners).toEqual([]);
  });

  it('returns empty context for an empty user list without querying', async () => {
    const ctx = await fetchVerificationContext([]);
    expect(fromMock).not.toHaveBeenCalled();
    expect(ctx).toEqual({ customersByEmail: [], serialOwners: [] });
  });

  it('throws when the email query errors', async () => {
    fromMock.mockReturnValueOnce(tableMock([], { message: 'boom' }));
    await expect(fetchVerificationContext([user({})])).rejects.toThrow('boom');
  });
});

describe('addSerialAndVerify', () => {
  it('runs RPC, then approve, then logs', async () => {
    rpcMock.mockResolvedValue({ data: ['LL01-00000000307'], error: null });
    approveMock.mockResolvedValue(undefined);

    await addSerialAndVerify(user({}), 'c1');

    expect(rpcMock).toHaveBeenCalledWith('add_customer_serial', {
      p_customer_id: 'c1',
      p_serial: 'LL01-00000000307',
      p_reason: 'Verification tab fix for Lovely user jane@x.com',
    });
    expect(approveMock).toHaveBeenCalledWith('u1');
    expect(logActionMock).toHaveBeenCalled();
  });

  it('throws and skips approve when the RPC fails', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'nope' } });
    await expect(addSerialAndVerify(user({}), 'c1')).rejects.toThrow('nope');
    expect(approveMock).not.toHaveBeenCalled();
  });

  it('surfaces an approve failure after a successful RPC (retry-safe)', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    approveMock.mockRejectedValue(new Error('verify down'));
    await expect(addSerialAndVerify(user({}), 'c1')).rejects.toThrow('verify down');
  });

  it('rejects a user with no serial', async () => {
    await expect(addSerialAndVerify(user({ serial_number: '  ' }), 'c1'))
      .rejects.toThrow('no paired serial');
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
