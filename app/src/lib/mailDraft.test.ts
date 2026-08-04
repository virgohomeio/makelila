import { describe, it, expect } from 'vitest';
import { buildMailtoUrl } from './mailDraft';

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
