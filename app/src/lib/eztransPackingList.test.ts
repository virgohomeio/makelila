// The packing list used to be built in code and deliberately un-editable. It
// is now a template like the email wording, so an operator can correct a
// carton note or add a handling instruction for one shipment without a deploy.
//
// What is NOT given up in the process: the variables still resolve from the
// order and the queue row on the server, and the email body and the packing
// list are separate overrides — editing the wording still cannot reach the
// document EZ Trans picks from.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EZTRANS_PACKING_LIST,
  EZTRANS_PACKING_LIST_KEY,
  EZTRANS_FROM,
  EZTRANS_CC,
  buildEzTransBooking,
  ezTransVariables,
  type EzTransShipTo,
} from './eztrans';
import {
  DEFAULT_EZTRANS_PACKING_LIST as SHARED_PACKING_LIST,
  EZTRANS_PACKING_LIST_VARIABLES,
  EZTRANS_PACKING_LIST_KEY as SHARED_PACKING_KEY,
  EZTRANS_FROM_DEFAULT,
  EZTRANS_CC_DEFAULT,
  packingListLines,
  renderEzTransTemplate,
} from '../../../supabase/functions/_shared/eztransTemplate.ts';

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

const ARGS = {
  order: ORDER,
  serial: 'LL01-P100X-00412',
  masterCarton: '1',
  carrier: 'Purolator',
  tracking: 'PUR123456789',
};

describe('the packing list default', () => {
  it('does not drift from the edge function copy', () => {
    expect(DEFAULT_EZTRANS_PACKING_LIST).toBe(SHARED_PACKING_LIST);
    expect(EZTRANS_PACKING_LIST_KEY).toBe(SHARED_PACKING_KEY);
  });

  it('leaves no {{placeholder}} on the document the 3PL prints', () => {
    const { packingList } = buildEzTransBooking(ARGS);
    expect(packingList.join('\n')).not.toMatch(/\{\{/);
  });

  it('still carries the fields that identify the box', () => {
    const list = buildEzTransBooking(ARGS).packingList.join('\n');
    expect(list).toContain('Serial No: LL01-P100X-00412');
    expect(list).toContain('Master Carton: 1');
    expect(list).toContain('SKU: LILA-P100X');
    expect(list).toContain('Carrier: Purolator');
    expect(list).toContain('Tracking No: PUR123456789');
  });

  it('puts the address on its own lines rather than indented like the email', () => {
    const list = buildEzTransBooking(ARGS).packingList;
    expect(list).toContain('14 Grenfell Drive');
    expect(list).toContain('Wabush, NL, A0R 1B0');
    // The email indents continuation lines under "Address: "; the PDF must not.
    expect(list.some(l => l.startsWith('         '))).toBe(false);
  });
});

describe('an edited packing list', () => {
  it('is what gets rendered when one is supplied', () => {
    const { packingList } = buildEzTransBooking({
      ...ARGS,
      packingListTemplate: '# PICK LIST\nHandle upright.\nSerial No: {{serial}}',
    });
    expect(packingList).toEqual(['PICK LIST', 'Handle upright.', 'Serial No: LL01-P100X-00412']);
  });

  it('still fills variables from the order, not from whatever was typed', () => {
    const { packingList } = buildEzTransBooking({
      ...ARGS,
      packingListTemplate: 'Serial No: {{serial}} / Carton {{master_carton}}',
    });
    expect(packingList.join('\n')).toBe('Serial No: LL01-P100X-00412 / Carton 1');
  });

  it('is separate from the email wording — editing the body cannot touch it', () => {
    const { packingList } = buildEzTransBooking({
      ...ARGS,
      template: { subject: 'x', body: 'nothing about the shipment at all' },
    });
    const list = packingList.join('\n');
    expect(list).toContain('Serial No: LL01-P100X-00412');
    expect(list).toContain('Master Carton: 1');
  });

  it('falls back to the default when the edit is empty', () => {
    expect(buildEzTransBooking({ ...ARGS, packingListTemplate: '' }).packingList)
      .toEqual(buildEzTransBooking(ARGS).packingList);
  });
});

describe('packingListLines — how the template becomes a PDF', () => {
  it('makes "# " a title and "## " a section heading', () => {
    const lines = packingListLines('# PACKING LIST\n## SHIP TO\nJuanita M Wells');
    expect(lines[0]).toMatchObject({ text: 'PACKING LIST', size: 18, bold: true });
    expect(lines[1]).toMatchObject({ text: 'SHIP TO', size: 11, bold: true });
    expect(lines[2]).toMatchObject({ text: 'Juanita M Wells', size: 10 });
    expect(lines[2].bold).toBeFalsy();
  });

  it('turns a blank line into space under the line above rather than an empty row', () => {
    const lines = packingListLines('Order: #1184\n\n## SHIP TO');
    expect(lines.map(l => l.text)).toEqual(['Order: #1184', 'SHIP TO']);
    expect(lines[0].gap).toBeGreaterThan(0);
  });

  it('does not mistake an all-caps value line for a heading', () => {
    // "SKU: LILA-P100X" has no lowercase at all; only the explicit marker
    // decides, so it stays a body line.
    const lines = packingListLines('SKU: LILA-P100X\nCA');
    expect(lines.every(l => !l.bold)).toBe(true);
  });

  it('keeps a leading blank line from shifting the document', () => {
    expect(packingListLines('\n\n# PACKING LIST')[0]).toMatchObject({ text: 'PACKING LIST' });
  });

  it('renders the same text the panel previews', () => {
    const vars = ezTransVariables(ARGS);
    const rendered = renderEzTransTemplate(DEFAULT_EZTRANS_PACKING_LIST, vars);
    expect(packingListLines(rendered).map(l => l.text))
      .toEqual(buildEzTransBooking(ARGS).packingList);
  });
});

describe('who the booking email comes from', () => {
  it('is sent by Reina with Huayi copied', () => {
    expect(EZTRANS_FROM).toContain('reina@virgohome.io');
    expect(EZTRANS_CC).toContain('huayi@virgohome.io');
  });

  it('does not drift from the edge function copy', () => {
    expect(EZTRANS_FROM).toBe(EZTRANS_FROM_DEFAULT);
    expect(EZTRANS_CC).toEqual(EZTRANS_CC_DEFAULT);
  });
});

const MIGRATION = Object.values(
  import.meta.glob('../../../supabase/migrations/*_eztrans_packing_list_template.sql', {
    query: '?raw', import: 'default', eager: true,
  }) as Record<string, string>,
)[0];

describe('the seed migration matches the built-in packing list', () => {
  it('is in the repo', () => {
    expect(MIGRATION).toBeTruthy();
  });

  it('seeds the same key and a byte-identical body', () => {
    // The migration writes E'...' strings, so \n is an escape there and a real
    // newline here. Compare after undoing that.
    const unescape = (s: string) => s.replace(/\\n/g, '\n').replace(/''/g, "'");
    const literals = [...MIGRATION.matchAll(/E'((?:[^']|'')*)'/g)].map(m => unescape(m[1]));
    expect(MIGRATION).toContain(`'${EZTRANS_PACKING_LIST_KEY}'`);
    expect(literals).toContain(DEFAULT_EZTRANS_PACKING_LIST);
  });

  it('declares every variable the default actually uses', () => {
    const used = [...DEFAULT_EZTRANS_PACKING_LIST.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
    const declared = new Set(EZTRANS_PACKING_LIST_VARIABLES);
    for (const v of used) expect(declared.has(v as never)).toBe(true);
    for (const v of EZTRANS_PACKING_LIST_VARIABLES) expect(MIGRATION).toContain(`'${v}'`);
  });
});
