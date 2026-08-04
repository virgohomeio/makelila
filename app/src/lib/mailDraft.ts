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

/** Gmail compose URL for a specific sending account.
 *
 *  `mailto:` cannot choose a sender — RFC 6068 has no such field, so the OS
 *  handler composes from whatever it considers the default account (on a
 *  Windows box with Outlook installed, frequently a personal one). The team is
 *  on Google Workspace, so composing in Gmail with `authuser` set to the
 *  operator's own address puts the invite in the right outbox every time. If
 *  that account isn't signed in in this browser, Gmail shows its account
 *  chooser — still better than silently sending from the wrong address. */
export function buildGmailComposeUrl(input: {
  from: string; to: string; subject: string; body: string;
}): string {
  const params = new URLSearchParams({
    authuser: input.from,
    view: 'cm',            // compose
    fs: '1',               // full-screen compose window
    to: input.to,
    su: input.subject,
    body: input.body,
  });
  // URLSearchParams renders spaces as '+'; a literal '+' in an address is
  // already %2B by then, so this only rewrites the spaces.
  return `https://mail.google.com/mail/?${params.toString().replace(/\+/g, '%20')}`;
}

export type DraftUrl = { kind: 'gmail' | 'mailto'; url: string };

/** Gmail when we know which account the operator sends as, `mailto:` when we
 *  don't. AuthProvider documents that `user.email` can be transiently
 *  undefined on a session that hasn't fully populated — the fallback keeps the
 *  button working through that window, at the cost of the sender being
 *  whatever the OS picks. */
export function buildDraftUrl(input: {
  from?: string | null; to: string; subject: string; body: string;
}): DraftUrl {
  const { from, ...draft } = input;
  return from
    ? { kind: 'gmail', url: buildGmailComposeUrl({ from, ...draft }) }
    : { kind: 'mailto', url: buildMailtoUrl(draft) };
}

/** Opens the draft. Gmail goes to a new tab so the board stays put behind it;
 *  a mailto handoff assigns location.href, which hands off to the OS mail
 *  client without navigating this tab anywhere.
 *
 *  Windows' shell truncates mailto URLs past roughly 2000 characters. The
 *  screening invite renders to a few hundred, so this is a non-issue today; a
 *  much longer template would need the copy-to-clipboard path instead. */
export function openMailDraft(input: {
  from?: string | null; to: string; subject: string; body: string;
}): void {
  const draft = buildDraftUrl(input);
  if (draft.kind === 'gmail') window.open(draft.url, '_blank', 'noopener,noreferrer');
  else window.location.href = draft.url;
}
