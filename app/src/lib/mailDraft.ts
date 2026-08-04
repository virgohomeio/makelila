/** Opening a pre-filled draft in the operator's own mail client.
 *
 *  makeLILA sends transactional customer mail through Resend
 *  (lib/templates.ts sendTemplate). Hiring correspondence is different: it goes
 *  out from the operator personally, under their own name, signature and reply
 *  address, and they want to eyeball it before it leaves. A `mailto:` URL is
 *  exactly that handoff — Windows opens it with the registered mail handler
 *  (Outlook for this team), pre-filled, sitting in a compose window until the
 *  operator presses Send. Nothing is sent by makeLILA and nothing is logged to
 *  email_messages.
 */

/** RFC 6068 mailto URL. Body newlines are normalized to CRLF — bare LF renders
 *  as one run-on line in some Outlook builds. */
export function buildMailtoUrl(input: { to: string; subject: string; body: string }): string {
  const params = new URLSearchParams({
    subject: input.subject,
    body: input.body.replace(/\r\n|\r|\n/g, '\r\n'),
  });
  // URLSearchParams encodes spaces as '+', which mail clients render literally
  // in a subject line. RFC 6068 wants percent-encoding throughout.
  const query = params.toString().replace(/\+/g, '%20');
  return `mailto:${encodeURIComponent(input.to)}?${query}`;
}

/** Hands the draft to the OS mail handler. Assigning location.href (rather than
 *  window.open) keeps the makeLILA tab where it is — the mail client takes
 *  focus and the board is still behind it when the operator comes back.
 *
 *  Windows' shell truncates mailto URLs past roughly 2000 characters. The
 *  screening invite renders to a few hundred, so this is a non-issue today; a
 *  much longer template would need the copy-to-clipboard path instead. */
export function openMailDraft(input: { to: string; subject: string; body: string }): void {
  window.location.href = buildMailtoUrl(input);
}
