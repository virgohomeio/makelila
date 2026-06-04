import { useRef, useState } from 'react';
import { uploadTestReports, type UploadOutcome } from '../../lib/testReports';
import styles from './Stock.module.css';

export function TestReportUploader({ validSerials }: { validSerials: Set<string> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<UploadOutcome[] | null>(null);

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).filter(f => f.name.toLowerCase().endsWith('.md'));
    if (files.length === 0) return;
    setBusy(true); setOutcomes(null);
    try {
      setOutcomes(await uploadTestReports(files, validSerials));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const paired = outcomes?.filter(o => o.status === 'paired') ?? [];
  const problems = outcomes?.filter(o => o.status !== 'paired') ?? [];

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
