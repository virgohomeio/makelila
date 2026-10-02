// The signature on the pesticide worksheet is the only image this app ever
// draws into a PDF, and it is moved across without being decompressed — the
// PNG's own zlib stream becomes the PDF stream, with /Predictor 15 standing in
// for PNG's per-row filter byte. That only works if the header is read
// correctly and the bytes are passed through untouched, which is what this
// covers. Anything it cannot handle has to say so rather than draw a smear.
import { describe, it, expect } from 'vitest';
import { ascii85, pngToPdfImage } from '../../../supabase/functions/_shared/pngToPdfImage.ts';
import { greyScanlines, onePixelPng, zlibStored } from './testPng';

describe('pngToPdfImage', () => {
  it('reads the dimensions and colour space off the header', () => {
    const img = pngToPdfImage(onePixelPng(7, 5));
    expect(img.width).toBe(7);
    expect(img.height).toBe(5);
    expect(img.colors).toBe(1);
    expect(img.bitsPerComponent).toBe(8);
  });

  it('carries the PNG\'s own compressed bytes across', () => {
    const img = pngToPdfImage(onePixelPng(4, 3));
    // The IDAT payload, byte for byte — nothing inflated, nothing re-encoded.
    expect(img.a85).toBe(ascii85(zlibStored(greyScanlines(4, 3))));
  });

  it('produces ASCII85 a PDF reader will accept', () => {
    const img = pngToPdfImage(onePixelPng());
    expect(img.a85.endsWith('~>')).toBe(true);
    // Every byte inside the PDF stays ASCII, which is what lets simplePdf
    // compute its xref offsets on the assembled string.
    expect(/^[\x21-\x75]*~>$/.test(img.a85)).toBe(true);
  });

  it('names what it cannot handle instead of guessing', () => {
    expect(() => pngToPdfImage(new Uint8Array([1, 2, 3]))).toThrow(/not a PNG/);

    const palette = onePixelPng();
    palette[8 + 8 + 9] = 3; // IHDR colour type -> palette
    expect(() => pngToPdfImage(palette)).toThrow(/colour type 3/);

    const sixteenBit = onePixelPng();
    sixteenBit[8 + 8 + 8] = 16; // IHDR bit depth
    expect(() => pngToPdfImage(sixteenBit)).toThrow(/bit depth 16/);
  });
});

describe('ascii85', () => {
  it('encodes the way PDF\'s ASCII85Decode reads', () => {
    // "Man " -> the canonical first group from the ASCII85 specification.
    expect(ascii85(new TextEncoder().encode('Man '))).toBe('9jqo^~>');
    // A short final group drops one character per padding byte.
    expect(ascii85(new Uint8Array([0x4d]))).toBe('9`~>');
  });

  it('folds four zero bytes to z, as the filter expects', () => {
    expect(ascii85(new Uint8Array([0, 0, 0, 0]))).toBe('z~>');
  });
});
