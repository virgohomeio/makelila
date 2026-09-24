import { describe, it, expect } from 'vitest';
// The helper the edge functions use, tested here because vitest's root is
// app/ and nothing under supabase/functions is ever collected — the four
// .test.ts files already sitting in _shared/ have never run.
import { archiveBcc, DEFAULT_ARCHIVE_BCC } from '../../../supabase/functions/_shared/emailArchive.ts';

describe('archiveBcc', () => {
  it('copies a customer send to the archive address', () => {
    expect(archiveBcc('juanitawells7@hotmail.com')).toEqual(['reina@virgohome.io']);
  });

  it('defaults to Reina', () => {
    expect(DEFAULT_ARCHIVE_BCC).toBe('reina@virgohome.io');
  });

  it('copies when any one recipient is external', () => {
    expect(archiveBcc(['ops@virgohome.io', 'customer@example.com'])).toEqual(['reina@virgohome.io']);
  });

  // Operator digests and internal alerts are not customer mail.
  it('skips a send that is entirely internal', () => {
    expect(archiveBcc(['pedrum@virgohome.io', 'yueli@virgohome.io'])).toBeUndefined();
  });

  it('skips a send already addressed to the archive address', () => {
    expect(archiveBcc('reina@virgohome.io')).toBeUndefined();
    expect(archiveBcc(['Reina@Virgohome.IO'])).toBeUndefined();
  });

  it('is case- and whitespace-insensitive about the internal domain', () => {
    expect(archiveBcc([' George@VirgoHome.io '])).toBeUndefined();
  });

  it('returns nothing when there is no recipient', () => {
    expect(archiveBcc([])).toBeUndefined();
    expect(archiveBcc(null)).toBeUndefined();
    expect(archiveBcc([''])).toBeUndefined();
  });

  // An empty EMAIL_ARCHIVE_BCC is how the copy gets turned off.
  it('returns nothing when the archive address is blank', () => {
    expect(archiveBcc('customer@example.com', '')).toBeUndefined();
    expect(archiveBcc('customer@example.com', '   ')).toBeUndefined();
    expect(archiveBcc('customer@example.com', null)).toBeUndefined();
  });

  it('honours an overridden archive address', () => {
    expect(archiveBcc('customer@example.com', 'ops@virgohome.io')).toEqual(['ops@virgohome.io']);
  });
});
