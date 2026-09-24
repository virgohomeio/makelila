// The UPS pesticide worksheet is a declaration to CBP with a real signature on
// it, and the sentence under the checkbox says that claiming the product is
// not a regulated pesticide when it is "may result in CBP penalties". What
// varies per shipment is only the tracking number, the shipment's identifiers
// and the date — so those are what is asserted here, hardest of all that the
// tracking number on the form is the one on the queue row.
import { describe, it, expect } from 'vitest';
import {
  formatWorksheetDate,
  goodsDescription,
  pesticideWorksheetFilename,
  pesticideWorksheetLines,
  PESTICIDE_CERTIFIER,
  PESTICIDE_PART_NUMBER,
  PESTICIDE_TARIFF_NUMBER,
} from '../../../supabase/functions/_shared/pesticideWorksheet.ts';
import { buildTextPdf } from '../../../supabase/functions/_shared/simplePdf.ts';
import { pngToPdfImage } from '../../../supabase/functions/_shared/pngToPdfImage.ts';
import { onePixelPng } from './testPng';

const ARGS = {
  trackingNumber: '1Z2985EADK93221574',
  serial: 'LL01-00000000369',
  batchLot: 'P100X',
  quantity: 1,
  orderRef: '#1252',
  date: 'September 23, 2026',
};

/** The text actually drawn into the PDF content streams, unescaped and run
 *  back together — a sentence that wrapped is still one sentence to a reader,
 *  and these assertions are about what the form says, not where it breaks. */
function pdfText(bytes: Uint8Array): string {
  const raw = new TextDecoder('latin1').decode(bytes);
  return [...raw.matchAll(/\((.*?)\) Tj/g)]
    .map(m => m[1].replace(/\\([()\\])/g, '$1'))
    .join(' ')
    .replace(/\s+/g, ' ');
}

describe('the worksheet is tailored to the shipment', () => {
  const text = pdfText(buildTextPdf(pesticideWorksheetLines(ARGS)));

  it('files it against this shipment\'s tracking number', () => {
    expect(text).toContain(`[X] This is a single entry worksheet for shipment number: ${ARGS.trackingNumber}`);
  });

  it('carries the serial, batch, quantity and order reference', () => {
    expect(text).toContain(ARGS.serial);
    expect(text).toContain('Batch/Lot P100X');
    expect(text).toContain('Qty 1');
    expect(text).toContain('Order ref #1252');
  });

  it('classifies the unit the way every filed worksheet has', () => {
    expect(text).toContain(PESTICIDE_TARIFF_NUMBER);
    expect(text).toContain(PESTICIDE_PART_NUMBER);
  });

  it('answers No to the pesticide question, and only No', () => {
    expect(text).toContain('[X] No. Based on the definitions');
    expect(text).toContain('[ ] Yes. Based on the definitions');
    expect(text).not.toContain('[X] Yes');
  });

  it('marks it a single-entry worksheet, not a blanket one', () => {
    expect(text).toContain('[ ] This is a blanket statement');
    expect(text).toContain('[X] This is a single entry worksheet');
  });

  it('dates the form and the certification the same day', () => {
    expect(text.match(/September 23, 2026/g)?.length).toBe(2);
  });

  it('certifies as the signatory, with their real contact details', () => {
    expect(text).toContain(PESTICIDE_CERTIFIER.name);
    expect(text).toContain(PESTICIDE_CERTIFIER.email);
    expect(text).toContain(PESTICIDE_CERTIFIER.title);
    expect(text).toContain(PESTICIDE_CERTIFIER.phone);
  });

  it('keeps the certification on a page of its own', () => {
    const pdf = new TextDecoder('latin1').decode(buildTextPdf(pesticideWorksheetLines(ARGS)));
    expect(pdf).toContain('/Count 2');
  });

  it('separates the identifiers rather than running them together', () => {
    // The bullet the description is written with is not in the PDF's ASCII
    // alphabet; dropping it silently would read "LL01-00000000369 Batch/Lot".
    expect(goodsDescription(ARGS)).toContain('·');
    expect(text).toContain(`Serial No. ${ARGS.serial} - Batch/Lot`);
  });
});

describe('the signature', () => {
  it('is drawn when the asset is available', () => {
    const sig = pngToPdfImage(onePixelPng());
    const pdf = new TextDecoder('latin1').decode(
      buildTextPdf(pesticideWorksheetLines({ ...ARGS, signature: sig })));
    expect(pdf).toContain('/Subtype /Image');
    expect(pdf).toContain('/Im0 Do');
  });

  it('leaves the form buildable when the asset cannot be read', () => {
    // A worksheet the broker can still be sent, signed by hand, beats an
    // exception that holds up the shipment.
    const pdf = new TextDecoder('latin1').decode(
      buildTextPdf(pesticideWorksheetLines({ ...ARGS, signature: null })));
    expect(pdf).not.toContain('/Subtype /Image');
    expect(pdf).toContain('(Signature:) Tj');
  });
});

describe('formatWorksheetDate', () => {
  it('matches the long form the filed worksheets use', () => {
    expect(formatWorksheetDate(new Date('2026-09-23T04:00:00Z'))).toBe('September 23, 2026');
  });
});

describe('pesticideWorksheetFilename', () => {
  it('strips the characters an order reference carries that a filename cannot', () => {
    expect(pesticideWorksheetFilename('#1252')).toBe('pesticide-worksheet-1252.pdf');
  });
});
