import { describe, it, expect } from 'vitest';
import { resolveCaseUnit, CASE_UNIT_VIA_LABEL, type CaseUnitRow } from './postShipment';

const unit = (over: Partial<CaseUnitRow> & { serial: string }): CaseUnitRow => ({
  status: 'shipped',
  customer_id: null,
  customer_name: null,
  customer_order_ref: null,
  ...over,
});

// A small stand-in fleet built from the shapes that actually occur in the
// units table: an FK-linked unit, a name-only unit, one reached by order ref,
// and the June-backfill case where the FK owner is not the name on the unit.
const FLEET: CaseUnitRow[] = [
  unit({ serial: 'LL01-00000000285', status: 'ready', customer_id: 'cust-lisa', customer_name: 'Lisa Clarke', customer_order_ref: '1198' }),
  unit({ serial: 'LL01-00000000274', status: 'shipped', customer_id: 'cust-phayvanh', customer_name: 'Marc Engelhardt' }),
  unit({ serial: 'LL01-00000000310', status: 'shipped', customer_id: 'cust-joseph', customer_name: 'Amanda Acker' }),
  unit({ serial: 'LL01-00000000312', status: 'ready', customer_id: 'cust-joseph', customer_name: 'Joseph THAVUNDAYIL' }),
  unit({ serial: 'LL01-00000000019', status: 'scrap', customer_id: 'cust-matthew', customer_name: 'Matthew Lypkie' }),
];

describe('resolveCaseUnit', () => {
  it('returns nothing when the case carries no identifying detail', () => {
    expect(resolveCaseUnit({ units: FLEET })).toEqual({
      serial: null, status: null, via: null, confirmed: false, others: [], conflictingName: null,
    });
  });

  it('trusts the serial already on the case above every other path', () => {
    const r = resolveCaseUnit({
      caseSerial: 'LL01-00000000019',
      // Both would otherwise resolve to a different machine.
      orderRef: '1198',
      customerName: 'Amanda Acker',
      units: FLEET,
    });
    expect(r.serial).toBe('LL01-00000000019');
    expect(r.via).toBe('case');
    expect(r.confirmed).toBe(true);
  });

  it('reports the current status of a case-recorded serial', () => {
    const r = resolveCaseUnit({ caseSerial: 'LL01-00000000285', units: FLEET });
    // The customer no longer holds it — it is back on the ready shelf.
    expect(r.status).toBe('ready');
  });

  it('accepts a case serial that has no unit row, with an unknown status', () => {
    const r = resolveCaseUnit({ caseSerial: 'LL01-00000099999', units: FLEET });
    expect(r).toMatchObject({ serial: 'LL01-00000099999', status: null, via: 'case', confirmed: true });
  });

  it('matches on order ref before falling back to a name', () => {
    const r = resolveCaseUnit({ orderRef: '1198', customerName: 'Amanda Acker', units: FLEET });
    expect(r.serial).toBe('LL01-00000000285');
    expect(r.via).toBe('order');
    expect(r.confirmed).toBe(false);
  });

  it('normalises the # that Shopify refs carry and returns do not', () => {
    const withHash = resolveCaseUnit({ orderRef: '#1198', units: FLEET });
    const without = resolveCaseUnit({ orderRef: '1198', units: FLEET });
    expect(withHash.serial).toBe('LL01-00000000285');
    expect(withHash).toEqual(without);
  });

  it('matches the name typed on the unit row, case-insensitively', () => {
    const r = resolveCaseUnit({ customerName: 'amanda acker', units: FLEET });
    expect(r.serial).toBe('LL01-00000000310');
    expect(r.via).toBe('unit_name');
  });

  it('prefers the name on the unit over the customer FK, so a mis-linked unit does not win', () => {
    // The June backfill put LL01-00000000310 (Amanda's machine) on Joseph's
    // customer record. Amanda's own case must still resolve to her machine.
    const r = resolveCaseUnit({
      customerName: 'Amanda Acker',
      customerId: 'cust-joseph',
      units: FLEET,
    });
    expect(r.serial).toBe('LL01-00000000310');
    expect(r.via).toBe('unit_name');
  });

  it('falls back to the customer record when nothing else matches', () => {
    // Phayvanh's unit carries someone else's name, so only the FK finds it.
    const r = resolveCaseUnit({
      customerName: 'Phayvanh Nanthavongdouangsy',
      customerId: 'cust-phayvanh',
      units: FLEET,
    });
    expect(r.serial).toBe('LL01-00000000274');
    expect(r.via).toBe('customer');
    expect(r.confirmed).toBe(false);
  });

  it('reports the other candidates when a path ties', () => {
    const r = resolveCaseUnit({ customerId: 'cust-joseph', units: FLEET });
    expect(r.serial).toBe('LL01-00000000310');
    expect(r.others).toEqual([{ serial: 'LL01-00000000312', status: 'ready' }]);
  });

  it('leaves others empty when a path matches exactly once', () => {
    expect(resolveCaseUnit({ customerId: 'cust-matthew', units: FLEET }).others).toEqual([]);
  });

  it('ignores blank and whitespace-only case values', () => {
    const r = resolveCaseUnit({
      caseSerial: '   ', orderRef: '  ', customerName: '', customerId: null, units: FLEET,
    });
    expect(r.serial).toBeNull();
  });

  it('never resolves against an empty fleet', () => {
    const r = resolveCaseUnit({ orderRef: '1198', customerName: 'Lisa Clarke', units: [] });
    expect(r.serial).toBeNull();
    expect(r.via).toBeNull();
  });

  it('names the person the unit is recorded to when the customer path disagrees', () => {
    // LL01-00000000274 is FK-linked to Phayvanh but carries Marc Engelhardt's
    // name — one of the nine units the June backfill mis-linked. The card must
    // not present that as a clean answer.
    const r = resolveCaseUnit({
      customerName: 'Phayvanh Nanthavongdouangsy',
      customerId: 'cust-phayvanh',
      units: FLEET,
    });
    expect(r.via).toBe('customer');
    expect(r.conflictingName).toBe('Marc Engelhardt');
  });

  it('reports no disagreement when the unit carries the case customer name', () => {
    const r = resolveCaseUnit({ orderRef: '1198', customerName: 'Lisa Clarke', units: FLEET });
    expect(r.via).toBe('order');
    expect(r.conflictingName).toBeNull();
  });

  it('reports no disagreement for a name-matched unit, since the names are equal', () => {
    const r = resolveCaseUnit({ customerName: 'Amanda Acker', units: FLEET });
    expect(r.conflictingName).toBeNull();
  });

  it('stays quiet about a disagreement when the case has no name to compare', () => {
    const r = resolveCaseUnit({ customerId: 'cust-phayvanh', units: FLEET });
    expect(r.serial).toBe('LL01-00000000274');
    expect(r.conflictingName).toBeNull();
  });

  it('never flags a disagreement on a serial recorded on the case', () => {
    const r = resolveCaseUnit({
      caseSerial: 'LL01-00000000310', customerName: 'Amanda Acker', units: FLEET,
    });
    expect(r.conflictingName).toBeNull();
  });

  it('labels every path it can return', () => {
    for (const via of ['case', 'order', 'unit_name', 'customer'] as const) {
      expect(CASE_UNIT_VIA_LABEL[via]).toBeTruthy();
    }
  });
});
