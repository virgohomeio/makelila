// Concatenate PDFs into one document.
//
// EZ Trans asked for one file rather than two: they print what we send and
// tape it to the carton, and a label in one attachment with the packing list
// in another is two clicks and one chance to print only half of it. The label
// comes from Goorooship, so it is whatever the carrier's system produced —
// arbitrary, sometimes compressed-xref, occasionally linearised — and lifting
// pages out of a document like that is not something to hand-roll next to
// simplePdf.ts. pdf-lib does it properly.
//
// Deliberately the only remote import in the PDF path: everything we generate
// ourselves is still written by simplePdf, which stays dependency-free, so a
// bad day at esm.sh cannot stop a packing list from being built — only from
// being stapled to the label. The caller falls back to separate attachments
// when this throws.
import { PDFDocument } from 'https://esm.sh/pdf-lib@1.17.1';

/** One PDF holding every page of `parts`, in order.
 *
 *  Throws if any part cannot be parsed — the caller sends the parts separately
 *  rather than dropping one, because a shipment missing its label is worse
 *  than a shipment with two attachments. */
export async function mergePdfs(parts: Uint8Array[]): Promise<Uint8Array> {
  if (parts.length === 1) return parts[0];
  const out = await PDFDocument.create();
  for (const part of parts) {
    // Carrier labels are frequently produced by tools that leave the document
    // structurally sloppy; strict parsing rejects files that every reader
    // opens fine.
    const doc = await PDFDocument.load(part, { ignoreEncryption: true, throwOnInvalidObject: false });
    const pages = await out.copyPages(doc, doc.getPageIndices());
    for (const page of pages) out.addPage(page);
  }
  return await out.save();
}
