// Minimal text-only PDF writer.
//
// The EZ Trans packing list has to arrive as a real PDF — a 3PL prints it and
// tapes it to the box — and the edge runtime has no PDF library we can pull in
// without adding a remote dependency to a function that has to boot fast. The
// document we need is a page of left-aligned lines in one of the two base-14
// fonts, which is small enough to emit by hand.
//
// It grew a little for the UPS pesticide worksheet, which is a form rather
// than a list: wrapped paragraphs, a second column on the same baseline, rules
// under the field values, and the signature image. All of it still assembles
// as an ASCII string — the image stream is ASCII85'd on the way in — so string
// length still equals byte length and the xref offsets can be computed on the
// assembled document.
//
// Only the base-14 Helvetica faces are used, so no font is embedded. Text is
// folded to ASCII (WinAnsi's safe range) before it goes in the content stream.

import { textWidth, wrapText } from './pdfFontMetrics.ts';
import type { PdfImage } from './pngToPdfImage.ts';

export type PdfLine = {
  text: string;
  /** Point size. Default 10. */
  size?: number;
  bold?: boolean;
  /** Extra blank space below this line, in points. Default 0. */
  gap?: number;
  /** Points to the right of the left margin. Default 0. */
  indent?: number;
  /** Draw on the same baseline as the line before, rather than below it.
   *  How the worksheet's certification block gets its second column, and how a
   *  long field value starts beside its label and then wraps under itself. */
  sameLine?: boolean;
  /** Start this line on a fresh page. */
  pageBreak?: boolean;
  /** Line height as a multiple of the point size. Default 1.5, which suits a
   *  list; a wrapped paragraph wants something closer to 1.25. */
  lead?: number;
  /** Wrap to this many points instead of the rest of the text column. What
   *  keeps a two-column row from running into the column beside it. */
  maxWidth?: number;
  /** Centre within the text column, ignoring `indent`. */
  center?: boolean;
  /** Hairline under this line, that many points wide, starting at `indent`.
   *  The worksheet's field rules. */
  rule?: number;
  /** Drawn instead of the text, `imageWidth` points wide at its own aspect
   *  ratio. `text` is still carried for anything reading the document back. */
  image?: PdfImage;
  imageWidth?: number;
};

const PAGE_W = 612;   // US Letter
const PAGE_H = 792;
const MARGIN = 56;
const BOTTOM = 56;

/** Width of the text column — what a wrapped paragraph gets to use. */
export const CONTENT_WIDTH = PAGE_W - MARGIN * 2;

/** Fold to printable ASCII: strip accents, drop anything else (emoji, smart
 *  quotes that survive the fold, control characters). */
function toAscii(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    // A separator, not decoration: dropping it silently runs two values
    // together ("Serial No. LL01-...  Batch/Lot P100X").
    .replace(/[·•]/g, '-')
    // deno-lint-ignore no-control-regex
    .replace(/[^\x20-\x7e]/g, '');
}

/** Escape the three characters that end a PDF literal string. */
function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

type Placed =
  | { kind: 'text'; text: string; size: number; bold: boolean; x: number; y: number }
  | { kind: 'rule'; x: number; y: number; width: number }
  | { kind: 'image'; image: PdfImage; x: number; y: number; width: number; height: number };

/** One drawn line's height, and the image's drawn size when it has one. */
function imageBox(line: PdfLine): { width: number; height: number } {
  const width = line.imageWidth ?? 120;
  const height = line.image ? (width * line.image.height) / line.image.width : 0;
  return { width, height };
}

function paginate(lines: PdfLine[]): Placed[][] {
  const pages: Placed[][] = [];
  let page: Placed[] = [];
  let y = PAGE_H - MARGIN;
  // The baseline of the last line drawn, so `sameLine` can return to it.
  let lastY = y;

  const push = (p: Placed) => page.push(p);

  for (const line of lines) {
    const size = line.size ?? 10;
    const bold = !!line.bold;
    const indent = line.indent ?? 0;

    if (line.image) {
      const { width, height } = imageBox(line);
      if (y - height < BOTTOM) { pages.push(page); page = []; y = PAGE_H - MARGIN; }
      y -= height;
      push({ kind: 'image', image: line.image, x: MARGIN + indent, y, width, height });
      lastY = y;
      y -= line.gap ?? 0;
      continue;
    }

    if (line.pageBreak && page.length) {
      pages.push(page);
      page = [];
      y = PAGE_H - MARGIN;
      lastY = y;
    }

    // A second column starts on the previous baseline. It still wraps — the
    // description of goods is a paragraph sitting beside its label — and the
    // flow resumes under whichever line it ended on.
    if (line.sameLine) {
      const parts = wrapText(toAscii(line.text), line.maxWidth ?? (CONTENT_WIDTH - indent), size, bold);
      const leading = size * (line.lead ?? 1.5);
      let baseline = lastY;
      parts.forEach((part, i) => {
        baseline = lastY - leading * i;
        push({ kind: 'text', text: escapeText(part), size, bold, x: MARGIN + indent, y: baseline });
        if (line.rule && i === parts.length - 1) {
          push({ kind: 'rule', x: MARGIN + indent, y: baseline - 3, width: line.rule });
        }
      });
      y = Math.min(y, baseline);
      lastY = baseline;
      y -= line.gap ?? 0;
      continue;
    }

    const available = line.maxWidth ?? (CONTENT_WIDTH - indent);
    const ascii = toAscii(line.text);
    const wrapped = ascii.trim() ? wrapText(ascii, available, size, bold) : [''];

    wrapped.forEach((part, i) => {
      const leading = size * (line.lead ?? 1.5);
      if (y - leading < BOTTOM) { pages.push(page); page = []; y = PAGE_H - MARGIN; }
      y -= leading;
      const x = line.center
        ? MARGIN + (CONTENT_WIDTH - textWidth(part, size, bold)) / 2
        : MARGIN + indent;
      push({ kind: 'text', text: escapeText(part), size, bold, x, y });
      lastY = y;
      // The rule belongs under the last line of a wrapped value, not each one.
      if (line.rule && i === wrapped.length - 1) {
        push({ kind: 'rule', x: MARGIN + indent, y: y - 3, width: line.rule });
      }
    });

    y -= line.gap ?? 0;
  }
  pages.push(page);
  return pages;
}

function contentStream(placed: Placed[]): string {
  return placed
    .map(p => {
      if (p.kind === 'rule') {
        return `${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.width.toFixed(2)} 0.6 re f\n`;
      }
      if (p.kind === 'image') {
        const name = imageName(p.image);
        return `q\n${p.width.toFixed(2)} 0 0 ${p.height.toFixed(2)} ` +
          `${p.x.toFixed(2)} ${p.y.toFixed(2)} cm\n/${name} Do\nQ\n`;
      }
      if (!p.text.length) return '';
      return `BT\n/${p.bold ? 'F2' : 'F1'} ${p.size} Tf\n` +
        `1 0 0 1 ${p.x.toFixed(2)} ${p.y.toFixed(2)} Tm\n(${p.text}) Tj\nET\n`;
    })
    .join('');
}

/** Images are numbered in the order they are first used, so the same asset
 *  drawn twice is embedded once. */
const imageNames = new WeakMap<PdfImage, string>();
function imageName(img: PdfImage): string {
  return imageNames.get(img) ?? 'Im0';
}

/** Render lines as a PDF. Returns the raw bytes, ready to base64 and attach. */
export function buildTextPdf(lines: PdfLine[]): Uint8Array {
  // Name every distinct image up front so the content streams and the
  // resource dictionaries agree.
  const images: PdfImage[] = [];
  for (const line of lines) {
    if (line.image && !images.includes(line.image)) {
      imageNames.set(line.image, `Im${images.length}`);
      images.push(line.image);
    }
  }

  const pages = paginate(lines);

  // Object numbering: 1 catalog, 2 pages, 3 + 4 fonts, then one object per
  // image, then page/content pairs.
  const FIRST_IMAGE_OBJ = 5;
  const FIRST_PAGE_OBJ = FIRST_IMAGE_OBJ + images.length;
  const kids = pages.map((_, i) => `${FIRST_PAGE_OBJ + i * 2} 0 R`).join(' ');

  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`,
  ];

  images.forEach(img => {
    // The PNG's own zlib stream, moved across untouched: /Predictor 15 is
    // PNG's per-row filter byte, which is why no inflate is needed.
    objects.push(
      `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
      `/ColorSpace /${img.colors === 1 ? 'DeviceGray' : 'DeviceRGB'} ` +
      `/BitsPerComponent ${img.bitsPerComponent} ` +
      `/Filter [ /ASCII85Decode /FlateDecode ] ` +
      `/DecodeParms [ null << /Predictor 15 /Colors ${img.colors} ` +
      `/BitsPerComponent ${img.bitsPerComponent} /Columns ${img.width} >> ] ` +
      `/Length ${img.a85.length} >>\nstream\n${img.a85}\nendstream`,
    );
  });

  const xobjects = images.length
    ? ` /XObject << ${images.map((_, i) => `/Im${i} ${FIRST_IMAGE_OBJ + i} 0 R`).join(' ')} >>`
    : '';

  pages.forEach((placed, i) => {
    const contentObjNum = FIRST_PAGE_OBJ + i * 2 + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobjects} >> /Contents ${contentObjNum} 0 R >>`,
    );
    const stream = contentStream(placed);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  // Latin-1 rather than UTF-8: every byte written above is ASCII, and this
  // keeps `pdf.length` (which the xref offsets were computed from) equal to
  // the number of bytes emitted even if a fold ever lets one slip through.
  const out = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) out[i] = pdf.charCodeAt(i) & 0xff;
  return out;
}

/** Base64 for a Resend attachment. Chunked so a large document doesn't blow
 *  the argument limit on String.fromCharCode. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
