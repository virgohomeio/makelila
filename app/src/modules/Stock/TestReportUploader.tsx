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
