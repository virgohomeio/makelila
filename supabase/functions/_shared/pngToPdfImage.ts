// Turn a PNG into a PDF image XObject, without decompressing it.
//
// The only image this app draws into a PDF is the signature on the UPS
// pesticide worksheet, and that file is not in this repo — it is a real
// person's handwritten signature, so it lives in a private Supabase bucket and
// is fetched at send time. Whatever comes back has to be embedded in a
// document that simplePdf.ts assembles as an ASCII string.
//
// A PNG's IDAT payload is a zlib stream of rows, each prefixed with a filter
// byte. That is exactly what PDF's FlateDecode with /Predictor 15 expects, so
// the compressed bytes can be moved across verbatim: no inflate, no re-encode,
// no image library. They are ASCII85'd on the way so the PDF stays byte-for-
// byte an ASCII string and simplePdf's xref offsets keep matching.

export type PdfImage = {
  /** The zlib stream, ASCII85-encoded, `~>` terminator included. */
  a85: string;
  width: number;
  height: number;
  /** 1 for DeviceGray, 3 for DeviceRGB — what /Colors and /ColorSpace need. */
  colors: 1 | 3;
  bitsPerComponent: 8;
};

function be32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** ASCII85, as PDF's ASCII85Decode reads it. */
export function ascii85(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 4) {
    const n = bytes.length - i;
    let word = 0;
    for (let k = 0; k < 4; k++) word = (word * 256) + (k < n ? bytes[i + k] : 0);
    if (n >= 4 && word === 0) { out += 'z'; continue; }
    const group = ['', '', '', '', ''];
    let w = word;
    for (let k = 4; k >= 0; k--) { group[k] = String.fromCharCode(33 + (w % 85)); w = Math.floor(w / 85); }
    // A short final group drops as many trailing characters as it had padding
    // bytes, which is how the decoder knows the length.
    out += group.join('').slice(0, n >= 4 ? 5 : n + 1);
  }
  return `${out}~>`;
}

/** Read a PNG far enough to re-wrap it as a PDF image.
 *
 *  Deliberately narrow: 8-bit greyscale or truecolour, no interlacing, no
 *  palette and no alpha. Anything else is rejected by name rather than drawn
 *  wrong — a smeared signature on a CBP form is not a thing to discover later.
 *  Re-export the asset as 8-bit greyscale PNG if this throws. */
export function pngToPdfImage(bytes: Uint8Array): PdfImage {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error('not a PNG file');
  }

  let width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = 0;
  const idat: Uint8Array[] = [];
  let at = 8;
  while (at + 8 <= bytes.length) {
    const len = be32(bytes, at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const start = at + 8;
    if (start + len > bytes.length) throw new Error(`PNG chunk ${type} runs past the end of the file`);
    if (type === 'IHDR') {
      width = be32(bytes, start);
      height = be32(bytes, start + 4);
      bitDepth = bytes[start + 8];
      colorType = bytes[start + 9];
      interlace = bytes[start + 12];
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(start, start + len));
    } else if (type === 'IEND') {
      break;
    }
    at = start + len + 4; // + CRC
  }

  if (!width || !height) throw new Error('PNG has no IHDR');
  if (bitDepth !== 8) throw new Error(`PNG bit depth ${bitDepth} is not supported — re-export as 8-bit`);
  if (colorType !== 0 && colorType !== 2) {
    throw new Error(
      `PNG colour type ${colorType} is not supported — re-export as 8-bit greyscale or RGB with no alpha`,
    );
  }
  if (interlace !== 0) throw new Error('interlaced PNG is not supported — re-export without Adam7');
  if (!idat.length) throw new Error('PNG has no IDAT');

  let total = 0;
  for (const part of idat) total += part.length;
  const stream = new Uint8Array(total);
  let off = 0;
  for (const part of idat) { stream.set(part, off); off += part.length; }

  return {
    a85: ascii85(stream),
    width,
    height,
    colors: colorType === 0 ? 1 : 3,
    bitsPerComponent: 8,
  };
}
