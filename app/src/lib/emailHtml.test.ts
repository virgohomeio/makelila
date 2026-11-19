import { describe, it, expect } from 'vitest';
// The helper the edge functions use, tested here because vitest's root is app/
// and nothing under supabase/functions is ever collected — same reason
// emailArchive.test.ts lives on this side of the tree.
import { textToEmailHtml, altTextFromUrl } from '../../../supabase/functions/_shared/emailHtml.ts';

describe('textToEmailHtml', () => {
  it('renders a lone image URL as an <img>, not a link', () => {
    const html = textToEmailHtml('Here is the guide:\n\nhttps://lila.vip/lovely-install-guide.png\n');
    expect(html).toContain('<img src="https://lila.vip/lovely-install-guide.png"');
    expect(html).not.toContain('<a href="https://lila.vip/lovely-install-guide.png"');
  });

  it('gives the image alt text drawn from its filename', () => {
    expect(altTextFromUrl('https://lila.vip/lovely-install-guide.png')).toBe('Lovely install guide');
    expect(altTextFromUrl('https://lila.vip/a/b/7f3c-91.png')).toBe('Image');
  });

  it('links an ordinary URL instead of embedding it', () => {
    const html = textToEmailHtml('Book here:\nhttps://calendly.com/lila-ed/intro-call');
    expect(html).toContain('<a href="https://calendly.com/lila-ed/intro-call"');
    expect(html).not.toContain('<img');
  });

  it('leaves an image URL mentioned mid-sentence as a link', () => {
    // Anchoring matters: an <img> swallowing the rest of the sentence would
    // silently drop text the operator wrote.
    const html = textToEmailHtml('See https://lila.vip/x.png for the guide.');
    expect(html).not.toContain('<img');
    expect(html).toContain('for the guide.');
  });

  it('does not link the full stop after a URL', () => {
    const html = textToEmailHtml('Go to https://lilalovely.io.');
    expect(html).toContain('>https://lilalovely.io</a>.');
  });

  it('escapes HTML the operator typed', () => {
    const html = textToEmailHtml('Tap the <Share> button & wait');
    expect(html).toContain('&lt;Share&gt; button &amp; wait');
  });

  it('keeps single newlines as line breaks and blank lines as paragraphs', () => {
    const html = textToEmailHtml('Carrier: UPS\nTracking: 1Z9\n\nThanks');
    expect(html).toContain('Carrier: UPS<br>Tracking: 1Z9');
    expect(html).toMatch(/<p[^>]*>Thanks<\/p>/);
  });

  it('emits no empty paragraphs for runs of blank lines', () => {
    expect(textToEmailHtml('a\n\n\n\nb')).not.toMatch(/<p[^>]*><\/p>/);
  });
});
