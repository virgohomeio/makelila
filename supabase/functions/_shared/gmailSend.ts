// Send a message as a Workspace user through the Gmail API.
//
// Why this exists alongside Resend: Resend hands a message to the recipient's
// mail server and has no access to anyone's mailbox, so a message it sends
// "from" someone leaves no trace in that person's account — no Sent entry, no
// thread to follow when the 3PL replies. Gmail's users.messages.send, called
// while impersonating the sender, files the message in their Sent folder the
// same way as if they had pressed send themselves. That is the whole point.
//
// It also sidesteps sender verification: Workspace already owns the domain, so
// nothing has to be proved to a third party before mail can go out as its user.
//
// Deliberately free of remote imports so the app's test suite can import it;
// the token mint that does need `jose` lives in gmail-auth.ts.

/** Minimal scope for sending. Must be granted to the service account's
 *  domain-wide delegation entry in the Workspace admin console, or the token
 *  mint fails with unauthorized_client. */
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

export type MimeAttachment = {
  filename: string;
  contentType: string;
  /** Already base64 — both PDFs reach us that way. */
  base64: string;
};

export type MimeMessage = {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  attachments?: MimeAttachment[];
};

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64Utf8(text: string): string {
  return b64(new TextEncoder().encode(text));
}

/** Base64 in 76-character lines, as MIME requires — an unwrapped attachment
 *  would blow past the 998-octet line limit and be rejected or mangled. */
function wrap(base64: string): string {
  return (base64.replace(/\s/g, '').match(/.{1,76}/g) ?? []).join('\r\n');
}

/** A header value can never contain CR or LF: order references and customer
 *  names reach these headers, and a newline in one would let the rest of the
 *  value be read as further headers (a Bcc, say). Folded to spaces. */
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, '').trim();
}

/** RFC 2047 encode a header that isn't plain ASCII. The default subject
 *  carries an em dash and a middot, which are not legal raw in a header. */
function encodeHeader(value: string): string {
  const clean = sanitizeHeader(value);
  // deno-lint-ignore no-control-regex
  if (!/[^\x20-\x7e]/.test(clean)) return clean;
  return `=?UTF-8?B?${b64Utf8(clean)}?=`;
}

/** Quote a filename for Content-Disposition, dropping the characters that
 *  would end the quoted string early. */
function quoteFilename(name: string): string {
  return sanitizeHeader(name).replace(/["\\]/g, '');
}

/** Assemble an RFC 2822 message: a plain-text body plus file attachments. */
export function buildMimeMessage(msg: MimeMessage): string {
  const boundary = `b${Array.from({ length: 24 }, () =>
    'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('')}`;

  const headers = [
    `From: ${encodeHeader(msg.from)}`,
    `To: ${msg.to.map(sanitizeHeader).join(', ')}`,
    ...(msg.cc && msg.cc.length ? [`Cc: ${msg.cc.map(sanitizeHeader).join(', ')}`] : []),
    `Subject: ${encodeHeader(msg.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];

  const parts = [
    [
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      wrap(b64Utf8(msg.text)),
    ].join('\r\n'),
    ...(msg.attachments ?? []).map(a => [
      `Content-Type: ${sanitizeHeader(a.contentType)}; name="${quoteFilename(a.filename)}"`,
      `Content-Disposition: attachment; filename="${quoteFilename(a.filename)}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap(a.base64),
    ].join('\r\n')),
  ];

  return (
    headers.join('\r\n') + '\r\n\r\n' +
    parts.map(p => `--${boundary}\r\n${p}\r\n`).join('') +
    `--${boundary}--\r\n`
  );
}

/** The `raw` field of a Gmail send is base64url with the padding stripped. */
export function toBase64Url(text: string): string {
  return b64Utf8(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Send as the impersonated mailbox. `userId: me` resolves to whoever the
 *  delegated token speaks for, and Gmail files the result in their Sent. */
export async function sendGmailMessage(
  accessToken: string, message: MimeMessage,
): Promise<{ id: string; threadId?: string }> {
  const res = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: toBase64Url(buildMimeMessage(message)) }),
    },
  );
  if (!res.ok) {
    throw new Error(`Gmail send ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return await res.json() as { id: string; threadId?: string };
}
