// Local text extraction for resume files, so a provider without a document
// content block (Qwen's OpenAI-compatible chat API) can still read them.
// Used by parse-resume-batch's Qwen fallback — see
// docs/superpowers/specs/2026-08-26-hiring-resume-qwen-fallback-design.md.
//
// PDF  → unpdf (pdf.js serverless build; pure JS, works under Deno).
// DOCX → unzip word/document.xml (fflate) and flatten the WordprocessingML.
// Image-only (scanned) PDFs yield no text; the caller reports that clearly
// rather than sending an empty resume to the model.

// Both parsers are loaded with a DYNAMIC import, deliberately. A static
// top-level import would run at module load — i.e. when parse-resume-batch
// boots — so if the pdf.js bundle can't initialise in the Supabase edge
// runtime (a known unpdf-on-Supabase failure mode, unjs/unpdf#3) the whole
// function would fail to boot and take the working Claude path down with
// it. Loading inside the branch keeps any such failure contained to the
// Qwen fallback, where the caller already reports it as "could not read
// the file". Cost is one module load per cold start, only when Qwen runs.

export const PDF_MIME = 'application/pdf';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Flattens the body of a DOCX `word/document.xml`: one line per paragraph,
 *  `<w:tab/>` → tab, `<w:br/>` → newline, all other tags dropped, XML
 *  entities decoded, runs of blank lines collapsed. Exported for unit tests. */
export function docxXmlToText(xml: string): string {
  const withBreaks = xml
    .replace(/<w:tab\s*\/>/g, '\t')
    .replace(/<w:br\s*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');
  const decoded = withBreaks
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return decoded.replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

/** Returns the plain text of a PDF or DOCX. Throws on an unsupported mime
 *  type, a DOCX with no document part, or a PDF pdf.js can't open. */
export async function extractDocumentText(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>, mimeType: string): Promise<string> {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (mimeType === PDF_MIME) {
    const { extractText, getDocumentProxy } = await import('npm:unpdf@1.4.0');
    const pdf = await getDocumentProxy(u8);
    const { text } = await extractText(pdf, { mergePages: true });
    return text.trim();
  }
  if (mimeType === DOCX_MIME) {
    const { unzipSync, strFromU8 } = await import('npm:fflate@0.8.2');
    const files = unzipSync(u8);
    const doc = files['word/document.xml'];
    if (!doc) throw new Error('DOCX has no word/document.xml part');
    return docxXmlToText(strFromU8(doc));
  }
  throw new Error(`Unsupported document type for text extraction: ${mimeType}`);
}
