import { supabase } from './supabase';
import { logAction } from './activityLog';
import type { QcCheck } from './stock';

const BUCKET = 'test-reports';

export type ParsedTestReport = {
  serial: string | null;
  result: QcCheck;     // 'pass' | 'fail' | 'incomplete'
  passed: number | null;
  failed: number | null;
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

  let result: QcCheck;
  if (failed == null) result = 'incomplete';
  else if (failed > 0) result = 'fail';
  else result = 'pass';

  return { serial: serialMatch ? serialMatch[1] : null, result, passed, failed };
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
