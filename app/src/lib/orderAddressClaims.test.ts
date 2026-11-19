import { describe, it, expect } from 'vitest';
import { orderPostalCode, areaTypeProvenance } from './orders';

describe('orderPostalCode', () => {
  // The Order Review card read `address_customer_postal` alone, which the
  // verify-address step populates and nothing else does. 219 of 317 orders have
  // never been verified, so the card told the operator the postal code was "Not
  // on file" while `orders.postal_code` held it all along.
  it('prefers the postal code on the order', () => {
    expect(orderPostalCode({
      postal_code: 'K6H 0H2', address_customer_postal: null, address_google_postal: null,
    })).toBe('K6H 0H2');
  });

  it('falls back to what the customer typed, then to Google', () => {
    expect(orderPostalCode({
      postal_code: null, address_customer_postal: 'N3Y4K3', address_google_postal: 'N3Y 4K3',
    })).toBe('N3Y4K3');
    expect(orderPostalCode({
      postal_code: null, address_customer_postal: null, address_google_postal: '98382-4095',
    })).toBe('98382-4095');
  });

  it('is null when the order has no postal code at all', () => {
    expect(orderPostalCode({
      postal_code: null, address_customer_postal: null, address_google_postal: null,
    })).toBeNull();
  });
});

describe('areaTypeProvenance', () => {
  it('names an operator override', () => {
    expect(areaTypeProvenance({
      area_type: 'rural', area_type_source: 'manual',
      address_verified_at: '2026-09-29T00:00:00Z', address_area_type_error: null,
    })).toBe('set by an operator');
  });

  it('dates a verification', () => {
    expect(areaTypeProvenance({
      area_type: 'urban', area_type_source: 'verified',
      address_verified_at: '2026-09-29T12:00:00Z', address_area_type_error: null,
    })).toMatch(/^classified by address verification \d/);
  });

  it('names the postal-code rule when nothing verified it', () => {
    expect(areaTypeProvenance({
      area_type: 'rural', area_type_source: 'auto',
      address_verified_at: null, address_area_type_error: null,
    })).toBe('from the postal-code rule');
  });

  // A blank area type that failed to compute must not read the same as one
  // nobody has looked at — that is how a field ends up looking classified when
  // nothing classified it.
  it('surfaces the reason a classification failed', () => {
    expect(areaTypeProvenance({
      area_type: null, area_type_source: 'auto',
      address_verified_at: null, address_area_type_error: 'model provider returned 429',
    })).toBe('could not be classified — model provider returned 429');
  });

  it('says nobody has looked when nobody has', () => {
    expect(areaTypeProvenance({
      area_type: null, area_type_source: 'auto',
      address_verified_at: null, address_area_type_error: null,
    })).toBe('not classified yet — run Verify address on the order');
  });
});
