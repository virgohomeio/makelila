/** Turn the plain-text email body an operator edits into an HTML part.
 *
 *  Every customer-facing send in this app is authored as plain text: the Step-5
 *  textarea, the stored email_templates row and the audit copy in
 *  email_messages are all one unformatted string, and keeping it that way is
 *  what lets an operator edit a send without touching markup.
 *
 *  But plain text cannot carry a picture, and the shipment confirmation now has
 *  to show the Lovely install guide. So rather than introduce a second,
 *  HTML-shaped body for operators to maintain, the text stays the source of
 *  truth and this builds the HTML part from it at send time. Resend is handed
 *  both: a client that wants HTML sees the image, a client that wants text sees
 *  the URL on its own line. Neither can drift from the other, because there is
 *  still only one body.
 *
 *  The one piece of syntax is deliberately invisible in the text version: a
 *  line that is nothing but an image URL becomes an <img>. An operator who
 *  pastes another image URL on its own line gets an image with no new
 *  vocabulary to learn, and a text-only reader still gets a working link.
 *
 *  Pure on purpose — no Deno globals — so the app's test suite can cover it.
 *  Mirrored nowhere: the app never renders HTML, it only previews the text. */

/** A line consisting solely of an https URL ending in an image extension.
 *  Anchored both ends so a sentence that merely mentions a .png is left alone. */
const LONE_IMAGE_URL = /^https:\/\/[^\s<>"']+\.(?:png|jpe?g|gif|webp)(?:\?[^\s<>"']*)?$/i;

/** Bare URLs inside ordinary prose. Trailing sentence punctuation is excluded
 *  so "see https://x.com/y." links the URL and not the full stop. */
const INLINE_URL = /https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]}]/g;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** "https://lila.vip/lovely-install-guide.png" -> "Lovely install guide".
 *  Alt text has to come from somewhere and the filename is the only thing the
 *  body tells us about the picture. An unreadable filename yields a generic
 *  label rather than a string of hyphens and hashes. */
export function altTextFromUrl(url: string): string {
  const file = url.split('?')[0].split('/').pop() ?? '';
  const stem = file.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
  if (!/[a-z]{3}/i.test(stem)) return 'Image';
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

function linkify(escaped: string): string {
  return escaped.replace(INLINE_URL, url =>
    `<a href="${url}" style="color:#9e1b32;">${url}</a>`);
}

function imageTag(url: string): string {
  // width:100% with a max-width keeps the guide readable on a phone without
  // blowing past the column on a desktop client. Outlook ignores CSS max-width
  // on images, hence the width attribute as well.
  return `<p style="margin:20px 0;">`
    + `<img src="${escapeHtml(url)}" alt="${escapeHtml(altTextFromUrl(url))}" width="600" `
    + `style="width:100%;max-width:600px;height:auto;display:block;border:0;border-radius:8px;">`
    + `</p>`;
}

/** Render the body as HTML. Blank lines separate paragraphs; single newlines
 *  become <br> so the carrier/tracking block keeps its shape. */
export function textToEmailHtml(text: string): string {
  const blocks: string[] = [];
  let para: string[] = [];

  const flush = () => {
    if (para.length === 0) return;
    blocks.push(`<p style="margin:0 0 16px;">${para.join('<br>')}</p>`);
    para = [];
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') { flush(); continue; }
    if (LONE_IMAGE_URL.test(line)) {
      flush();
      blocks.push(imageTag(line));
      continue;
    }
    para.push(linkify(escapeHtml(rawLine)));
  }
  flush();

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;`
    + `font-size:15px;line-height:1.6;color:#2b2b2b;max-width:640px;margin:0 auto;padding:8px;">`
    + blocks.join('')
    + `</div>`;
}
