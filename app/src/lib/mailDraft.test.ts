import { describe, it, expect } from 'vitest';
import { buildMailtoUrl, buildGmailComposeUrl, buildDraftUrl } from './mailDraft';

describe('buildMailtoUrl', () => {
  const url = (over: Partial<{ to: string; subject: string; body: string }> = {}) =>
    buildMailtoUrl({ to: 'sam@example.com', subject: 'Screening interview', body: 'Hi Sam', ...over });

  it('addresses the draft and carries subject and body', () => {
    const result = url();
    expect(result.startsWith('mailto:sam%40example.com?')).toBe(true);
    expect(result).toContain('subject=Screening%20interview');
    expect(result).toContain('body=Hi%20Sam');
  });

  it('percent-encodes spaces rather than using +, which mail clients show literally', () => {
    expect(url({ subject: 'a b' })).not.toContain('+');
  });

  it('normalizes body newlines to CRLF so Outlook keeps the line breaks', () => {
    const result = url({ body: 'line one\nline two' });
    expect(result).toContain('line%20one%0D%0Aline%20two');
  });

  it('leaves an already-CRLF body alone instead of doubling the returns', () => {
    const result = url({ body: 'line one\r\nline two' });
    expect(result).toContain('line%20one%0D%0Aline%20two');
    expect(result).not.toContain('%0D%0D');
  });

  it('encodes a scheduling URL in the body without mangling its query string', () => {
    const result = url({ body: 'Book here: https://calendly.com/huayi/screen?month=2026-08' });
    expect(decodeURIComponent(result.split('body=')[1])).toBe(
      'Book here: https://calendly.com/huayi/screen?month=2026-08'
    );
  });

  it('encodes an Indeed relay address, plus sign and all', () => {
    expect(url({ to: 'relay+sam@indeedemail.com' })).toContain('mailto:relay%2Bsam%40indeedemail.com');
  });
});

describe('buildGmailComposeUrl', () => {
  const url = (over: Partial<{ from: string; to: string; subject: string; body: string }> = {}) =>
    buildGmailComposeUrl({
      from: 'huayi@virgohome.io', to: 'sam@example.com',
      subject: 'Screening interview', body: 'Hi Sam', ...over,
    });

  it('pins the sending account to the operator org address', () => {
    expect(url()).toContain('authuser=huayi%40virgohome.io');
  });

  it('opens a compose window addressed to the candidate', () => {
    const result = url();
    expect(result.startsWith('https://mail.google.com/mail/?')).toBe(true);
    expect(result).toContain('view=cm');
    expect(result).toContain('to=sam%40example.com');
    expect(result).toContain('su=Screening%20interview');
  });

  it('percent-encodes spaces rather than using +, which would reach Gmail as a literal plus', () => {
    expect(url({ subject: 'a b', body: 'c d' })).not.toContain('+');
  });

  it('keeps a scheduling link intact in the body', () => {
    const result = url({ body: 'Book here: https://calendly.com/huayi/screen?month=2026-08' });
    expect(new URL(result).searchParams.get('body')).toBe(
      'Book here: https://calendly.com/huayi/screen?month=2026-08'
    );
  });

  it('encodes an Indeed relay address, plus sign and all', () => {
    expect(new URL(url({ to: 'relay+sam@indeedemail.com' })).searchParams.get('to'))
      .toBe('relay+sam@indeedemail.com');
  });
});

describe('buildDraftUrl', () => {
  const draft = { to: 'sam@example.com', subject: 'Screening interview', body: 'Hi Sam' };

  it('composes in Gmail under the operator account when the address is known', () => {
    const result = buildDraftUrl({ from: 'huayi@virgohome.io', ...draft });
    expect(result.kind).toBe('gmail');
    expect(result.url).toContain('authuser=huayi%40virgohome.io');
  });

  // AuthProvider notes user.email can be transiently undefined on a session
  // that hasn't fully populated; a draft is still better than a dead button.
  it('falls back to a mailto draft when the session has no email yet', () => {
    expect(buildDraftUrl({ from: null, ...draft }).kind).toBe('mailto');
    expect(buildDraftUrl({ from: undefined, ...draft }).url.startsWith('mailto:')).toBe(true);
  });
});
