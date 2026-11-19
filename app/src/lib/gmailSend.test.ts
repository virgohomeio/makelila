// The EZ Trans booking is sent through Gmail as Reina so it lands in her Sent
// folder — a record that the 3PL was told, visible from her end. Resend cannot
// do that at any setting: it hands the message to the recipient's mail server
// and has no access to anyone's mailbox, so a From: header is just a label.
//
// Gmail's users.messages.send takes one RFC-2822 message, base64url encoded.
// These cover the message construction, which is where the sharp edges are:
// non-ASCII subjects, attachment encoding, and the CC line.
import { describe, it, expect } from 'vitest';
import {
  buildMimeMessage,
  toBase64Url,
} from '../../../supabase/functions/_shared/gmailSend.ts';

const PDF_B64 = 'JVBERi0xLjQK';  // "%PDF-1.4\n"

/** Decode base64 back to text without Buffer — this suite type-checks against
 *  the app's browser tsconfig, which has no Node types. */
function fromB64(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
}

const BASE = {
  from: 'VCycene Fulfillment <reina@virgohome.io>',
  to: ['cs@goorooship.ca'],
  cc: ['huayi@virgohome.io'],
  subject: 'Order confirmed — #1184 · LILA-P100X',
  text: 'Hello EZ Trans team,\n\nPlease fulfill it on your end.',
  attachments: [
    { filename: 'shipping-label-1184.pdf', contentType: 'application/pdf', base64: PDF_B64 },
    { filename: 'packing-list-1184.pdf', contentType: 'application/pdf', base64: PDF_B64 },
  ],
};

/** Pull one header value out of the assembled message. */
function header(msg: string, name: string): string {
  const m = new RegExp(`^${name}: (.*)$`, 'im').exec(msg);
  return m ? m[1].trim() : '';
}

describe('buildMimeMessage', () => {
  it('addresses the message to the 3PL with the operators copied', () => {
    const msg = buildMimeMessage(BASE);
    expect(header(msg, 'From')).toBe('VCycene Fulfillment <reina@virgohome.io>');
    expect(header(msg, 'To')).toBe('cs@goorooship.ca');
    expect(header(msg, 'Cc')).toBe('huayi@virgohome.io');
  });

  it('omits the Cc header entirely when nobody is copied', () => {
    const msg = buildMimeMessage({ ...BASE, cc: [] });
    expect(msg).not.toMatch(/^Cc:/im);
  });

  it('encodes a subject with an em dash so it does not arrive as mojibake', () => {
    const msg = buildMimeMessage(BASE);
    const subject = header(msg, 'Subject');
    // A raw 8-bit subject line is not legal in a MIME header.
    expect(subject).not.toContain('—');
    expect(subject).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    const decoded = fromB64(subject.slice(10, -2));
    expect(decoded).toBe('Order confirmed — #1184 · LILA-P100X');
  });

  it('leaves a plain ASCII subject alone rather than encoding it needlessly', () => {
    const msg = buildMimeMessage({ ...BASE, subject: 'Order confirmed 1184' });
    expect(header(msg, 'Subject')).toBe('Order confirmed 1184');
  });

  it('carries the body as base64 UTF-8 that round-trips', () => {
    const msg = buildMimeMessage(BASE);
    const part = msg.split(/--[0-9a-zA-Z]+\r\n/)[1] ?? '';
    const body = part.split('\r\n\r\n')[1]?.replace(/\s/g, '') ?? '';
    expect(fromB64(body)).toBe(BASE.text);
  });

  it('attaches both PDFs under the names the 3PL should see', () => {
    const msg = buildMimeMessage(BASE);
    expect(msg).toContain('Content-Type: application/pdf; name="shipping-label-1184.pdf"');
    expect(msg).toContain('Content-Disposition: attachment; filename="shipping-label-1184.pdf"');
    expect(msg).toContain('Content-Type: application/pdf; name="packing-list-1184.pdf"');
    expect(msg).toContain('Content-Disposition: attachment; filename="packing-list-1184.pdf"');
    // Attachment bodies go in as-is; they are already base64 from the PDF writer.
    expect(msg.replace(/\r\n/g, '')).toContain(PDF_B64);
  });

  it('declares one multipart boundary and closes it', () => {
    const msg = buildMimeMessage(BASE);
    const b = /boundary="([^"]+)"/.exec(msg)?.[1] ?? '';
    expect(b).toBeTruthy();
    // 3 opening delimiters (body + 2 attachments) and one terminator.
    expect(msg.split(`--${b}\r\n`).length - 1).toBe(3);
    expect(msg.endsWith(`--${b}--\r\n`)).toBe(true);
  });

  it('wraps long base64 so no line breaks the 998-octet SMTP limit', () => {
    const long = { ...BASE, attachments: [{ ...BASE.attachments[0], base64: 'A'.repeat(5000) }] };
    const msg = buildMimeMessage(long);
    for (const line of msg.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
  });

  it('refuses a header value carrying a newline — no header injection', () => {
    // A crafted order_ref must not be able to add its own Bcc.
    expect(() => buildMimeMessage({ ...BASE, subject: 'x\r\nBcc: attacker@example.com' }))
      .not.toThrow();
    const msg = buildMimeMessage({ ...BASE, subject: 'x\r\nBcc: attacker@example.com' });
    expect(msg).not.toMatch(/^Bcc: attacker@example\.com$/im);
  });
});

describe('toBase64Url', () => {
  it('is url-safe and unpadded, as the Gmail raw field requires', () => {
    const out = toBase64Url('any+slash/and=padding?<>~');
    expect(out).not.toMatch(/[+/=]/);
  });

  it('round-trips through the standard decoder', () => {
    const text = 'Order confirmed — #1184 · LILA-P100X';
    const url = toBase64Url(text);
    const std = url.replace(/-/g, '+').replace(/_/g, '/');
    expect(fromB64(std)).toBe(text);
  });
});
