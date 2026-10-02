import { describe, it, expect } from 'vitest';
import {
  addressLines,
  addressOneLine,
  attachmentFilenames,
  buildEzTransBooking,
  ezTransVariables,
  masterCartonFromSkid,
  needsPesticideWorksheet,
  pesticideWorksheetSummary,
  EZTRANS_EMAIL,
  PACKING_LIST_SKU,
  type EzTransShipTo,
} from './eztrans';

const ORDER: EzTransShipTo & { order_ref: string } = {
  order_ref: '#1184',
  customer_name: 'Juanita M Wells',
  customer_email: 'juanita@example.com',
  customer_phone: '+17095551234',
  address_line: '14 Grenfell Drive',
  address_line2: 'Unit 3',
  city: 'Wabush',
  region_state: 'NL',
  postal_code: 'A0R 1B0',
  country: 'CA',
};

describe('masterCartonFromSkid', () => {
  it('reduces a shelf pallet key to its carton number', () => {
    expect(masterCartonFromSkid('EZ-P01')).toBe('1');
    expect(masterCartonFromSkid('EZ-P14')).toBe('14');
  });

  it('accepts a bare units.pallet value', () => {
    expect(masterCartonFromSkid('P01')).toBe('1');
    expect(masterCartonFromSkid('P09')).toBe('9');
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(masterCartonFromSkid(' ez-p07 ')).toBe('7');
  });

  it('passes a non-pallet group through rather than inventing a number', () => {
    // EZ-S2 / EZ-S3 are the two un-manifested shipments — they are not pallet 2
    // and pallet 3, and a packing list that said so would send the 3PL to the
    // wrong stack.
    expect(masterCartonFromSkid('EZ-S2')).toBe('EZ-S2');
    expect(masterCartonFromSkid('EZ-S3')).toBe('EZ-S3');
  });

  it('has nothing to say about a unit with no pallet on record', () => {
    expect(masterCartonFromSkid(null)).toBeNull();
    expect(masterCartonFromSkid(undefined)).toBeNull();
    expect(masterCartonFromSkid('   ')).toBeNull();
  });
});

describe('addressLines', () => {
  it('lays the address out as a block', () => {
    expect(addressLines(ORDER)).toEqual([
      '14 Grenfell Drive',
      'Unit 3',
      'Wabush, NL, A0R 1B0',
      'CA',
    ]);
  });

  it('skips the parts an order does not have', () => {
    expect(addressLines({ ...ORDER, address_line2: null, postal_code: null, region_state: null }))
      .toEqual(['14 Grenfell Drive', 'Wabush', 'CA']);
  });

  it('one-lines the same parts', () => {
    expect(addressOneLine(ORDER)).toBe('14 Grenfell Drive, Unit 3, Wabush, NL, A0R 1B0, CA');
  });
});

describe('buildEzTransBooking', () => {
  const booking = buildEzTransBooking({
    order: ORDER,
    units: [{ serial: 'LL01-P100X-00412', masterCarton: '1' }],
    carrier: 'Purolator',
    tracking: 'PUR123456789',
  });

  it('says an order has been placed and names the customer in full', () => {
    expect(booking.body).toContain('confirming that an order has been placed');
    expect(booking.body).toContain('Juanita M Wells');
    expect(booking.body).toContain('14 Grenfell Drive');
    expect(booking.body).toContain('Wabush, NL, A0R 1B0');
    expect(booking.body).toContain('juanita@example.com');
    expect(booking.body).toContain('+17095551234');
  });

  it('carries the fixed product identity and the assigned serial', () => {
    expect(booking.body).toContain('Product Name: LILA Kitchen Composter');
    expect(booking.body).toContain(`SKU: ${PACKING_LIST_SKU}`);
    expect(booking.body).toContain('Serial No: LL01-P100X-00412');
    expect(booking.body).toContain('Batch/Lot Number: P100X');
    expect(booking.body).toContain('Master Carton: 1');
    expect(booking.body).toContain('Quantity: 1');
  });

  it('carries the label details and says the label is attached', () => {
    expect(booking.body).toContain('SHIPPING LABEL (attached)');
    expect(booking.body).toContain('Carrier: Purolator');
    expect(booking.body).toContain('Tracking Number: PUR123456789');
    expect(booking.body).toContain('print the attached PDF and affix the shipping label');
    expect(booking.body).toContain('attached together as one PDF');
    const list = booking.packingList.join('\n');
    expect(list).toContain('Carrier: Purolator');
    expect(list).toContain('Tracking No: PUR123456789');
  });

  it('names the order in the subject so a reply is traceable', () => {
    expect(booking.subject).toContain('#1184');
    expect(booking.subject).toContain('LL01-P100X-00412');
  });

  it('repeats every customer field on the packing list itself', () => {
    const list = booking.packingList.join('\n');
    expect(list).toContain('PACKING LIST');
    expect(list).toContain('Juanita M Wells');
    expect(list).toContain('14 Grenfell Drive');
    expect(list).toContain('Unit 3');
    expect(list).toContain('Wabush, NL, A0R 1B0');
    expect(list).toContain('Email: juanita@example.com');
    expect(list).toContain('Phone: +17095551234');
    expect(list).toContain('Product Name: LILA Kitchen Composter');
    expect(list).toContain('SKU: LILA-P100X');
    expect(list).toContain('Serial No: LL01-P100X-00412');
    expect(list).toContain('Batch/Lot Number: P100X');
    expect(list).toContain('Master Carton: 1');
    expect(list).toContain('Quantity: 1');
  });

  it('marks a missing field rather than printing "null" on a picking document', () => {
    const blank = buildEzTransBooking({
      order: { ...ORDER, customer_email: null, customer_phone: null },
      units: [{ serial: 'LL01-P100X-00412', masterCarton: null }],
      carrier: null,
      tracking: null,
    });
    expect(blank.body).not.toContain('null');
    expect(blank.packingList.join('\n')).not.toContain('null');
    expect(blank.body).toContain('Master Carton: —');
  });

  it('is addressed to the 3PL, not the customer', () => {
    expect(EZTRANS_EMAIL).toBe('cs@goorooship.ca');
    expect(booking.body).not.toContain('Happy Composting');
  });
});


describe('what goes out with the booking', () => {
  it('merges the label and the packing list into one attachment', () => {
    expect(attachmentFilenames('#1184', 'Purolator'))
      .toEqual(['shipping-label-and-packing-list-1184.pdf']);
  });

  it('adds the pesticide worksheet on a UPS booking', () => {
    expect(attachmentFilenames('#1184', 'UPS')).toEqual([
      'shipping-label-and-packing-list-1184.pdf',
      'pesticide-worksheet-1184.pdf',
    ]);
  });

  it('only UPS gets one — nobody else brokers their own entries', () => {
    expect(needsPesticideWorksheet('UPS')).toBe(true);
    expect(needsPesticideWorksheet(' ups ')).toBe(true);
    for (const carrier of ['FedEx', 'Purolator', 'Canada Post', 'Canpar', 'GLS', 'Day & Ross', '', null]) {
      expect(needsPesticideWorksheet(carrier)).toBe(false);
    }
  });

  it('tells the 3PL to look for the second PDF only when there is one', () => {
    const base = {
      order: ORDER,
      units: [{ serial: 'LL01-P100X-00412', masterCarton: '1' }],
      tracking: '1Z2985EADK93221574',
    };
    const ups = buildEzTransBooking({ ...base, carrier: 'UPS' });
    expect(ups.body).toContain('attached together as one PDF');
    expect(ups.body).toContain('pesticide worksheet for this entry is attached as a second PDF');

    const other = buildEzTransBooking({ ...base, carrier: 'Purolator' });
    expect(other.body).toContain('attached together as one PDF');
    expect(other.body).not.toContain('pesticide worksheet');
  });

  it('shows the operator the worksheet fields that came off this shipment', () => {
    const summary = pesticideWorksheetSummary({
      orderRef: '#1252', serials: ['LL01-00000000369'], tracking: '1Z2985EADK93221574',
    });
    const byLabel = Object.fromEntries(summary.map(f => [f.label, f.value]));
    expect(byLabel['Shipment number']).toBe('1Z2985EADK93221574');
    expect(byLabel['Tariff number']).toBe('8509.80.5095');
    expect(byLabel['Description of goods']).toContain('LL01-00000000369');
    expect(byLabel['Description of goods']).toContain('Order ref #1252');
    expect(byLabel['Signed by']).toContain('Huayi Gao');
  });

  it('says a missing tracking number rather than filing a blank one', () => {
    const summary = pesticideWorksheetSummary({
      orderRef: '#1252', serials: ['LL01-00000000369'], tracking: null,
    });
    expect(summary.find(f => f.label === 'Shipment number')?.value).toBe('—');
  });
});

// The failure this was written for: M-0001 is three LILA Pros, and the booking
// EZ Trans works from named exactly one of them. The other two were on the
// order, in the queue and reserved in Stock, and absent from the only document
// the 3PL reads — so one box would have shipped against a three-unit order.
describe('an order for more than one machine', () => {
  const THREE = {
    order: ORDER,
    units: [
      { serial: 'LL01-00000000397', masterCarton: '10' },
      { serial: 'LL01-00000000398', masterCarton: '10' },
      { serial: 'LL01-00000000400', masterCarton: '11' },
    ],
    carrier: 'Day & Ross',
    tracking: 'A12453936',
  };

  it('counts the machines rather than reporting one', () => {
    expect(ezTransVariables(THREE).quantity).toBe('3');
  });

  it('names every serial, not just the first picked', () => {
    const vars = ezTransVariables(THREE);
    expect(vars.serial).toBe('LL01-00000000397, LL01-00000000398, LL01-00000000400');
  });

  it('pairs each serial with the carton it is picked from', () => {
    expect(ezTransVariables(THREE).units_block).toBe(
      'Serial No: LL01-00000000397 — Master Carton: 10\n' +
      'Serial No: LL01-00000000398 — Master Carton: 10\n' +
      'Serial No: LL01-00000000400 — Master Carton: 11',
    );
  });

  // Three machines off EZ-P10 is one carton number. Printing it three times
  // reads as three cartons to the person picking.
  it('de-duplicates the carton list', () => {
    expect(ezTransVariables({
      ...THREE,
      units: [
        { serial: 'LL01-00000000397', masterCarton: '10' },
        { serial: 'LL01-00000000398', masterCarton: '10' },
      ],
    }).master_carton).toBe('10');
  });

  it('puts all three on the packing list and in the email body', () => {
    const { body, packingList } = buildEzTransBooking(THREE);
    for (const serial of ['LL01-00000000397', 'LL01-00000000398', 'LL01-00000000400']) {
      expect(body).toContain(serial);
      expect(packingList.join('\n')).toContain(serial);
    }
    expect(packingList.join('\n')).toContain('Quantity: 3');
  });

  // The subject is what a picker sees in their inbox before opening anything.
  it('says how many machines in the subject line', () => {
    expect(buildEzTransBooking(THREE).subject).toContain('3 × LILA-P100X');
  });

  // One customs entry, one worksheet. Declaring one of three machines is a
  // false declaration, not merely an incomplete one.
  it('declares every machine on the UPS worksheet', () => {
    const summary = pesticideWorksheetSummary({
      orderRef: 'M-0001',
      serials: THREE.units.map(u => u.serial),
      tracking: '1Z2985EADK93221574',
    });
    const goods = summary.find(f => f.label === 'Description of goods')!.value;
    for (const u of THREE.units) expect(goods).toContain(u.serial);
    expect(goods).toContain('Qty 3');
  });

  it('leaves no placeholder behind on a multi-unit booking', () => {
    const { body, subject, packingList } = buildEzTransBooking(THREE);
    expect(body).not.toMatch(/\{\{/);
    expect(subject).not.toMatch(/\{\{/);
    expect(packingList.join('\n')).not.toMatch(/\{\{/);
  });
});
