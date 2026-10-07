// Tests for the Freightcom tracking-export parser (scripts/lib/freightcom-csv.mjs).
//
// The parser is the whole of the importer's risk: the script around it just
// POSTs. Column detection is by header name against a schema nobody has handed
// us, so these tests pin the behaviour on realistic header spellings and on the
// exact row shape the existing 38 dashboard rows already use.
import { describe, it, expect } from 'vitest';
// Typed via scripts/lib/freightcom-csv.d.mts — the module itself is plain ESM so
// the importer runs under bare `node` with no build step.
import {
  parseCsv, mapHeaders, toIsoDate, toAmount, toCurrency,
  mapStatus, deriveDirection, rowToShipment, parseExport,
} from '../../../scripts/lib/freightcom-csv.mjs';

describe('parseCsv', () => {
  it('handles quoted fields, embedded commas and escaped quotes', () => {
    expect(parseCsv('a,b\n"x,1","he said ""hi"""'))
      .toEqual([['a', 'b'], ['x,1', 'he said "hi"']]);
  });

  it('handles CRLF and a UTF-8 BOM without corrupting the first header', () => {
    expect(parseCsv('﻿Transaction No,Status\r\n123,Delivered\r\n'))
      .toEqual([['Transaction No', 'Status'], ['123', 'Delivered']]);
  });

  it('keeps newlines inside quoted fields', () => {
    expect(parseCsv('a\n"line1\nline2"')).toEqual([['a'], ['line1\nline2']]);
  });

  it('drops trailing blank lines', () => {
    expect(parseCsv('a,b\n1,2\n\n\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('mapHeaders', () => {
  it('matches the spellings the existing rows imply', () => {
    const h = mapHeaders(['Transaction No.', 'Ship From Name', 'Ship To Name', 'Status', 'Tracking Number']);
    expect(h.shipment_id).toBe(0);
    expect(h.ship_from).toBe(1);
    expect(h.ship_to).toBe(2);
    expect(h.status).toBe(3);
    expect(h.tracking).toBe(4);
  });

  it('is insensitive to case, punctuation and underscores', () => {
    const a = mapHeaders(['transaction_no', 'carrier_name']);
    const b = mapHeaders(['TRANSACTION NUMBER', 'Carrier']);
    expect(a.shipment_id).toBe(0);
    expect(b.shipment_id).toBe(0);
    expect(a.carrier).toBe(1);
    expect(b.carrier).toBe(1);
  });

  it('prefers an exact header match over a substring one', () => {
    // "Total Weight" must not claim cost when a plain "Total" is present.
    const h = mapHeaders(['Total Weight', 'Total']);
    expect(h.cost).toBe(1);
  });

  it('never assigns one column to two fields', () => {
    const h = mapHeaders(['Shipment ID', 'Tracking', 'Status']);
    const used = Object.values(h);
    expect(new Set(used).size).toBe(used.length);
  });

  it('reports nothing for columns that are simply absent', () => {
    expect(mapHeaders(['Transaction No']).cost).toBeUndefined();
  });
});

describe('toIsoDate', () => {
  it('reads the portal format seen in the existing rows', () => {
    expect(toIsoDate('Jun 23, 2026')).toBe('2026-06-23');
    expect(toIsoDate('June 3 2026')).toBe('2026-06-03');
  });

  it('passes ISO through and normalises padding', () => {
    expect(toIsoDate('2026-6-3')).toBe('2026-06-03');
    expect(toIsoDate('2026-06-23T14:00:00Z')).toBe('2026-06-23');
  });

  it('reads the day-first numeric form Freightcom renders', () => {
    expect(toIsoDate('23/06/2026')).toBe('2026-06-23');
  });

  it('returns null rather than guessing on junk', () => {
    expect(toIsoDate('')).toBeNull();
    expect(toIsoDate('n/a')).toBeNull();
    expect(toIsoDate(null)).toBeNull();
  });
});

describe('toAmount / toCurrency', () => {
  it('strips currency symbols and thousands separators', () => {
    expect(toAmount('$1,234.56')).toBe(1234.56);
    expect(toAmount('123.45 CAD')).toBe(123.45);
  });

  it('reads accounting-style negatives', () => {
    expect(toAmount('(12.00)')).toBe(-12);
  });

  it('distinguishes a zero charge from a missing one', () => {
    expect(toAmount('0')).toBe(0);
    expect(toAmount('')).toBeNull();
    expect(toAmount('—')).toBeNull();
  });

  it('finds the currency in the cell or in a dedicated column', () => {
    expect(toCurrency('123.45 CAD')).toBe('CAD');
    expect(toCurrency('US$80')).toBe('USD');
    expect(toCurrency('80', 'usd')).toBe('USD');
    expect(toCurrency('80')).toBeNull();
  });
});

describe('mapStatus', () => {
  it('maps the portal labels present in the existing rows', () => {
    expect(mapStatus('In Transit')).toEqual({ status: 'in_transit', freightcom_status: 'in-transit' });
    expect(mapStatus('Delivered')).toEqual({ status: 'delivered', freightcom_status: 'delivered' });
    expect(mapStatus('Ready for Shipping')).toEqual({ status: 'booked', freightcom_status: 'waiting-for-transit' });
  });

  it('files a delivery exception as an exception, not a delivery', () => {
    expect(mapStatus('Delivery Exception').status).toBe('exception');
  });

  it('keeps an unknown label visible instead of pretending to understand it', () => {
    const r = mapStatus('Held At Customs');
    expect(r.status).toBe('booked');
    expect(r.freightcom_status).toBe('held at customs');
  });

  it('only emits values the shipments.status check constraint allows', () => {
    const allowed = ['booked', 'in_transit', 'delivered', 'exception', 'missing', 'cancelled'];
    for (const s of ['In Transit', 'Delivered', 'Cancelled', 'Lost', 'Whatever', '', null]) {
      expect(allowed).toContain(mapStatus(s).status);
    }
  });
});

describe('deriveDirection', () => {
  it('is outbound when we are the shipper, a return when we are the recipient', () => {
    expect(deriveDirection('VCycene Inc.', 'Jane Doe')).toBe('outbound');
    expect(deriveDirection('Brent Neave', 'VCycene Inc.')).toBe('return');
  });

  it('defaults to outbound when neither party is recognisably us', () => {
    expect(deriveDirection('A Co', 'B Co')).toBe('outbound');
  });
});

describe('rowToShipment', () => {
  const headerRow = ['Transaction No', 'Carrier', 'Tracking Number', 'Status',
                     'Ship From Name', 'Ship To Name', 'Delivered On'];
  const headers = mapHeaders(headerRow);

  /** Asserts a row parsed, and narrows away the null the signature allows. */
  const parsed = (record: string[], h = headers) => {
    const row = rowToShipment(record, h);
    if (row === null) throw new Error('expected the row to parse, got null');
    return row;
  };

  it('reproduces the shape of the rows already on the dashboard', () => {
    const row = parsed(
      ['44802585', 'UPS', '1ZV56D26DK15166393', 'Delivered',
       'VCycene Inc.', 'Eupepsia Wellness Resort', 'Jun 23, 2026'],
    );
    expect(row.freightcom_shipment_id).toBe('44802585');
    expect(row.carrier).toBe('UPS');
    expect(row.status).toBe('delivered');
    expect(row.primary_tracking_number).toBe('1ZV56D26DK15166393');
    expect(row.raw_payload).toMatchObject({
      imported_from: 'freightcom_tracking_dashboard',
      direction: 'outbound',
      ship_to_name: 'Eupepsia Wellness Resort',
      ship_from_name: 'VCycene Inc.',
      dashboard_status: 'Delivered',
    });
    expect(row.delivered_at).toBe('2026-06-23T00:00:00Z');
  });

  it('classifies an inbound return by the party names', () => {
    const row = parsed(
      ['44748249', 'Canpar', 'D420', 'Ready for Shipping', 'Brent Neave', 'VCycene Inc.', ''],
    );
    expect(row.raw_payload.direction).toBe('return');
    expect(row.status).toBe('booked');
    expect(row.delivered_at).toBeUndefined();
  });

  it('omits cost entirely when the export has no cost column', () => {
    const row = parsed(['1', 'UPS', 'T', 'Delivered', 'VCycene', 'X', '']);
    expect(row.billed_cad).toBeUndefined();
    expect(row.billed_amount).toBeUndefined();
  });

  it('routes a CAD cost into billed_cad and keeps USD out of it', () => {
    const h = mapHeaders([...headerRow, 'Total']);
    const cad = parsed(['1', 'UPS', 'T', 'Delivered', 'VCycene', 'X', '', '$128.40'], h);
    expect(cad.billed_cad).toBe(128.4);
    expect(cad.billed_currency).toBe('CAD');

    const usd = parsed(['2', 'UPS', 'T', 'Delivered', 'VCycene', 'X', '', 'US$80.00'], h);
    expect(usd.billed_amount).toBe(80);
    expect(usd.billed_currency).toBe('USD');
    expect(usd.billed_cad).toBeUndefined();
  });

  it('rejects a row with no shipment id — it cannot be upserted', () => {
    expect(rowToShipment(['', 'UPS', 'T', 'Delivered', 'A', 'B', ''], headers)).toBeNull();
  });

  it('never emits a null carrier/service, which are NOT NULL columns', () => {
    const row = parsed(['9', '', '', 'Delivered', 'VCycene', 'X', '']);
    expect(row.carrier).toBe('');
    expect(row.service).toBe('');
  });
});

describe('parseExport', () => {
  const csv = [
    'Transaction No,Carrier,Tracking Number,Status,Ship From Name,Ship To Name,Delivered On',
    '45011657,UPS,1ZV56D266808807282,In Transit,VCycene Inc.,Esmeralda Burgess,',
    '44748249,Canpar,D420352470002333746001,Ready for Shipping,Brent Neave,VCycene Inc.,',
    ',,,,,,',                                              // blank line — not a record
    ',UPS,1ZTRACKONLY,Delivered,VCycene Inc.,Jane Doe,',    // real data, no id — skipped
  ].join('\n');

  it('parses every identifiable row and counts the unusable ones', () => {
    const r = parseExport(csv);
    expect(r.rows).toHaveLength(2);
    // The bare-comma line is empty and simply isn't a record; the id-less row
    // carries data we cannot key on, so it is reported rather than dropped quietly.
    expect(r.skipped).toBe(1);
    expect(r.missing).toEqual([]);
  });

  it('names the fields it could not find, so schema drift is visible', () => {
    const r = parseExport('Foo,Bar\n1,2');
    expect(r.missing).toContain('status');
    expect(r.missing).toContain('ship_to');
  });

  it('handles an empty file without throwing', () => {
    expect(parseExport('').rows).toEqual([]);
  });
});
