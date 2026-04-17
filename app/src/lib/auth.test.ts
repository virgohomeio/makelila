import { describe, it, expect } from 'vitest';
import { requireInternalDomain } from './auth';

describe('requireInternalDomain', () => {
  it('accepts @virgohome.io emails', () => {
    expect(requireInternalDomain('pedrum@virgohome.io')).toBe(true);
    expect(requireInternalDomain('HUAYI@virgohome.io')).toBe(true);
  });

  it('rejects other domains', () => {
    expect(requireInternalDomain('attacker@gmail.com')).toBe(false);
    expect(requireInternalDomain('fake@virgohome.com')).toBe(false);
    expect(requireInternalDomain('')).toBe(false);
  });
});
