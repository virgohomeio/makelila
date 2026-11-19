import { assertEquals, assertRejects, assertMatch } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { zipSync, strToU8 } from 'npm:fflate@0.8.2';
import { docxXmlToText, extractDocumentText, DOCX_MIME, PDF_MIME } from './documentText.ts';

/** A minimal single-page PDF with one Helvetica text run. pdf.js reconstructs
 *  the missing xref table, so no byte offsets are needed. */
function tinyPdf(text: string): Uint8Array<ArrayBuffer> {
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  return new TextEncoder().encode(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${content.length} >> stream
${content}
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF`);
}

function tinyDocx(bodyXml: string): Uint8Array<ArrayBuffer> {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`;
  return zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8(xml) }) as Uint8Array<ArrayBuffer>;
}

Deno.test('docxXmlToText: paragraphs become lines, tabs/breaks preserved, tags stripped, entities decoded', () => {
  const xml = '<w:body><w:p><w:r><w:t>Ada</w:t><w:t xml:space="preserve"> Lovelace</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>ada@example.com</w:t><w:tab/><w:t>555-0100</w:t><w:br/><w:t>R&amp;D &lt;lead&gt;</w:t></w:r></w:p></w:body>';
  assertEquals(docxXmlToText(xml), 'Ada Lovelace\nada@example.com\t555-0100\nR&D <lead>');
});

Deno.test('docxXmlToText: collapses runs of blank lines and trims', () => {
  const xml = '<w:p/><w:p/><w:p><w:r><w:t>Only line</w:t></w:r></w:p><w:p/><w:p/>';
  assertEquals(docxXmlToText(xml), 'Only line');
});

Deno.test('extractDocumentText: reads text out of a PDF', async () => {
  const text = await extractDocumentText(tinyPdf('Hello Ada Lovelace'), PDF_MIME);
  assertMatch(text, /Hello Ada Lovelace/);
});

Deno.test('extractDocumentText: reads text out of a DOCX', async () => {
  const bytes = tinyDocx('<w:p><w:r><w:t>Grace Hopper</w:t></w:r></w:p><w:p><w:r><w:t>grace@navy.mil</w:t></w:r></w:p>');
  assertEquals(await extractDocumentText(bytes, DOCX_MIME), 'Grace Hopper\ngrace@navy.mil');
});

Deno.test('extractDocumentText: accepts an ArrayBuffer as well as a Uint8Array', async () => {
  const bytes = tinyDocx('<w:p><w:r><w:t>Buffer</w:t></w:r></w:p>');
  assertEquals(await extractDocumentText(bytes.buffer, DOCX_MIME), 'Buffer');
});

Deno.test('extractDocumentText: rejects a DOCX with no word/document.xml', async () => {
  const bytes = zipSync({ 'nothing.txt': strToU8('x') }) as Uint8Array<ArrayBuffer>;
  const err = await assertRejects(() => extractDocumentText(bytes, DOCX_MIME), Error);
  assertMatch(err.message, /word\/document\.xml/);
});

Deno.test('extractDocumentText: rejects an unsupported mime type', async () => {
  const err = await assertRejects(() => extractDocumentText(new Uint8Array(4), 'image/png'), Error);
  assertMatch(err.message, /Unsupported/);
});
