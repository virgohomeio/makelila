import { useEffect, useState } from 'react';
import {
  type BuildDefect,
  DEFECT_CATEGORY_META, DEFECT_STATUS_META, SEVERITY_META,
  useBuildAttachments, attachmentSignedUrl, resolveDefect,
} from '../../../lib/build';
import { supabase } from '../../../lib/supabase';
import styles from '../Build.module.css';

type Props = { defect: BuildDefect; onClose: () => void; };

const ACCEPT_MIME = 'image/jpeg,image/png,image/webp,image/heic,video/mp4,video/quicktime,video/webm';
const MAX_FILE_SIZE = 26_214_400; // 25 MB

export function DefectDetail({ defect, onClose }: Props) {
  const { attachments } = useBuildAttachments(defect.id);
  const [resolveNote, setResolveNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cm = DEFECT_CATEGORY_META[defect.category];
  const sm = DEFECT_STATUS_META[defect.status];
  const sev = SEVERITY_META[defect.severity];

  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true); setError(null);
    try {
      for (const f of Array.from(files)) {
        if (f.size > MAX_FILE_SIZE) { setError(`${f.name} exceeds 25MB`); continue; }
        const path = `${defect.id}/${crypto.randomUUID()}-${f.name}`;
        const { error: upErr } = await supabase.storage
          .from('build-attachments')
          .upload(path, f, { contentType: f.type, upsert: false });
        if (upErr) throw new Error(`Upload failed: ${upErr.message}`);
        const { error: attErr } = await supabase
          .from('build_attachments')
          .insert({
            defect_id: defect.id,
            file_path: path,
            file_name: f.name,
            mime_type: f.type,
            size_bytes: f.size,
          });
        if (attErr) throw new Error(`Attachment record failed: ${attErr.message}`);
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function submitResolve() {
    if (!resolveNote.trim()) { setError('Resolution note required'); return; }
    setBusy(true); setError(null);
    try {
      await resolveDefect(defect.id, resolveNote);
      setResolveNote('');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className={styles.detailOverlay} style={{ width: 380, right: 480, zIndex: 90 }}>
      <div className={styles.detailHead}>
        <div>
          <h3 className={styles.detailTitle}>{defect.subject}</h3>
          <div className={styles.detailSub}>
            <span className={styles.pill} style={{ background: cm.bg, color: cm.color }}>{cm.label}</span>{' '}
            <span className={styles.pill} style={{ background: sm.bg, color: sm.color }}>{sm.label}</span>{' '}
            <span className={styles.pill} style={{ background: sev.color, color: '#fff' }}>{sev.label}</span>
          </div>
        </div>
        <button className={styles.detailClose} onClick={onClose}>✕</button>
      </div>
      <div className={styles.detailBody}>

        {defect.description && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionLabel}>Description</div>
            <div style={{ fontSize: 12, color: 'var(--color-ink)', whiteSpace: 'pre-wrap' }}>
              {defect.description}
            </div>
          </div>
        )}

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Photos / Videos ({attachments.length})</div>
          {attachments.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--color-ink-subtle)' }}>No attachments.</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {attachments.map(a => <AttachmentThumb key={a.id} att={a} />)}
            </div>
          )}
          <div className={styles.actionsRow}>
            <input type="file" multiple accept={ACCEPT_MIME}
              onChange={e => void uploadFiles(e.target.files)}
              disabled={busy} />
          </div>
        </div>

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Audit</div>
          <div className={styles.detailFieldGrid}>
            <span className={styles.detailFieldLabel}>Found by</span>
            <span className={styles.detailFieldValue}>{defect.found_by_name ?? '—'}</span>
            <span className={styles.detailFieldLabel}>Found at</span>
            <span className={styles.detailFieldValue}>{new Date(defect.found_at).toLocaleString()}</span>
            {defect.resolved_at && (<>
              <span className={styles.detailFieldLabel}>Resolved by</span>
              <span className={styles.detailFieldValue}>{defect.resolved_by_name ?? '—'}</span>
              <span className={styles.detailFieldLabel}>Resolved at</span>
              <span className={styles.detailFieldValue}>{new Date(defect.resolved_at).toLocaleString()}</span>
              <span className={styles.detailFieldLabel}>Note</span>
              <span className={styles.detailFieldValue}>{defect.resolution_note ?? '—'}</span>
            </>)}
            {defect.source_notion_url && (<>
              <span className={styles.detailFieldLabel}>Source</span>
              <a className={styles.detailFieldValue}
                href={defect.source_notion_url} target="_blank" rel="noreferrer">
                Notion ↗
              </a>
            </>)}
          </div>
        </div>

        {(defect.status === 'open' || defect.status === 'in_rework') && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionLabel}>Resolve</div>
            <textarea className={styles.textarea}
              placeholder="Resolution note (required)"
              value={resolveNote}
              onChange={e => setResolveNote(e.target.value)} />
            <div className={styles.actionsRow}>
              <button className={styles.btnPrimary} disabled={busy} onClick={submitResolve}>
                Mark resolved
              </button>
            </div>
          </div>
        )}

        {error && <div style={{ color: 'var(--color-error)', fontSize: 11 }}>{error}</div>}
      </div>
    </div>
  );
}

function AttachmentThumb({ att }: { att: { id: string; file_path: string; file_name: string; mime_type: string } }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void attachmentSignedUrl(att.file_path).then(u => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [att.file_path]);
  if (!url) return <div style={{ width: 80, height: 80, background: 'var(--color-surface)' }} />;
  if (att.mime_type.startsWith('image/')) {
    return (
      <a href={url} target="_blank" rel="noreferrer"
        style={{ width: 80, height: 80, overflow: 'hidden', border: '1px solid var(--color-border)', borderRadius: 4 }}>
        <img src={url} alt={att.file_name}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </a>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 10px',
        border: '1px solid var(--color-border)', borderRadius: 4, fontSize: 11, textDecoration: 'none' }}>
      📎 {att.file_name}
    </a>
  );
}
