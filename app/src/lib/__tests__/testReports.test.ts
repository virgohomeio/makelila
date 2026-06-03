import { describe, it, expect } from 'vitest';
import { parseTestReport, serialFromFilename } from '../testReports';

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
});

describe('serialFromFilename', () => {
  it('strips the .md extension', () => {
    expect(serialFromFilename('LL01-00000000332.md')).toBe('LL01-00000000332');
  });
});
