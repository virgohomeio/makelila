import { useEffect, useRef, useState } from 'react';
import {
  useTicketAttachments,
  attachmentSignedUrl,
  uploadTicketAttachment,
  deleteTicketAttachment,
  ATTACHMENT_INPUT_ACCEPT,
} from '../../lib/service';
import type { TicketAttachment } from '../../lib/service';
import styles from './Service.module.css';

type Props = { ticketId: string };

export function AttachmentStrip({ ticketId }: Props) {
  const { attachments, loading } = useTicketAttachments(ticketId);
  const [lightbox, setLightbox] = useState<TicketAttachment | null>(null);
  const [uploadingNames, setUploadingNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    const list = Array.from(files);
    setUploadingNames(list.map(f => f.name));
    try {
      // Upload sequentially so a partial failure leaves earlier uploads
      // intact + the operator sees which file broke. With small N (1-5
      // photos) the latency cost is negligible.
      for (const f of list) {
        await uploadTicketAttachment(ticketId, f);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploadingNames([]);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function handleDelete(att: TicketAttachment) {
    if (!window.confirm(`Delete "${att.file_name}"? This cannot be undone.`)) return;
    setError(null);
    try { await deleteTicketAttachment(att); }
    catch (e) { setError((e as Error).message); }
  }

  return (
    <>
      <div className={styles.attachUploadRow}>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ATTACHMENT_INPUT_ACCEPT}
          onChange={e => void handleFiles(e.target.files)}
          style={{ display: 'none' }}
        />
        <button
          type="button"
          className={styles.attachUploadBtn}
          onClick={() => fileInput.current?.click()}
          disabled={uploadingNames.length > 0}
        >
          {uploadingNames.length > 0
            ? `Uploading ${uploadingNames.length}…`
            : '+ Photo / video'}
        </button>
        <span className={styles.attachHint}>
          JPEG · PNG · WebP · HEIC · MP4 · MOV · WebM · max 25 MB
        </span>
      </div>
      {error && <div className={styles.attachError}>{error}</div>}

      {loading
        ? <div className={styles.loading}>Loading attachments…</div>
        : attachments.length === 0 && uploadingNames.length === 0
          ? <div className={styles.attachEmpty}>No attachments yet.</div>
          : (
            <div className={styles.attachStrip}>
              {attachments.map(a => (
                <AttachmentTile
                  key={a.id}
                  att={a}
                  onOpen={() => setLightbox(a)}
                  onDelete={() => void handleDelete(a)}
                />
              ))}
              {uploadingNames.map(name => (
                <div key={`up:${name}`} className={styles.attachThumb} title={`Uploading ${name}…`}>
                  <div className={styles.attachUploadingPlaceholder}>Uploading…</div>
                </div>
              ))}
            </div>
          )
      }
      {lightbox && <Lightbox att={lightbox} onClose={() => setLightbox(null)} />}
    </>
  );
}

function AttachmentTile({
  att, onOpen, onDelete,
}: {
  att: TicketAttachment;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void attachmentSignedUrl(att.file_path).then(u => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [att.file_path]);

  const isImage = att.mime_type.startsWith('image/');
  const isVideo = att.mime_type.startsWith('video/');
  const sizeLabel = att.size_bytes > 1_000_000
    ? `${(att.size_bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.round(att.size_bytes / 1000)} KB`;

  const deleteBtn = (
    <button
      type="button"
      className={styles.attachDeleteBtn}
      title="Delete attachment"
      onClick={(e) => { e.stopPropagation(); onDelete(); }}
    >×</button>
  );

  if (!url) {
    return <div className={styles.attachThumb} style={{ opacity: 0.5 }}>{deleteBtn}</div>;
  }

  if (isImage) {
    return (
      <div className={styles.attachThumb} onClick={onOpen}>
        <img src={url} alt={att.file_name} />
        <span className={`${styles.pill} badge`}>IMG</span>
        {deleteBtn}
      </div>
    );
  }
  if (isVideo) {
    return (
      <div className={styles.attachThumb} onClick={onOpen}>
        <video src={url} muted />
        <span className={`${styles.pill} badge`}>{sizeLabel}</span>
        {deleteBtn}
      </div>
    );
  }
  return (
    <div className={styles.attachFileWrap}>
      <a href={url} download={att.file_name} className={styles.attachFile}>
        📎 {att.file_name}
      </a>
      {deleteBtn}
    </div>
  );
}

function Lightbox({ att, onClose }: { att: TicketAttachment; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void attachmentSignedUrl(att.file_path).then(u => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [att.file_path]);

  if (!url) return null;
  const isVideo = att.mime_type.startsWith('video/');
  return (
    <div className={styles.attachLightbox} onClick={onClose}>
      {isVideo
        ? <video src={url} controls autoPlay onClick={(e) => e.stopPropagation()} />
        : <img src={url} alt={att.file_name} onClick={(e) => e.stopPropagation()} />}
    </div>
  );
}
