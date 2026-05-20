import { describe, it, expect } from 'vitest';
import { parseQuoSubject, parseFromHeader, normalizePhone } from '../quo-parsers';

describe('parseQuoSubject — Quo SMS forwarding formats', () => {
  it('extracts name + phone from "New text message from <name> <phone>"', () => {
    expect(parseQuoSubject('New text message from RJ Down (813) 492-5113'))
      .toEqual({ kind: 'sms', name: 'RJ Down', phone: '(813) 492-5113' });
  });

  it('extracts name + phone from "Missed call from <name> <phone>"', () => {
    expect(parseQuoSubject('Missed call from RJ Down (813) 492-5113'))
      .toEqual({ kind: 'missed_call', name: 'RJ Down', phone: '(813) 492-5113' });
  });

  it('handles missing name: "New text message from <phone>"', () => {
    expect(parseQuoSubject('New text message from (813) 492-5113'))
      .toEqual({ kind: 'sms', name: null, phone: '(813) 492-5113' });
  });

  it('handles missing name: "Missed call from <phone>"', () => {
    expect(parseQuoSubject('Missed call from (813) 492-5113'))
      .toEqual({ kind: 'missed_call', name: null, phone: '(813) 492-5113' });
  });

  it('tolerates a hyphen-less phone in the 4-digit suffix', () => {
    expect(parseQuoSubject('New text message from Alice (415) 555 1212'))
      .toEqual({ kind: 'sms', name: 'Alice', phone: '(415) 555 1212' });
  });

  it('handles multi-word names with apostrophes', () => {
    expect(parseQuoSubject("New text message from Mary O'Brien (212) 555-9999"))
      .toEqual({ kind: 'sms', name: "Mary O'Brien", phone: '(212) 555-9999' });
  });

  it('is case-insensitive on the prefix', () => {
    expect(parseQuoSubject('NEW TEXT MESSAGE from Bob (415) 555-0000').kind).toBe('sms');
    expect(parseQuoSubject('MISSED CALL from Bob (415) 555-0000').kind).toBe('missed_call');
  });

  it('returns nulls when the subject is not a Quo forward', () => {
    expect(parseQuoSubject('Re: refund status'))
      .toEqual({ kind: null, name: null, phone: null });
    expect(parseQuoSubject('Order #1234 shipped'))
      .toEqual({ kind: null, name: null, phone: null });
    expect(parseQuoSubject(''))
      .toEqual({ kind: null, name: null, phone: null });
  });

  it('does not match phone formats outside (NXX) NXX-NNNN', () => {
    expect(parseQuoSubject('New text message from Alice 415-555-1212').kind).toBeNull();
    expect(parseQuoSubject('New text message from Alice +14155551212').kind).toBeNull();
  });
});

describe('parseFromHeader — RFC 5322 variants', () => {
  it('parses "Name <email>"', () => {
    expect(parseFromHeader('Reina <reina@virgohome.io>'))
      .toEqual({ name: 'Reina', email: 'reina@virgohome.io' });
  });

  it('parses quoted display name', () => {
    expect(parseFromHeader('"Reina Del" <reina@virgohome.io>'))
      .toEqual({ name: 'Reina Del', email: 'reina@virgohome.io' });
  });

  it('parses bare email', () => {
    expect(parseFromHeader('quo@quo.com'))
      .toEqual({ name: null, email: 'quo@quo.com' });
  });

  it('parses bare email in angle brackets only', () => {
    expect(parseFromHeader('<quo@quo.com>'))
      .toEqual({ name: null, email: 'quo@quo.com' });
  });

  it('lowercases the email', () => {
    expect(parseFromHeader('Customer <Customer@Example.COM>'))
      .toEqual({ name: 'Customer', email: 'customer@example.com' });
  });

  it('returns nulls on empty input', () => {
    expect(parseFromHeader(''))
      .toEqual({ name: null, email: null });
  });

  it('strips surrounding whitespace from the name', () => {
    expect(parseFromHeader('   Spaced Name    <a@b.co>   '))
      .toEqual({ name: 'Spaced Name', email: 'a@b.co' });
  });
});

describe('normalizePhone — E.164 for US/CA only', () => {
  it('converts (NXX) NXX-NNNN → +1NXXNXXNNNN', () => {
    expect(normalizePhone('(813) 492-5113')).toBe('+18134925113');
  });

  it('strips spaces and dashes', () => {
    expect(normalizePhone('415-555 1212')).toBe('+14155551212');
    expect(normalizePhone('415 555 1212')).toBe('+14155551212');
  });

  it('keeps existing 11-digit numbers starting with 1', () => {
    expect(normalizePhone('1-415-555-1212')).toBe('+14155551212');
    expect(normalizePhone('+1 (415) 555-1212')).toBe('+14155551212');
  });

  it('passes through international numbers unchanged', () => {
    expect(normalizePhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
    expect(normalizePhone('+33 1 23 45 67 89')).toBe('+33 1 23 45 67 89');
  });

  it('returns null on empty input', () => {
    expect(normalizePhone('')).toBeNull();
  });

  it('passes through unparseable junk unchanged', () => {
    // Out of US/CA shape; we don't pretend to normalize it.
    expect(normalizePhone('555')).toBe('555');
    expect(normalizePhone('not a phone')).toBe('not a phone');
  });
});
