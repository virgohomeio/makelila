import { supabase } from './supabase';
import { logAction } from './activityLog';
import type { QcCheck } from './stock';

const BUCKET = 'test-reports';

export type ParsedTestReport = {
  serial: string | null;
  result: QcCheck;     // 'pass' | 'fail' | 'incomplete'
  passed: number | null;
  failed: number | null;
  failedTests: string[];  // e.g. ['Left Motor', 'Right Motor']
};

/** Parse a test-script .md report. Serial comes from the "Serial Number:" line;
 *  the overall result comes from the Summary "Failed:" count (any failure → fail,
 *  no parseable summary → incomplete). We intentionally only read the summary —
 *  the per-test breakdown lives in the stored file. */
export function parseTestReport(text: string): ParsedTestReport {
  const serialMatch = text.match(/Serial Number:\**\s*([A-Za-z0-9-]+)/i);
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

  return { serial: serialMatch ? serialMatch[1] : null, result, passed, failed, failedTests };
}

/** Serial implied by a filename like "LL01-00000000332.md". */
export function serialFromFilename(name: string): string {
  return name.replace(/\.md$/i, '').trim();
}

export type UploadOutcome = {
  fileName: string;
  serial: string;
  status: 'paired' | 'unmatched' | 'error';
  result?: QcCheck;
  message?: string;
};

/** Bulk-upload .md test reports. Each file is paired to a unit by serial
 *  (in-file "Serial Number", falling back to the filename). Files whose serial
 *  isn't a known unit are reported as 'unmatched' and skipped. */
export async function uploadTestReports(files: File[], validSerials: Set<string>): Promise<UploadOutcome[]> {
  const outcomes: UploadOutcome[] = [];

  for (const file of files) {
    const text = await file.text();
    const parsed = parseTestReport(text);
    const serial = parsed.serial ?? serialFromFilename(file.name);

    if (!validSerials.has(serial)) {
      outcomes.push({ fileName: file.name, serial, status: 'unmatched', message: 'No matching unit serial' });
      continue;
    }

    try {
      const path = `${serial}/${Date.now()}-${file.name}`;
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, { contentType: 'text/markdown', upsert: false });
      if (upErr) throw upErr;

      const { error: dbErr } = await supabase
        .from('units')
        .update({
          electrical_check: parsed.result,
          electrical_failed_tests: parsed.failedTests.length ? parsed.failedTests.join(', ') : null,
          test_report_path: path,
          test_report_name: file.name,
          test_report_uploaded_at: new Date().toISOString(),
        })
        .eq('serial', serial);
      if (dbErr) throw dbErr;

      await logAction('unit_test_report', serial, parsed.result);
      outcomes.push({ fileName: file.name, serial, status: 'paired', result: parsed.result });
    } catch (e) {
      outcomes.push({ fileName: file.name, serial, status: 'error', message: (e as Error).message });
    }
  }

  return outcomes;
}

/** Short-lived signed URL for a stored report path (bucket is private — reports
 *  are sensitive). Generated on demand when the operator opens a report. */
export async function signedReportUrl(path: string, expiresInSeconds = 120): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, expiresInSeconds);
  if (error || !data) throw new Error(error?.message ?? 'Could not create signed URL');
  return data.signedUrl;
}

/** A test report already attached to a unit in Stock. `result` is the parsed
 *  electrical_check, carried alongside so a caller can show *what the report
 *  said* rather than only that a file exists. */
export type AttachedTestReport = {
  path: string;
  name: string | null;
  uploadedAt: string | null;
  result: QcCheck | null;
  failedTests: string | null;
};

/** The report attached to `serial` in Stock, or null when the unit has none.
 *
 *  Fulfillment step 2 asks the operator to verify the test report and used to
 *  offer only a blank "paste a URL" box, even when Stock already held the
 *  report for that exact serial. This is the lookup that lets the step fill
 *  itself in.
 *
 *  A query failure throws rather than returning null: "no report attached" is
 *  a QC statement about the machine, and a broken lookup must never be allowed
 *  to masquerade as one. */
export async function fetchUnitTestReport(serial: string): Promise<AttachedTestReport | null> {
  const { data, error } = await supabase
    .from('units')
    .select('test_report_path, test_report_name, test_report_uploaded_at, electrical_check, electrical_failed_tests')
    .eq('serial', serial)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.test_report_path) return null;
  return {
    path: data.test_report_path as string,
    name: (data.test_report_name as string | null) ?? null,
    uploadedAt: (data.test_report_uploaded_at as string | null) ?? null,
    result: (data.electrical_check as QcCheck | null) ?? null,
    failedTests: (data.electrical_failed_tests as string | null) ?? null,
  };
}

/** Open a unit's stored test report in a new tab.
 *
 *  The QC modal's report link used to sign the URL and only then call
 *  window.open, so the open landed outside the click's user-gesture window and
 *  browsers blocked it silently — the link simply did nothing. It also passed
 *  'noopener', which makes window.open return null by spec, so there was no
 *  handle to check and a blocked tab looked like a successful one.
 *
 *  Even unblocked, the tab came up empty: storage serves these reports as
 *  application/octet-stream (the bulk importer's contentType never stuck on the
 *  stored objects), and browsers download that rather than render it. So the
 *  file is fetched and handed over as a blob re-typed as plain text — markdown
 *  has no in-browser viewer, and the reports are read as text anyway.
 *
 *  Same shape as openInvoiceInNewTab: claim the tab synchronously, sever the
 *  opener by hand, and fall back to the current tab if the open was blocked. */
export async function openTestReport(path: string): Promise<void> {
  const tab = window.open('', '_blank');
  if (tab) {
    try { tab.opener = null; } catch { /* cross-origin guard; harmless */ }
    try { tab.document.write('Loading test report…'); } catch { /* not writable; fine */ }
  }
  try {
    const signedUrl = await signedReportUrl(path);
    const res = await fetch(signedUrl);
    if (!res.ok) throw new Error(`Test report download failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(new Blob([blob], { type: 'text/plain;charset=utf-8' }));
    if (tab && !tab.closed) tab.location.replace(url);
    else window.location.assign(url);
  } catch (e) {
    try { tab?.close(); } catch { /* already gone */ }
    throw e;
  }
}
