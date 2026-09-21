// End-to-end over the packing-list override, from the text the operator leaves
// in the panel to the bytes of the PDF the 3PL opens. The unit tests either
// side of this passed while an edit still failed to reach the document, so
// this walks the whole path in one go.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EZTRANS_PACKING_LIST,
  packingListLines,
  renderEzTransTemplate,
} from '../../../supabase/functions/_shared/eztransTemplate.ts';
import { buildTextPdf } from '../../../supabase/functions/_shared/simplePdf.ts';
import { buildEzTransBooking, type EzTransShipTo } from './eztrans';

const ORDER: EzTransShipTo & { order_ref: string } = {
  order_ref: '#1184',
  customer_name: 'Juanita M Wells',
  customer_email: 'juanitawells7@hotmail.com',
  customer_phone: '+17092824256',
  address_line: '53 Guy street',
  address_line2: null,
  city: 'Wabush',
  region_state: 'NL',
  postal_code: 'A0R 1B0',
  country: 'CA',
};

const ARGS = {
  order: ORDER,
  serial: 'LL01-00000000351',
  masterCarton: '1',
  carrier: 'Purolator',
  tracking: '520763643704',
};

/** The text actually drawn into the PDF content streams. */
function pdfText(bytes: Uint8Array): string {
  const raw = new TextDecoder().decode(bytes);
  return [...raw.matchAll(/\((.*?)\) Tj/g)].map(m => m[1]).join('\n');
}

/** What the edge function does with an override, verbatim. */
function serverPdfFor(packingOverride?: string): string {
  const vars = {
    customer_name: ORDER.customer_name,
    customer_address_block: '53 Guy street\nWabush, NL, A0R 1B0\nCA',
    customer_email: ORDER.customer_email!,
    customer_phone: ORDER.customer_phone!,
    product_name: 'LILA Kitchen Composter',
    sku: 'LILA-P100X',
    serial: ARGS.serial,
    batch_lot: 'P100X',
    master_carton: '1',
    quantity: '1',
    carrier: ARGS.carrier,
    tracking: ARGS.tracking,
    order_ref: ORDER.order_ref,
    date: '2026-09-21',
  };
  const text = renderEzTransTemplate(packingOverride ?? DEFAULT_EZTRANS_PACKING_LIST, vars);
  return pdfText(buildTextPdf(packingListLines(text)));
}

describe('an edited packing list reaches the PDF', () => {
  it('carries lines the operator added for this order', () => {
    // Exactly what the panel hands over: the rendered document, edited.
    const edited = buildEzTransBooking(ARGS).packingListText
      .replace('Quantity: 1', 'Quantity: 1\nFridge magnet: 1\nTote bag: 1');

    const out = serverPdfFor(edited);
    expect(out).toContain('Fridge magnet: 1');
    expect(out).toContain('Tote bag: 1');
    // And it has not lost what it already had.
    expect(out).toContain('Serial No: LL01-00000000351');
    expect(out).toContain('Master Carton: 1');
  });

  it('differs from the stock document, so a no-op would be caught', () => {
    const edited = buildEzTransBooking(ARGS).packingListText + '\nTote bag: 1';
    expect(serverPdfFor(edited)).not.toBe(serverPdfFor());
  });

  it('keeps every added line when the document runs past one page', () => {
    const many = Array.from({ length: 70 }, (_, i) => `Extra item ${i + 1}: 1`).join('\n');
    const out = serverPdfFor(buildEzTransBooking(ARGS).packingListText + '\n' + many);
    expect(out).toContain('Extra item 1: 1');
    expect(out).toContain('Extra item 70: 1');
  });
});
