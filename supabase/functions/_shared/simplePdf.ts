// Minimal text-only PDF writer.
//
// The EZ Trans packing list has to arrive as a real PDF — a 3PL prints it and
// tapes it to the box — and the edge runtime has no PDF library we can pull in
// without adding a remote dependency to a function that has to boot fast. The
// document we need is a page of left-aligned lines in one of the two base-14
// fonts, which is small enough to emit by hand.
//
// Only the base-14 Helvetica faces are used, so no font is embedded. Text is
// folded to ASCII (WinAnsi's safe range) before it goes in the content stream,
// which also means string length == byte length and the xref offsets can be
// computed on the assembled string.

export type PdfLine = {
  text: string;
  /** Point size. Default 10. */
  size?: number;
  bold?: boolean;
  /** Extra blank space below this line, in points. Default 0. */
  gap?: number;
};

const PAGE_W = 612;   // US Letter
const PAGE_H = 792;
const MARGIN = 56;
const BOTTOM = 56;

/** Fold to printable ASCII: strip accents, drop anything else (emoji, smart
 *  quotes that survive the fold, control characters). */
function toAscii(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    // deno-lint-ignore no-control-regex
    .replace(/[^\x20-\x7e]/g, '');
}

/** Escape the three characters that end a PDF literal string. */
function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

type Placed = { text: string; size: number; bold: boolean; y: number };

function paginate(lines: PdfLine[]): Placed[][] {
  const pages: Placed[][] = [];
  let page: Placed[] = [];
  let y = PAGE_H - MARGIN;

  for (const line of lines) {
    const size = line.size ?? 10;
    const leading = size * 1.5;
    if (y - leading < BOTTOM) {
      pages.push(page);
      page = [];
      y = PAGE_H - MARGIN;
    }
    y -= leading;
    page.push({ text: escapeText(toAscii(line.text)), size, bold: !!line.bold, y });
    y -= line.gap ?? 0;
  }
  pages.push(page);
  return pages;
}

function contentStream(placed: Placed[]): string {
  return placed
    .filter(p => p.text.length > 0)
    .map(p =>
      `BT\n/${p.bold ? 'F2' : 'F1'} ${p.size} Tf\n` +
      `1 0 0 1 ${MARGIN} ${p.y.toFixed(2)} Tm\n(${p.text}) Tj\nET\n`,
    )
    .join('');
}

/** Render lines as a PDF. Returns the raw bytes, ready to base64 and attach. */
export function buildTextPdf(lines: PdfLine[]): Uint8Array {
  const pages = paginate(lines);

  // Object numbering: 1 catalog, 2 pages, 3 + 4 fonts, then page/content pairs.
  const FIRST_PAGE_OBJ = 5;
  const kids = pages.map((_, i) => `${FIRST_PAGE_OBJ + i * 2} 0 R`).join(' ');

  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`,
  ];

  pages.forEach((placed, i) => {
    const contentObjNum = FIRST_PAGE_OBJ + i * 2 + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjNum} 0 R >>`,
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

  return new TextEncoder().encode(pdf);
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
