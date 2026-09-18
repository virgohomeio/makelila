import { describe, it, expect } from 'vitest';
// The packing list the EZ Trans 3PL prints is built by a hand-written PDF
// writer in the edge-function tree. Nothing else in the toolchain looks at it,
// and a PDF whose xref offsets are wrong opens as a blank page in some readers
// and not at all in others — so the structure is asserted here.
import { buildTextPdf, toBase64 } from '../../../supabase/functions/_shared/simplePdf.ts';

function render(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe('buildTextPdf', () => {
  const pdf = buildTextPdf([
    { text: 'PACKING LIST', size: 18, bold: true, gap: 4 },
    { text: 'Order: #1184' },
    { text: 'Serial No: LL01-P100X-00412' },
  ]);
  const src = render(pdf);

  it('emits a well-formed single-page document', () => {
    expect(src.startsWith('%PDF-1.4')).toBe(true);
    expect(src.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(src).toContain('/Type /Catalog');
    expect(src).toContain('/Count 1');
  });

  it('puts every line in the content stream', () => {
    expect(src).toContain('(PACKING LIST) Tj');
    expect(src).toContain('(Order: #1184) Tj');
    expect(src).toContain('(Serial No: LL01-P100X-00412) Tj');
  });

  it('writes xref offsets that actually point at their objects', () => {
    const xrefStart = Number(/startxref\n(\d+)/.exec(src)![1]);
    expect(src.slice(xrefStart, xrefStart + 4)).toBe('xref');

    const rows = [...src.matchAll(/^(\d{10}) 00000 n $/gm)].map(m => Number(m[1]));
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((offset, i) => {
      expect(src.slice(offset)).toMatch(new RegExp(`^${i + 1} 0 obj\\n`));
    });
  });

  it('declares a stream length that matches the bytes written', () => {
    const declared = Number(/<< \/Length (\d+) >>\nstream\n/.exec(src)![1]);
    const stream = /stream\n([\s\S]*?)endstream/.exec(src)![1];
    expect(stream.length).toBe(declared);
  });

  it('escapes the characters that would end a PDF string early', () => {
    const escaped = render(buildTextPdf([{ text: 'Apt (rear) \\ back' }]));
    expect(escaped).toContain('(Apt \\(rear\\) \\\\ back) Tj');
  });

  it('folds non-ASCII text instead of emitting bytes Helvetica cannot show', () => {
    const folded = render(buildTextPdf([{ text: 'Montréal — Québec 🌱' }]));
    expect(folded).toContain('(Montreal - Quebec ) Tj');
  });

  it('breaks onto a second page rather than writing off the bottom', () => {
    const many = buildTextPdf(Array.from({ length: 80 }, (_, i) => ({ text: `line ${i}` })));
    const manySrc = render(many);
    expect(manySrc).toContain('/Count 2');
    expect((manySrc.match(/\/Type \/Page\b/g) ?? []).length).toBe(2);
  });
});

describe('toBase64', () => {
  it('round-trips the document bytes', () => {
    const bytes = buildTextPdf([{ text: 'hello' }]);
    expect(atob(toBase64(bytes))).toBe(render(bytes));
  });
});
