import { describe, it, expect } from 'vitest';
import { parseUtm } from './customers';

describe('parseUtm', () => {
  it('extracts utm_source and utm_campaign from a URL', () => {
    expect(
      parseUtm('https://lila.vip/?utm_source=facebook&utm_campaign=spring-2026-q1&fbclid=abc'),
    ).toEqual({ source: 'facebook', campaign: 'spring-2026-q1' });
  });

  it('returns shopify_direct when no UTM params are present', () => {
    expect(parseUtm('https://lila.vip/')).toEqual({ source: 'shopify_direct', campaign: null });
  });

  it('returns null for both on empty / null input', () => {
    expect(parseUtm('')).toEqual({ source: null, campaign: null });
    expect(parseUtm(null)).toEqual({ source: null, campaign: null });
  });

  it('handles malformed URL gracefully', () => {
    expect(parseUtm('not a url %^&')).toEqual({ source: null, campaign: null });
  });

  it('returns utm_source only when utm_campaign is absent', () => {
    expect(parseUtm('https://lila.vip/?utm_source=google')).toEqual({
      source: 'google',
      campaign: null,
    });
  });
});
