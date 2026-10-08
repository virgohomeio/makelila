# Test-Report MAC Capture + Duplicate Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every electrical test report uploaded in Stock records the ESP32 MAC on its unit, and any MAC that appears on more than one unit is flagged at upload time and in the Stock table until someone corrects it.

**Architecture:** One new nullable column, `units.mac_address`. The report parser gains a MAC field; the bulk uploader writes it and warns when the MAC already belongs to a different serial (in the database or earlier in the same drop). "Duplicate" is derived in the app from the loaded units list by a pure helper, so there is no flag column to go stale. The Units tab passes a MAC-owner map to the uploader and a duplicate map to the table; the table shows a DUP MAC pill and the QC modal gets an editable MAC field.

**Tech Stack:** React 18 + TypeScript, Vite, Supabase (Postgres + Storage), CSS Modules, Vitest + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-10-08-test-report-mac-uniqueness-design.md`

## Global Constraints

- Branch: `feat/test-report-mac-uniqueness` (already cut from `origin/main`; the spec is committed on it).
- All commands run from `app/` unless stated. Vitest needs the Supabase env vars inline or ~48 files fail at import:

  ```bash
  VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npx vitest run <file>
  ```

  Dummy values are fine; nothing connects. Judge a run green only with both vars set.
- Duplicates never block pairing. A clash is a warning plus a visible flag, not an error.
- A report with no MAC line leaves `mac_address` untouched (never writes null over a known MAC).
- MACs are stored normalised: lowercase, colon-separated, `xx:xx:xx:xx:xx:xx`.
- No DB unique constraint, no trigger, no backfill of old reports.
- Components never import `supabase` directly; data access stays in `app/src/lib/`.
- CSS Modules only. The one inline-style pattern already used by `QcChip` (colours from `QC_CHECK_META`) is the only inline styling allowed.
- Commit after each task with the message given. **Do not push and do not apply the migration to the shared database** — the repo owner does both.
- Every commit message ends with the line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Write the message to a file and use `git commit -F` (heredocs inside `$(...)` break in this Git Bash).

## File Map

| File | Change |
|---|---|
| `supabase/migrations/20261008120000_units_mac_address.sql` | **Create.** Adds `units.mac_address` + partial index. |
| `app/src/lib/testReports.ts` | `normalizeMac`, `ParsedTestReport.mac`, MAC line in `parseTestReport`, `macOwners` param + clash detection + `mac_address` write in `uploadTestReports`, `UploadOutcome.mac`/`macClash`. |
| `app/src/lib/__tests__/testReports.test.ts` | Parser + `normalizeMac` cases. |
| `app/src/lib/testReports.upload.test.ts` | **Create.** `uploadTestReports` clash cases with Supabase mocked. |
| `app/src/lib/stock.ts` | `Unit.mac_address`, `'mac_address'` in `updateUnitFields` pick, `findMacDuplicates`. |
| `app/src/lib/stock.test.ts` | `findMacDuplicates` cases. |
| `app/src/modules/Stock/TestReportUploader.tsx` | `macOwners` prop, warning list. |
| `app/src/modules/Stock/__tests__/TestReportUploader.test.tsx` | **Create.** Warning list renders from outcomes. |
| `app/src/modules/Stock/UnitsTab.tsx` | Build `macOwners` + `macDupes`, pass them down, MAC in search. |
| `app/src/modules/Stock/UnitTable.tsx` | `macDupes` prop, DUP MAC pill, MAC field + helper text in `QcEditorModal`. |
| `app/src/modules/Stock/__tests__/UnitTable.test.tsx` | **Create.** Pill + modal field + invalid-MAC rejection. |
| `app/src/modules/Stock/Stock.module.css` | `.reportWarnings`, `.reportWarningQuiet`, `.qcDupMac`, `.modalHelp`. |

---

### Task 1: Migration — `units.mac_address`

**Files:**
- Create: `supabase/migrations/20261008120000_units_mac_address.sql`

- [ ] **Step 1: Write the migration**

```sql
-- ESP32 MAC parsed from the uploaded electrical test report (lib/testReports.ts
-- uploadTestReports) or typed into the Stock QC modal. Stored normalised as
-- lowercase "xx:xx:xx:xx:xx:xx".
--
-- Deliberately NOT unique: a board salvaged from a scrapped unit may
-- legitimately reappear in another, and the operator clears the old unit's
-- MAC by hand. Duplicate detection is derived in the app from the loaded units
-- list (lib/stock.ts findMacDuplicates), so there is no flag column to go stale.
alter table public.units
  add column if not exists mac_address text;

create index if not exists idx_units_mac_address
  on public.units (mac_address)
  where mac_address is not null;
```

- [ ] **Step 2: Sanity-check the SQL parses**

Run from the repo root:

```bash
grep -c "mac_address" supabase/migrations/20261008120000_units_mac_address.sql
```

Expected: `4`

- [ ] **Step 3: Commit**

Run from the repo root:

```bash
printf '%s\n' "feat(stock): units.mac_address column for ESP32 MAC from test reports" "" "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" > "$TEMP/msg.txt"
git add supabase/migrations/20261008120000_units_mac_address.sql
git commit -q -F "$TEMP/msg.txt" && git log --oneline -1
```

---

### Task 2: `normalizeMac` + MAC in `parseTestReport`

**Files:**
- Modify: `app/src/lib/testReports.ts:7-45` (`ParsedTestReport`, `parseTestReport`)
- Test: `app/src/lib/__tests__/testReports.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the whole of `app/src/lib/__tests__/testReports.test.ts` with:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npx vitest run src/lib/__tests__/testReports.test.ts
```

Expected: FAIL. The `normalizeMac` import is undefined (`TypeError: normalizeMac is not a function`) and the `MAC ID line` cases fail because `parseTestReport(...).mac` is `undefined`.

- [ ] **Step 3: Implement `normalizeMac` and the MAC field**

In `app/src/lib/testReports.ts`, replace the block from `export type ParsedTestReport = {` through the end of `parseTestReport` (currently lines 7–45) with:

```ts
export type ParsedTestReport = {
  serial: string | null;
  mac: string | null;     // ESP32 MAC from the "MAC ID:" line, normalised; null when absent/garbled
  result: QcCheck;     // 'pass' | 'fail' | 'incomplete'
  passed: number | null;
  failed: number | null;
  failedTests: string[];  // e.g. ['Left Motor', 'Right Motor']
};

/** Canonical form for an ESP32 MAC: lowercase, colon-separated, six hex
 *  octets. Accepts ":" or "-" separators and any case; anything else (five
 *  octets, non-hex, empty) is null so a typo never lands in units.mac_address
 *  and silently fails to match the next report for the same board. */
export function normalizeMac(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.trim().match(
    /^([0-9a-f]{2})[:-]([0-9a-f]{2})[:-]([0-9a-f]{2})[:-]([0-9a-f]{2})[:-]([0-9a-f]{2})[:-]([0-9a-f]{2})$/i,
  );
  if (!m) return null;
  return m.slice(1, 7).map(o => o.toLowerCase()).join(':');
}

/** Parse a test-script .md report. Serial comes from the "Serial Number:" line,
 *  the MAC from the "MAC ID:" line right under it; the overall result comes
 *  from the Summary "Failed:" count (any failure → fail, no parseable summary →
 *  incomplete). We intentionally only read the summary — the per-test
 *  breakdown lives in the stored file. */
export function parseTestReport(text: string): ParsedTestReport {
  const serialMatch = text.match(/Serial Number:\**\s*([A-Za-z0-9-]+)/i);
  // Label tolerance mirrors the serial line: "**MAC ID:**", "MAC ID:",
  // "**MAC Address:**" all match. The value is validated by normalizeMac.
  const macMatch = text.match(/MAC(?:\s+(?:ID|Address))?\**:\**\s*([0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5})\b/i);
  const passedMatch = text.match(/Passed:\s*(\d+)/i);
  const failedMatch = text.match(/Failed:\s*(\d+)/i);

  const passed = passedMatch ? Number(passedMatch[1]) : null;
  const failed = failedMatch ? Number(failedMatch[1]) : null;

  // Per-test failures: heading lines like "### Test Left Motor: <x> FAIL".
  const failedTests: string[] = [];
  const re = /^#{1,6}\s+(.+?):[^\n]*\bFAIL\b/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    failedTests.push(m[1].replace(/^Test\s+/i, '').trim());
  }

  let result: QcCheck;
  if (failed == null) result = 'incomplete';
  else if (failed > 0) result = 'fail';
  else result = 'pass';

  return {
    serial: serialMatch ? serialMatch[1] : null,
    mac: normalizeMac(macMatch ? macMatch[1] : null),
    result, passed, failed, failedTests,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npx vitest run src/lib/__tests__/testReports.test.ts
```

Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
printf '%s\n' "feat(stock): parse the ESP32 MAC ID line from electrical test reports" "" "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" > "$TEMP/msg.txt"
git add src/lib/testReports.ts src/lib/__tests__/testReports.test.ts
git commit -q -F "$TEMP/msg.txt" && git log --oneline -1
```

---

### Task 3: `Unit.mac_address` + `findMacDuplicates`

**Files:**
- Modify: `app/src/lib/stock.ts:86-125` (`Unit` type), `app/src/lib/stock.ts:304-316` (`updateUnitFields`)
- Test: `app/src/lib/stock.test.ts`

- [ ] **Step 1: Write the failing tests**

In `app/src/lib/stock.test.ts`, change the import block (currently lines 57–60) to also pull in `findMacDuplicates`:

```ts
import {
  updateUnitStatus, mergeTimelineEvents, createBatch, isStockManager, findMacDuplicates,
  type TimelineEvent,
} from './stock';
```

Then append at the end of the file:

```ts
describe('findMacDuplicates', () => {
  const u = (serial: string, mac: string | null) => ({ serial, mac_address: mac });

  it('is empty when every MAC is unique', () => {
    const r = findMacDuplicates([u('LL01-A', '98:a3:16:a6:97:b0'), u('LL01-B', '98:a3:16:a6:97:b1')]);
    expect(r.size).toBe(0);
  });

  it('lists each of two sharing units under the other', () => {
    const r = findMacDuplicates([u('LL01-A', '98:a3:16:a6:97:b0'), u('LL01-B', '98:a3:16:a6:97:b0')]);
    expect(r.get('LL01-A')).toEqual(['LL01-B']);
    expect(r.get('LL01-B')).toEqual(['LL01-A']);
  });

  it('lists the other two for each of three sharing units', () => {
    const mac = '98:a3:16:a6:97:b0';
    const r = findMacDuplicates([u('LL01-A', mac), u('LL01-B', mac), u('LL01-C', mac)]);
    expect(r.get('LL01-A')).toEqual(['LL01-B', 'LL01-C']);
    expect(r.get('LL01-B')).toEqual(['LL01-A', 'LL01-C']);
    expect(r.get('LL01-C')).toEqual(['LL01-A', 'LL01-B']);
  });

  it('ignores units with no MAC', () => {
    const r = findMacDuplicates([u('LL01-A', null), u('LL01-B', null), u('LL01-C', '98:a3:16:a6:97:b0')]);
    expect(r.size).toBe(0);
  });

  it('does not flag a unit that only shares a MAC with itself', () => {
    const r = findMacDuplicates([u('LL01-A', '98:a3:16:a6:97:b0')]);
    expect(r.has('LL01-A')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npx vitest run src/lib/stock.test.ts
```

Expected: FAIL with `TypeError: findMacDuplicates is not a function` in the five new cases; all pre-existing suites still pass.

- [ ] **Step 3: Add the field, the pick entry, and the helper**

In `app/src/lib/stock.ts`, inside `export type Unit = {`, directly after the line
`  test_report_uploaded_at: string | null;` add:

```ts
  // ESP32 MAC from the uploaded test report (or typed in the QC modal),
  // normalised "xx:xx:xx:xx:xx:xx". Null until a report with a MAC line is
  // uploaded. Not unique at the DB level — see findMacDuplicates.
  mac_address: string | null;
```

In `updateUnitFields`, change the `Pick<>` union so the last line reads:

```ts
    'technician' | 'electrical_check' | 'mechanical_check' | 'defect_notes' | 'mac_address'
```

Directly **above** `export async function updateUnitFields(` add:

```ts
/** serial → the other serials holding the same mac_address.
 *
 *  Duplicate MACs are derived, not stored: the only column is
 *  units.mac_address, and "duplicate" simply means another unit holds the same
 *  value. Correcting or clearing the MAC on either unit clears the flag on both,
 *  so nothing can go stale and there is nothing to dismiss. Units with no MAC
 *  are never in the map; the map is empty when every MAC is unique. */
export function findMacDuplicates(
  units: Pick<Unit, 'serial' | 'mac_address'>[],
): Map<string, string[]> {
  const byMac = new Map<string, string[]>();
  for (const u of units) {
    if (!u.mac_address) continue;
    const list = byMac.get(u.mac_address);
    if (list) list.push(u.serial);
    else byMac.set(u.mac_address, [u.serial]);
  }
  const out = new Map<string, string[]>();
  for (const serials of byMac.values()) {
    if (serials.length < 2) continue;
    for (const s of serials) out.set(s, serials.filter(o => o !== s));
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npx vitest run src/lib/stock.test.ts
```

Expected: PASS, every suite including the five new `findMacDuplicates` cases.

- [ ] **Step 5: Type-check the app**

```bash
npx tsc -b
```

Expected: no output (exit 0). If any test fixture builds a full `Unit` literal, it now needs `mac_address: null`; add it where tsc complains.

- [ ] **Step 6: Commit**

```bash
printf '%s\n' "feat(stock): Unit.mac_address + findMacDuplicates" "" "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" > "$TEMP/msg.txt"
git add src/lib/stock.ts src/lib/stock.test.ts
git commit -q -F "$TEMP/msg.txt" && git log --oneline -1
```

---

### Task 4: `uploadTestReports` writes the MAC and detects clashes

**Files:**
- Modify: `app/src/lib/testReports.ts` (`UploadOutcome`, `uploadTestReports`)
- Create: `app/src/lib/testReports.upload.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/testReports.upload.test.ts`:

```ts
// uploadTestReports: the MAC from each report is written to the unit, and a
// MAC that already belongs to a different serial — in the database or earlier
// in the same drop — is reported as a clash. Pairing is never blocked by a
// clash; it is a warning for the operator, not an error.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { uploadMock, updateMock, eqMock, logActionMock } = vi.hoisted(() => {
  const uploadMock = vi.fn(() => Promise.resolve({ error: null }));
  const eqMock = vi.fn(() => Promise.resolve({ error: null }));
  const updateMock = vi.fn(() => ({ eq: eqMock }));
  const logActionMock = vi.fn(() => Promise.resolve());
  return { uploadMock, updateMock, eqMock, logActionMock };
});

vi.mock('./supabase', () => ({
  supabase: {
    storage: { from: () => ({ upload: uploadMock }) },
    from: () => ({ update: updateMock }),
  },
}));
vi.mock('./activityLog', () => ({ logAction: logActionMock }));

import { uploadTestReports } from './testReports';

const MAC = '98:a3:16:a6:97:b0';

const report = (serial: string, mac?: string) => new File(
  [
    `# VCycene LILA Test Report\n\n**Serial Number:** ${serial}\n` +
    (mac ? `**MAC ID:** ${mac}\n` : '') +
    `\n## Summary\n- Total Tests: 13\n- Passed: 13\n- Failed: 0\n`,
  ],
  `${serial}.md`,
  { type: 'text/markdown' },
);

const patchFor = (serial: string): Record<string, unknown> => {
  const i = eqMock.mock.calls.findIndex(c => c[0] === 'serial' && c[1] === serial);
  if (i < 0) throw new Error(`no units update for ${serial}`);
  return updateMock.mock.calls[i][0] as Record<string, unknown>;
};

const valid = new Set(['LL01-A', 'LL01-B']);

describe('uploadTestReports — MAC capture', () => {
  beforeEach(() => {
    uploadMock.mockClear(); updateMock.mockClear(); eqMock.mockClear(); logActionMock.mockClear();
  });

  it('writes the normalised MAC to the unit and records it in the activity log', async () => {
    const out = await uploadTestReports([report('LL01-A', '98:A3:16:A6:97:B0')], valid, new Map());
    expect(out[0]).toMatchObject({ serial: 'LL01-A', status: 'paired', result: 'pass', mac: MAC });
    expect(out[0].macClash).toBeUndefined();
    expect(patchFor('LL01-A')).toMatchObject({ mac_address: MAC, electrical_check: 'pass' });
    expect(logActionMock).toHaveBeenCalledWith('unit_test_report', 'LL01-A', `pass mac=${MAC}`);
  });

  it('leaves mac_address untouched when the report has no MAC line', async () => {
    const out = await uploadTestReports([report('LL01-A')], valid, new Map());
    expect(out[0]).toMatchObject({ status: 'paired', mac: null });
    expect(out[0].macClash).toBeUndefined();
    expect(patchFor('LL01-A')).not.toHaveProperty('mac_address');
    expect(logActionMock).toHaveBeenCalledWith('unit_test_report', 'LL01-A', 'pass');
  });

  it('still pairs, but reports a clash, when the MAC already belongs to another serial', async () => {
    const owners = new Map([[MAC, 'LL01-A']]);
    const out = await uploadTestReports([report('LL01-B', MAC)], valid, owners);
    expect(out[0]).toMatchObject({ serial: 'LL01-B', status: 'paired', mac: MAC, macClash: 'LL01-A' });
    expect(patchFor('LL01-B')).toMatchObject({ mac_address: MAC });
    expect(logActionMock).toHaveBeenCalledWith(
      'unit_mac_duplicate', 'LL01-B', `mac=${MAC} also on LL01-A`,
      { entityType: 'unit', unitSerial: 'LL01-B' },
    );
  });

  it('is not a clash when the same serial re-uploads the same MAC', async () => {
    const owners = new Map([[MAC, 'LL01-A']]);
    const out = await uploadTestReports([report('LL01-A', MAC)], valid, owners);
    expect(out[0].macClash).toBeUndefined();
    expect(logActionMock).not.toHaveBeenCalledWith('unit_mac_duplicate', expect.anything(), expect.anything(), expect.anything());
  });

  it('catches two files in one drop that carry the same MAC under different serials', async () => {
    const out = await uploadTestReports([report('LL01-A', MAC), report('LL01-B', MAC)], valid, new Map());
    expect(out[0].macClash).toBeUndefined();
    expect(out[1]).toMatchObject({ serial: 'LL01-B', status: 'paired', macClash: 'LL01-A' });
  });

  it('does not treat a failed write as a seen MAC for later files', async () => {
    eqMock.mockImplementationOnce(() => Promise.resolve({ error: { message: 'boom' } }));
    const out = await uploadTestReports([report('LL01-A', MAC), report('LL01-B', MAC)], valid, new Map());
    expect(out[0].status).toBe('error');
    expect(out[1].macClash).toBeUndefined();
  });

  it('still skips files whose serial is not a known unit', async () => {
    const out = await uploadTestReports([report('LL01-Z', MAC)], valid, new Map());
    expect(out[0].status).toBe('unmatched');
    expect(updateMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npx vitest run src/lib/testReports.upload.test.ts
```

Expected: FAIL. The "writes the normalised MAC" case fails because the patch has no `mac_address`; the clash cases fail because `macClash` is undefined; the "no MAC line" case passes by accident. (TypeScript will also complain about the third argument; vitest still runs.)

- [ ] **Step 3: Implement the MAC write and clash detection**

In `app/src/lib/testReports.ts`, replace the block from `export type UploadOutcome = {` through the closing `}` of `uploadTestReports` with:

```ts
export type UploadOutcome = {
  fileName: string;
  serial: string;
  status: 'paired' | 'unmatched' | 'error';
  result?: QcCheck;
  message?: string;
  mac?: string | null;     // normalised MAC from the report; null when the report has none
  macClash?: string;       // the other serial that already holds this MAC (paired anyway)
};

/** The other serial already holding `mac`, or undefined when the MAC is new
 *  or belongs to this same unit (a re-upload). Units already in the database
 *  are checked first, then files paired earlier in this same drop. */
function macClashFor(
  mac: string,
  serial: string,
  macOwners: Map<string, string>,
  seenThisDrop: Map<string, string>,
): string | undefined {
  for (const owner of [macOwners.get(mac), seenThisDrop.get(mac)]) {
    if (owner && owner !== serial) return owner;
  }
  return undefined;
}

/** Bulk-upload .md test reports. Each file is paired to a unit by serial
 *  (in-file "Serial Number", falling back to the filename). Files whose serial
 *  isn't a known unit are reported as 'unmatched' and skipped.
 *
 *  `macOwners` is mac_address → serial for every unit already carrying a MAC
 *  (the Units tab builds it from the loaded units, so no extra round trip). A
 *  MAC that already belongs to a *different* serial is a clash: the file is
 *  still paired and the MAC still written — the same ESP32 showing up under two
 *  serials is a labelling problem for the operator to sort out, not a reason to
 *  drop the test result — but the outcome carries `macClash` so the uploader
 *  can warn, and an activity-log entry records it. A report with no MAC line
 *  leaves the unit's existing MAC alone. */
export async function uploadTestReports(
  files: File[],
  validSerials: Set<string>,
  macOwners: Map<string, string> = new Map(),
): Promise<UploadOutcome[]> {
  const outcomes: UploadOutcome[] = [];
  const seenThisDrop = new Map<string, string>();

  for (const file of files) {
    const text = await file.text();
    const parsed = parseTestReport(text);
    const serial = parsed.serial ?? serialFromFilename(file.name);

    if (!validSerials.has(serial)) {
      outcomes.push({ fileName: file.name, serial, status: 'unmatched', message: 'No matching unit serial' });
      continue;
    }

    const mac = parsed.mac;
    const macClash = mac ? macClashFor(mac, serial, macOwners, seenThisDrop) : undefined;

    try {
      const path = `${serial}/${Date.now()}-${file.name}`;
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, { contentType: 'text/markdown', upsert: false });
      if (upErr) throw upErr;

      const patch: Record<string, unknown> = {
        electrical_check: parsed.result,
        electrical_failed_tests: parsed.failedTests.length ? parsed.failedTests.join(', ') : null,
        test_report_path: path,
        test_report_name: file.name,
        test_report_uploaded_at: new Date().toISOString(),
      };
      if (mac) patch.mac_address = mac;

      const { error: dbErr } = await supabase
        .from('units')
        .update(patch)
        .eq('serial', serial);
      if (dbErr) throw dbErr;

      if (mac) seenThisDrop.set(mac, serial);

      await logAction('unit_test_report', serial, mac ? `${parsed.result} mac=${mac}` : parsed.result);
      if (macClash) {
        await logAction('unit_mac_duplicate', serial, `mac=${mac} also on ${macClash}`,
          { entityType: 'unit', unitSerial: serial });
      }
      outcomes.push({ fileName: file.name, serial, status: 'paired', result: parsed.result, mac, macClash });
    } catch (e) {
      outcomes.push({ fileName: file.name, serial, status: 'error', message: (e as Error).message });
    }
  }

  return outcomes;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npx vitest run src/lib/testReports.upload.test.ts src/lib/__tests__/testReports.test.ts src/lib/testReports.openReport.test.ts
```

Expected: PASS, all three files.

- [ ] **Step 5: Type-check**

```bash
npx tsc -b
```

Expected: no output. (`TestReportUploader` still calls with two arguments; the third defaults, so it compiles.)

- [ ] **Step 6: Commit**

```bash
printf '%s\n' "feat(stock): write the ESP32 MAC on test-report upload and flag MACs already on another serial" "" "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" > "$TEMP/msg.txt"
git add src/lib/testReports.ts src/lib/testReports.upload.test.ts
git commit -q -F "$TEMP/msg.txt" && git log --oneline -1
```

---

### Task 5: Uploader warning list + `macOwners` from the Units tab

**Files:**
- Modify: `app/src/modules/Stock/TestReportUploader.tsx`
- Modify: `app/src/modules/Stock/UnitsTab.tsx:21` (next to `validSerials`), `:142` (uploader mount)
- Modify: `app/src/modules/Stock/Stock.module.css` (after `.reportProblems`, line 842)
- Create: `app/src/modules/Stock/__tests__/TestReportUploader.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/src/modules/Stock/__tests__/TestReportUploader.test.tsx`:

```tsx
// The uploader's results panel: a paired file whose MAC is already on another
// serial shows as a warning (not a problem — it did pair), and a paired file
// with no MAC line gets a quiet note so the operator knows that unit still has
// no MAC on record.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { UploadOutcome } from '../../../lib/testReports';

const uploadTestReports = vi.fn(async (..._args: unknown[]): Promise<UploadOutcome[]> => []);
vi.mock('../../../lib/testReports', async () => ({
  ...await vi.importActual<typeof import('../../../lib/testReports')>('../../../lib/testReports'),
  uploadTestReports: (...args: unknown[]) => uploadTestReports(...args),
}));

import { TestReportUploader } from '../TestReportUploader';

const MAC = '98:a3:16:a6:97:b0';
const md = (name: string) => new File(['# report'], name, { type: 'text/markdown' });

const drop = (files: File[]) => {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
};

describe('TestReportUploader — MAC warnings', () => {
  beforeEach(() => uploadTestReports.mockClear());

  it('passes the MAC owner map through to the uploader', async () => {
    const owners = new Map([[MAC, 'LL01-A']]);
    render(<TestReportUploader validSerials={new Set(['LL01-A'])} macOwners={owners} />);
    drop([md('LL01-A.md')]);
    await waitFor(() => expect(uploadTestReports).toHaveBeenCalled());
    expect(uploadTestReports.mock.calls[0][2]).toBe(owners);
  });

  it('lists a MAC clash as a warning while still counting the file as paired', async () => {
    uploadTestReports.mockResolvedValueOnce([
      { fileName: 'LL01-B.md', serial: 'LL01-B', status: 'paired', result: 'pass', mac: MAC, macClash: 'LL01-A' },
    ]);
    render(<TestReportUploader validSerials={new Set(['LL01-A', 'LL01-B'])} macOwners={new Map()} />);
    drop([md('LL01-B.md')]);
    expect(await screen.findByText(/LL01-B → MAC 98:a3:16:a6:97:b0 is already on LL01-A/)).toBeInTheDocument();
    expect(screen.getByText(/paired/)).toHaveTextContent(/^1 paired/);
  });

  it('notes a paired report that carried no MAC', async () => {
    uploadTestReports.mockResolvedValueOnce([
      { fileName: 'LL01-A.md', serial: 'LL01-A', status: 'paired', result: 'pass', mac: null },
    ]);
    render(<TestReportUploader validSerials={new Set(['LL01-A'])} macOwners={new Map()} />);
    drop([md('LL01-A.md')]);
    expect(await screen.findByText(/LL01-A → no MAC ID in report/)).toBeInTheDocument();
  });

  it('shows no warning list when every paired report had a unique MAC', async () => {
    uploadTestReports.mockResolvedValueOnce([
      { fileName: 'LL01-A.md', serial: 'LL01-A', status: 'paired', result: 'pass', mac: MAC },
    ]);
    render(<TestReportUploader validSerials={new Set(['LL01-A'])} macOwners={new Map()} />);
    drop([md('LL01-A.md')]);
    await screen.findByText(/paired/);
    expect(screen.queryByText(/already on/)).toBeNull();
    expect(screen.queryByText(/no MAC ID/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npx vitest run src/modules/Stock/__tests__/TestReportUploader.test.tsx
```

Expected: FAIL. The owner-map case fails because the third argument is `undefined`; the clash and no-MAC cases fail with "Unable to find an element".

- [ ] **Step 3: Add the prop and the warning list**

Replace the whole of `app/src/modules/Stock/TestReportUploader.tsx` with:

```tsx
import { useRef, useState } from 'react';
import { uploadTestReports, type UploadOutcome } from '../../lib/testReports';
import styles from './Stock.module.css';

export function TestReportUploader({
  validSerials, macOwners = new Map(),
}: {
  validSerials: Set<string>;
  /** mac_address → serial for every loaded unit that has a MAC. Lets the
   *  uploader warn when a report's MAC already belongs to another serial. */
  macOwners?: Map<string, string>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<UploadOutcome[] | null>(null);

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).filter(f => f.name.toLowerCase().endsWith('.md'));
    if (files.length === 0) return;
    setBusy(true); setOutcomes(null);
    try {
      setOutcomes(await uploadTestReports(files, validSerials, macOwners));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const paired = outcomes?.filter(o => o.status === 'paired') ?? [];
  const problems = outcomes?.filter(o => o.status !== 'paired') ?? [];
  // Paired files that still deserve a look: a MAC already on another serial
  // (same ESP32 under two labels), or a report that carried no MAC at all.
  const macWarnings = paired.filter(o => o.macClash || o.mac == null);

  return (
    <div className={styles.reportUploader}>
      <div
        className={styles.reportDrop}
        onClick={() => inputRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); void handleFiles(e.dataTransfer.files); }}
        role="button"
        tabIndex={0}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".md"
          multiple
          hidden
          onChange={e => void handleFiles(e.target.files)}
        />
        {busy
          ? 'Uploading…'
          : 'Drop electrical test report .md files here (or click) — auto-paired to units by serial'}
      </div>

      {outcomes && (
        <div className={styles.reportResults}>
          <strong>{paired.length}</strong> paired
          {paired.length > 0 && (
            <span> ({paired.map(o => `${o.serial}: ${o.result}`).join(', ')})</span>
          )}
          {macWarnings.length > 0 && (
            <ul className={styles.reportWarnings}>
              {macWarnings.map((o, i) => (
                o.macClash
                  ? <li key={`${o.fileName}-${i}`}>⚠ {o.serial} → MAC {o.mac} is already on {o.macClash}</li>
                  : <li key={`${o.fileName}-${i}`} className={styles.reportWarningQuiet}>{o.serial} → no MAC ID in report</li>
              ))}
            </ul>
          )}
          {problems.length > 0 && (
            <ul className={styles.reportProblems}>
              {problems.map((o, i) => (
                <li key={`${o.fileName}-${i}`}>
                  ⚠ {o.fileName} → {o.status === 'unmatched' ? 'no matching unit' : o.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
```

In `app/src/modules/Stock/Stock.module.css`, directly after the line
`.reportProblems { margin: 6px 0 0; padding-left: 16px; color: var(--color-error, #c53030); }` add:

```css
.reportWarnings { margin: 6px 0 0; padding-left: 16px; color: var(--color-warning, #744210); }
.reportWarningQuiet { color: var(--color-ink-subtle); }
```

In `app/src/modules/Stock/UnitsTab.tsx`, directly after the line
`  const validSerials = useMemo(() => new Set(units.map(u => u.serial)), [units]);` add:

```ts
  // mac_address → serial, so the uploader can warn when a report's MAC is
  // already on a different unit without another round trip.
  const macOwners = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of units) if (u.mac_address) m.set(u.mac_address, u.serial);
    return m;
  }, [units]);
```

and change the uploader mount to:

```tsx
      <TestReportUploader validSerials={validSerials} macOwners={macOwners} />
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npx vitest run src/modules/Stock/__tests__/TestReportUploader.test.tsx
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Type-check**

```bash
npx tsc -b
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
printf '%s\n' "feat(stock): warn in the uploader when a report's MAC is already on another unit" "" "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" > "$TEMP/msg.txt"
git add src/modules/Stock/TestReportUploader.tsx src/modules/Stock/UnitsTab.tsx src/modules/Stock/Stock.module.css src/modules/Stock/__tests__/TestReportUploader.test.tsx
git commit -q -F "$TEMP/msg.txt" && git log --oneline -1
```

---

### Task 6: DUP MAC pill, MAC search, and the QC modal field

**Files:**
- Modify: `app/src/modules/Stock/UnitTable.tsx` (`UnitTable` props at line 18, QC cell at ~line 157, modal mount at ~line 204, `QcEditorModal` at ~line 435)
- Modify: `app/src/modules/Stock/UnitsTab.tsx` (imports, `macDupes`, search predicate at line 49, table mount at line 144)
- Modify: `app/src/modules/Stock/Stock.module.css` (after `.qcChipEmpty`, line 734; after `.modalHint`, line 988)
- Create: `app/src/modules/Stock/__tests__/UnitTable.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/src/modules/Stock/__tests__/UnitTable.test.tsx`:

```tsx
// The Stock table surfaces a shared MAC on every unit holding it, and the QC
// modal lets an operator see, correct or clear a unit's MAC. The flag is
// derived from the units list (findMacDuplicates), so the table just renders
// whatever map it is handed.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { Unit } from '../../../lib/stock';

const updateUnitFields = vi.fn(async (..._args: unknown[]) => {});
vi.mock('../../../lib/stock', async () => ({
  ...await vi.importActual<typeof import('../../../lib/stock')>('../../../lib/stock'),
  updateUnitStatus: vi.fn(async () => {}),
  updateUnitFields: (...args: unknown[]) => updateUnitFields(...args),
  linkUnitToCustomer: vi.fn(async () => {}),
}));
vi.mock('../../../lib/customers', () => ({ useCustomers: () => ({ customers: [], loading: false }) }));
vi.mock('../../../lib/fulfillment', () => ({
  assignUnit: vi.fn(async () => {}),
  fetchUnassignedQueueItems: vi.fn(async () => []),
}));
vi.mock('../../../lib/testReports', async () => ({
  ...await vi.importActual<typeof import('../../../lib/testReports')>('../../../lib/testReports'),
  openTestReport: vi.fn(async () => {}),
}));
vi.mock('../../../components/UnitTimeline', () => ({ UnitTimeline: () => null }));

import { UnitTable } from '../UnitTable';

const MAC = '98:a3:16:a6:97:b0';

const unit = (serial: string, over: Partial<Unit> = {}): Unit => ({
  serial, batch: 'P100', status: 'ready', color: 'White', location: null,
  customer_name: null, customer_id: null, customer_order_ref: null, carrier: null,
  firmware_version: null, defect_reason: null, tracking_num: null, shipped_at: null,
  notes: null, status_updated_at: '2026-10-01T00:00:00Z', status_updated_by: null,
  created_at: '2026-09-01T00:00:00Z', technician: null, electrical_check: 'pass',
  mechanical_check: null, defect_notes: null, electrical_failed_tests: null,
  test_report_path: null, test_report_name: null, test_report_uploaded_at: null,
  is_team_test: false, backfilled_at: null, backfill_source: null, mac_address: null,
  ...over,
});

const row = (serial: string) => screen.getByText(serial).closest('tr') as HTMLElement;

describe('UnitTable — duplicate MAC', () => {
  beforeEach(() => updateUnitFields.mockClear());

  it('shows a DUP MAC pill only on units in the duplicate map, naming the other serial', () => {
    const units = [unit('LL01-A', { mac_address: MAC }), unit('LL01-B', { mac_address: MAC }), unit('LL01-C')];
    const macDupes = new Map([['LL01-A', ['LL01-B']], ['LL01-B', ['LL01-A']]]);
    render(<UnitTable units={units} macDupes={macDupes} />);
    expect(within(row('LL01-A')).getByText('DUP MAC')).toHaveAttribute('title', 'Same MAC as LL01-B');
    expect(within(row('LL01-B')).getByText('DUP MAC')).toHaveAttribute('title', 'Same MAC as LL01-A');
    expect(within(row('LL01-C')).queryByText('DUP MAC')).toBeNull();
  });

  it('renders without a duplicate map at all', () => {
    render(<UnitTable units={[unit('LL01-A', { mac_address: MAC })]} />);
    expect(screen.queryByText('DUP MAC')).toBeNull();
  });

  it('QC modal shows the MAC and names the other unit holding it', () => {
    const macDupes = new Map([['LL01-A', ['LL01-B']]]);
    render(<UnitTable units={[unit('LL01-A', { mac_address: MAC })]} macDupes={macDupes} />);
    fireEvent.click(within(row('LL01-A')).getByTitle(/Technician:/));
    expect(screen.getByLabelText('MAC address')).toHaveValue(MAC);
    expect(screen.getByText('Also on LL01-B')).toBeInTheDocument();
  });

  it('saves a corrected MAC in normalised form', async () => {
    render(<UnitTable units={[unit('LL01-A', { mac_address: MAC })]} />);
    fireEvent.click(within(row('LL01-A')).getByTitle(/Technician:/));
    fireEvent.change(screen.getByLabelText('MAC address'), { target: { value: ' 98-A3-16-A6-97-B1 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save QC' }));
    await waitFor(() => expect(updateUnitFields).toHaveBeenCalled());
    expect(updateUnitFields.mock.calls[0][1]).toMatchObject({ mac_address: '98:a3:16:a6:97:b1' });
  });

  it('clears the MAC when the field is blanked', async () => {
    render(<UnitTable units={[unit('LL01-A', { mac_address: MAC })]} />);
    fireEvent.click(within(row('LL01-A')).getByTitle(/Technician:/));
    fireEvent.change(screen.getByLabelText('MAC address'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save QC' }));
    await waitFor(() => expect(updateUnitFields).toHaveBeenCalled());
    expect(updateUnitFields.mock.calls[0][1]).toMatchObject({ mac_address: null });
  });

  it('rejects a malformed MAC without writing', async () => {
    render(<UnitTable units={[unit('LL01-A')]} />);
    fireEvent.click(within(row('LL01-A')).getByTitle(/Technician:/));
    fireEvent.change(screen.getByLabelText('MAC address'), { target: { value: '98:a3:16' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save QC' }));
    expect(await screen.findByText('MAC must be six hex pairs, e.g. 98:a3:16:a6:97:b0')).toBeInTheDocument();
    expect(updateUnitFields).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npx vitest run src/modules/Stock/__tests__/UnitTable.test.tsx
```

Expected: FAIL. "Unable to find an element with the text: DUP MAC" and "Unable to find a label with the text of: MAC address". The "renders without a duplicate map" case passes by accident.

- [ ] **Step 3: Wire the pill and the modal field**

In `app/src/modules/Stock/UnitTable.tsx`:

(a) Change the `openTestReport` import line to:

```ts
import { openTestReport, normalizeMac } from '../../lib/testReports';
```

(b) Change the component signature from
`export function UnitTable({ units }: { units: Unit[] }) {` to:

```tsx
export function UnitTable({
  units, macDupes = new Map(),
}: {
  units: Unit[];
  /** serial → other serials sharing its MAC (lib/stock findMacDuplicates). */
  macDupes?: Map<string, string[]>;
}) {
```

(c) In the row render, just before `return (` inside the `units.map(u => {` callback (after the `quarantinedSince` const), add:

```tsx
            const dupSerials = macDupes.get(u.serial);
```

and change the QC cell button body so it reads:

```tsx
                  <button
                    className={styles.qcCell}
                    onClick={() => setQcSerial(u.serial)}
                    title={`Technician: ${u.technician ?? '—'} · Notes: ${u.defect_notes ?? '—'}`}
                  >
                    <QcChip label="E" v={u.electrical_check} />
                    <QcChip label="M" v={u.mechanical_check} />
                    {dupSerials && (
                      <span className={styles.qcDupMac} title={`Same MAC as ${dupSerials.join(', ')}`}>
                        DUP MAC
                      </span>
                    )}
                  </button>
```

(d) Change the modal mount to pass the other serials:

```tsx
      {qcUnit && (
        <QcEditorModal
          unit={qcUnit}
          otherSerials={macDupes.get(qcUnit.serial) ?? []}
          onClose={() => setQcSerial(null)}
          onError={setError}
        />
      )}
```

(e) Replace `QcEditorModal` from its `function QcEditorModal({` line down to and including the closing `</div>` of the "Firmware version" `modalField` with:

```tsx
function QcEditorModal({
  unit, otherSerials, onClose, onError,
}: {
  unit: Unit;
  /** Other serials holding this unit's MAC; empty when the MAC is unique. */
  otherSerials: string[];
  onClose: () => void;
  onError: (msg: string | null) => void;
}) {
  const [technician, setTechnician] = useState(unit.technician ?? '');
  const [eCheck, setECheck] = useState<QcCheck | ''>(unit.electrical_check ?? '');
  const [mCheck, setMCheck] = useState<QcCheck | ''>(unit.mechanical_check ?? '');
  const [defectNotes, setDefectNotes] = useState(unit.defect_notes ?? '');
  const [firmwareVersion, setFirmwareVersion] = useState(unit.firmware_version ?? '');
  const [mac, setMac] = useState(unit.mac_address ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    // The only place a MAC is ever rejected: a value the operator typed. The
    // uploader never gets here — a report's MAC is validated by the parser and
    // simply dropped when garbled.
    const macTyped = mac.trim();
    const macNorm = macTyped ? normalizeMac(macTyped) : null;
    if (macTyped && !macNorm) {
      onError('MAC must be six hex pairs, e.g. 98:a3:16:a6:97:b0');
      return;
    }
    setBusy(true); onError(null);
    try {
      await updateUnitFields(unit.serial, {
        technician:        technician.trim() || null,
        electrical_check:  eCheck || null,
        mechanical_check:  mCheck || null,
        defect_notes:      defectNotes.trim() || null,
        firmware_version:  firmwareVersion.trim() || null,
        mac_address:       macNorm,
      });
      onClose();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={e => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>QC · {unit.serial}</h3>

        <div className={styles.modalField}>
          <label className={styles.modalLabel}>Technician</label>
          <input
            value={technician}
            onChange={e => setTechnician(e.target.value)}
            placeholder="Who last touched this machine"
            className={styles.modalInput}
          />
        </div>

        <div className={styles.modalField}>
          <label className={styles.modalLabel}>Firmware version</label>
          <input
            value={firmwareVersion}
            onChange={e => setFirmwareVersion(e.target.value)}
            placeholder="e.g. v1.2.4"
            className={styles.modalInput}
          />
        </div>

        <div className={styles.modalField}>
          <label className={styles.modalLabel} htmlFor={`mac-${unit.serial}`}>MAC address</label>
          <input
            id={`mac-${unit.serial}`}
            value={mac}
            onChange={e => setMac(e.target.value)}
            placeholder="e.g. 98:a3:16:a6:97:b0"
            className={styles.modalInput}
          />
          {otherSerials.length > 0 && (
            <div className={styles.modalHelp}>Also on {otherSerials.join(', ')}</div>
          )}
        </div>
```

Everything from the "Electrical check" `modalField` onward is unchanged.

In `app/src/modules/Stock/Stock.module.css`:

Directly after the `.qcChipEmpty { ... }` rule (ends at line 734) add:

```css
.qcDupMac {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 3px;
  letter-spacing: 0.3px;
  color: var(--color-error, #9b2c2c);
  background: var(--color-error-bg, #fff5f5);
  border: 1px solid var(--color-error-border, #fc8181);
}
```

Directly after the `.modalHint { ... }` rule add:

```css
.modalHelp {
  margin-top: 4px;
  font-size: 11px;
  color: var(--color-error, #c53030);
}
```

In `app/src/modules/Stock/UnitsTab.tsx`:

(a) Add `findMacDuplicates` to the `../../lib/stock` import:

```ts
import {
  useBatches, useUnits, useStatusCountsByBatch, useIsStockManager,
  STATUS_META, STATUS_ORDER, getStatusMeta, findMacDuplicates,
  type UnitStatus, type StatusCategory,
} from '../../lib/stock';
```

(b) Directly after the `macOwners` memo added in Task 5, add:

```ts
  // Units whose MAC is also on another unit — derived every render from the
  // loaded list, so fixing either unit's MAC clears the flag on both.
  const macDupes = useMemo(() => findMacDuplicates(units), [units]);
```

(c) In the search predicate, after the line `(u.location?.toLowerCase().includes(q))` add a MAC match so the block reads:

```ts
      if (q && !(
        u.serial.toLowerCase().includes(q) ||
        (u.customer_name?.toLowerCase().includes(q)) ||
        (u.customer_order_ref?.toLowerCase().includes(q)) ||
        (u.carrier?.toLowerCase().includes(q)) ||
        (u.location?.toLowerCase().includes(q)) ||
        (u.mac_address?.includes(q))
      )) return false;
```

(`mac_address` is stored lowercase and `q` is already lowercased, so no extra `toLowerCase()`.)

(d) Change the search placeholder to `"Search serial, customer, carrier, location, MAC…"`.

(e) Change the table mount to:

```tsx
      <UnitTable units={filtered} macDupes={macDupes} />
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npx vitest run src/modules/Stock/__tests__/UnitTable.test.tsx
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Type-check and build**

```bash
npx tsc -b
VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npm run build
```

Expected: tsc prints nothing; build ends with `✓ built in …`.

- [ ] **Step 6: Commit**

```bash
printf '%s\n' "feat(stock): DUP MAC pill, MAC search, and an editable MAC in the QC modal" "" "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" > "$TEMP/msg.txt"
git add src/modules/Stock/UnitTable.tsx src/modules/Stock/UnitsTab.tsx src/modules/Stock/Stock.module.css src/modules/Stock/__tests__/UnitTable.test.tsx
git commit -q -F "$TEMP/msg.txt" && git log --oneline -1
```

---

### Task 7: Full verification + spec status

**Files:**
- Modify: `docs/superpowers/specs/2026-10-08-test-report-mac-uniqueness-design.md:5` (status line)

- [ ] **Step 1: Run the whole suite**

```bash
VITE_SUPABASE_URL="https://example.supabase.co" VITE_SUPABASE_ANON_KEY="test-anon-key" npx vitest run
```

Expected: every test file passes. If any file outside this plan fails, check whether it builds a full `Unit` literal (now needs `mac_address`), fix only that, and re-run. Any other failure is reported, not papered over.

- [ ] **Step 2: Lint**

```bash
npx eslint src/lib/testReports.ts src/lib/stock.ts src/modules/Stock
```

Expected: no errors.

- [ ] **Step 3: Mark the spec built**

In `docs/superpowers/specs/2026-10-08-test-report-mac-uniqueness-design.md` change line 5 from
`**Status:** designed, not built.` to
`**Status:** built on branch feat/test-report-mac-uniqueness; migration not yet applied.`

- [ ] **Step 4: Commit**

Run from the repo root:

```bash
printf '%s\n' "docs(stock): mark MAC-uniqueness spec as built" "" "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" > "$TEMP/msg.txt"
git add docs/superpowers/specs/2026-10-08-test-report-mac-uniqueness-design.md
git commit -q -F "$TEMP/msg.txt" && git log --oneline -8
```

- [ ] **Step 5: Report what is left for the repo owner**

Not done by this plan, by design:

1. Apply `supabase/migrations/20261008120000_units_mac_address.sql` to the shared project. Until it is applied, every upload fails at the `units` update with "column mac_address does not exist" — so apply it **before** merging to main (deploy is automatic on main).
2. Push the branch and open the PR.
3. Hand check on the dev server: drop two reports with the same MAC under two serials, confirm the amber warning line, the DUP MAC pill on both rows, that typing the MAC in search shows both, and that clearing the MAC on one unit in its QC modal removes both pills.
