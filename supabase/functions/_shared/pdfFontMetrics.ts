// Adobe base-14 character widths for the two Helvetica faces simplePdf.ts uses,
// in 1/1000 em, for ASCII 32-126.
//
// Needed because the pesticide worksheet has real paragraphs in it — the FIFRA
// definitions and the intended-use statement — and a paragraph has to be
// wrapped to the page before it is drawn. Guessing an average character width
// puts a line or two past the right margin on a customs document, so the real
// metrics are carried instead. Every other glyph is folded to ASCII by
// simplePdf before it is measured or drawn, so this table covers the alphabet.

const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Width of an ASCII string at `size` points, in points. */
export function textWidth(s: string, size: number, bold: boolean): number {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    // Anything outside the table has already been folded away by toAscii; a
    // stray one is measured as a space rather than as zero.
    w += (code >= 32 && code <= 126 ? table[code - 32] : table[0]);
  }
  return (w * size) / 1000;
}

/** Break `text` into lines no wider than `maxWidth` points.
 *
 *  Words longer than the line (a 40-character URL, a run-on serial) are hard
 *  split rather than left to overflow — a customs form that prints past the
 *  margin is worse than one with an awkward break. */
export function wrapText(text: string, maxWidth: number, size: number, bold: boolean): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, size, bold) <= maxWidth) { line = candidate; continue; }
    if (line) { lines.push(line); line = ''; }
    if (textWidth(word, size, bold) <= maxWidth) { line = word; continue; }
    let chunk = '';
    for (const ch of word) {
      if (textWidth(chunk + ch, size, bold) > maxWidth && chunk) { lines.push(chunk); chunk = ''; }
      chunk += ch;
    }
    line = chunk;
  }
  if (line) lines.push(line);
  return lines;
}
