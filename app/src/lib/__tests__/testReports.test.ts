import { describe, it, expect } from 'vitest';
import { parseTestReport, serialFromFilename, normalizeMac } from '../testReports';

const SAMPLE_FAIL = `# VCycene LILA Test Report

**Serial Number:** LL01-00000000332
**MAC ID:** 98:a3:16:a6:97:b0

### Test Left Motor: FAIL
### Test Right Motor: FAIL

## Summary

- Total Tests: 13
- Passed: 11
- Failed: 2
`;

const SAMPLE_PASS = `**Serial Number:** LL01-00000000019

## Summary
- Total Tests: 13
- Passed: 13
- Failed: 0
`;

describe('parseTestReport', () => {
  it('parses serial + fail result from the summary', () => {
    const r = parseTestReport(SAMPLE_FAIL);
    expect(r.serial).toBe('LL01-00000000332');
    expect(r.result).toBe('fail');
    expect(r.passed).toBe(11);
    expect(r.failed).toBe(2);
    expect(r.failedTests).toEqual(['Left Motor', 'Right Motor']);
  });

  it('parses a passing report', () => {
    const r = parseTestReport(SAMPLE_PASS);
    expect(r.serial).toBe('LL01-00000000019');
    expect(r.result).toBe('pass');
    expect(r.failed).toBe(0);
  });

  it('returns incomplete when no summary is present', () => {
    expect(parseTestReport('no summary here').result).toBe('incomplete');
  });

  describe('MAC ID line', () => {
    it('reads the bold "**MAC ID:**" line the test script writes', () => {
      expect(parseTestReport(SAMPLE_FAIL).mac).toBe('98:a3:16:a6:97:b0');
    });

    it('normalises an uppercase MAC to lowercase', () => {
      expect(parseTestReport('**MAC ID:** 98:A3:16:A6:97:B0').mac).toBe('98:a3:16:a6:97:b0');
    });

    it('accepts a plain "MAC ID:" label and a "MAC Address:" label', () => {
      expect(parseTestReport('MAC ID: 98:a3:16:a6:97:b0').mac).toBe('98:a3:16:a6:97:b0');
      expect(parseTestReport('**MAC Address:** 98:a3:16:a6:97:b0').mac).toBe('98:a3:16:a6:97:b0');
    });

    it('accepts dash-separated octets and stores them colon-separated', () => {
      expect(parseTestReport('**MAC ID:** 98-A3-16-A6-97-B0').mac).toBe('98:a3:16:a6:97:b0');
    });

    it('is null when the report has no MAC line', () => {
      expect(parseTestReport(SAMPLE_PASS).mac).toBeNull();
    });

    it('is null when the MAC line is garbled, and the rest still parses', () => {
      const r = parseTestReport('**Serial Number:** LL01-00000000019\n**MAC ID:** not-a-mac\n- Failed: 0\n');
      expect(r.mac).toBeNull();
      expect(r.serial).toBe('LL01-00000000019');
      expect(r.result).toBe('pass');
    });
  });
});

describe('normalizeMac', () => {
  it('lowercases and keeps colon form', () => {
    expect(normalizeMac('98:A3:16:A6:97:B0')).toBe('98:a3:16:a6:97:b0');
  });

  it('converts dash separators to colons', () => {
    expect(normalizeMac('98-a3-16-a6-97-b0')).toBe('98:a3:16:a6:97:b0');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeMac('  98:a3:16:a6:97:b0\n')).toBe('98:a3:16:a6:97:b0');
  });

  it('rejects five octets', () => {
    expect(normalizeMac('98:a3:16:a6:97')).toBeNull();
  });

  it('rejects non-hex characters', () => {
    expect(normalizeMac('98:a3:16:a6:97:zz')).toBeNull();
  });

  it('rejects empty, null and undefined', () => {
    expect(normalizeMac('')).toBeNull();
    expect(normalizeMac('   ')).toBeNull();
    expect(normalizeMac(null)).toBeNull();
    expect(normalizeMac(undefined)).toBeNull();
  });
});

describe('serialFromFilename', () => {
  it('strips the .md extension', () => {
    expect(serialFromFilename('LL01-00000000332.md')).toBe('LL01-00000000332');
  });
});
