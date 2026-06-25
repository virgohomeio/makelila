import { describe, it, expect } from 'vitest';
import {
  FREIGHTCOM_STATUSES,
  displayFreightcomStatus,
  isKnownFreightcomStatus,
  isMissingColumnError,
} from './shipping';

describe('displayFreightcomStatus', () => {
  it('uses the stored raw freightcom_status when present', () => {
    const row = { status: 'booked', freightcom_status: 'in-transit' } as any;
    expect(displayFreightcomStatus(row)).toBe('in-transit');
  });

  it('reverse-maps internal booked -> waiting-for-transit when not yet synced', () => {
    const row = { status: 'booked', freightcom_status: null } as any;
    expect(displayFreightcomStatus(row)).toBe('waiting-for-transit');
  });

  it('reverse-maps internal in_transit -> in-transit when not yet synced', () => {
    const row = { status: 'in_transit', freightcom_status: null } as any;
    expect(displayFreightcomStatus(row)).toBe('in-transit');
  });

  it('passes through 1:1 internal statuses when not yet synced', () => {
    const row = { status: 'delivered', freightcom_status: null } as any;
    expect(displayFreightcomStatus(row)).toBe('delivered');
  });

  it('returns an unknown raw value verbatim', () => {
    const row = { status: 'booked', freightcom_status: 'out-for-delivery' } as any;
    expect(displayFreightcomStatus(row)).toBe('out-for-delivery');
  });
});

describe('isKnownFreightcomStatus', () => {
  it('is true for a known status', () => {
    expect(isKnownFreightcomStatus('in-transit')).toBe(true);
  });
  it('is false for an unexpected status (grouped under "other")', () => {
    expect(isKnownFreightcomStatus('out-for-delivery')).toBe(false);
  });
  it('covers exactly the 6 known statuses', () => {
    expect([...FREIGHTCOM_STATUSES]).toEqual([
      'waiting-for-transit', 'in-transit', 'delivered',
      'exception', 'missing', 'cancelled',
    ]);
  });
});

describe('isMissingColumnError', () => {
  it('detects Postgres 42703 by code', () => {
    expect(isMissingColumnError({ code: '42703', message: 'whatever' })).toBe(true);
  });
  it('detects "column ... does not exist" by message', () => {
    expect(isMissingColumnError({ message: 'column shipments.freightcom_status does not exist' })).toBe(true);
  });
  it('is false for unrelated errors and null', () => {
    expect(isMissingColumnError({ code: '500', message: 'boom' })).toBe(false);
    expect(isMissingColumnError(null)).toBe(false);
  });
});
