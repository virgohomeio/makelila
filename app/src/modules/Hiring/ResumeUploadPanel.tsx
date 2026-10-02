import { useCallback, useState } from 'react';
import styles from './Hiring.module.css';
import { uploadAndScoreResume, type CandidateSource } from '../../lib/hiring';

type UploadState = {
  file: File;
  status: 'pending' | 'uploading' | 'scoring' | 'done' | 'error';
  message?: string;
  /** Filed a new applicant, or matched one already on the board. */
  duplicate?: boolean;
};

export function ResumeUploadPanel({ postingId, source, onUploaded }: {
  postingId: string; source: CandidateSource; onUploaded: () => void;
}) {
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const handleFiles = useCallback(async (files: FileList) => {
    const accepted = Array.from(files).filter(f =>
      f.type === 'application/pdf' ||
      f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    const entries: UploadState[] = accepted.map(file => ({ file, status: 'pending' }));
    setUploads(prev => [...prev, ...entries]);

    for (const entry of entries) {
      setUploads(prev => prev.map(u => u.file === entry.file ? { ...u, status: 'uploading' } : u));
      try {
        setUploads(prev => prev.map(u => u.file === entry.file ? { ...u, status: 'scoring' } : u));
        const result = await uploadAndScoreResume({ postingId, file: entry.file, source });
        setUploads(prev => prev.map(u =>
          u.file === entry.file ? { ...u, status: 'done', message: result.full_name, duplicate: result.duplicate } : u));
        onUploaded();
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Unknown error';
        setUploads(prev => prev.map(u => u.file === entry.file ? { ...u, status: 'error', message } : u));
      }
    }
  }, [postingId, source, onUploaded]);

  return (
    <div>
      <div
        className={`${styles.dropzone} ${dragOver ? styles.dragOver : ''}`}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) void handleFiles(e.dataTransfer.files); }}
        onClick={() => document.getElementById('hiring-resume-input')?.click()}
      >
        Drop resumes here, or click to browse (PDF or DOCX)
        <input
          id="hiring-resume-input" type="file" multiple accept=".pdf,.docx" style={{ display: 'none' }}
          onChange={e => e.target.files && void handleFiles(e.target.files)}
        />
      </div>
      {uploads.map((u, i) => (
        <div key={i} className={styles.uploadRow}>
          <span>{u.file.name}</span>
          <span className={`${styles.uploadStatus} ${
            u.status === 'error' ? styles.uploadError
              : u.status === 'done' ? (u.duplicate ? styles.uploadDuplicate : styles.uploadSuccess)
              : styles.uploadPending
          }`}>
            {u.status === 'pending' && 'Queued'}
            {u.status === 'uploading' && 'Uploading…'}
            {u.status === 'scoring' && 'Scoring against JD…'}
            {u.status === 'done' && (u.duplicate ? `Already on the board: ${u.message}` : `Filed: ${u.message}`)}
            {u.status === 'error' && u.message}
          </span>
        </div>
      ))}
    </div>
  );
}
