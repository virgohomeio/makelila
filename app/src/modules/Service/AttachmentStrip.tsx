import { useEffect, useRef, useState } from 'react';
import type * as React from 'react';
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

/** Pull image blobs out of a clipboard/drag DataTransfer. Pasted screenshots
 *  arrive as a blob (often unnamed or "image.png"), so give them a unique,
 *  meaningful filename before they go through the upload path. */
function imageFilesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const blob = item.getAsFile();
      if (blob) out.push(toNamedFile(blob));
    }
  }
  if (out.length === 0) {
    for (const f of Array.from(dt.files ?? [])) {
      if (f.type.startsWith('image/')) out.push(toNamedFile(f));
    }
  }
  return out;
}

function toNamedFile(blob: File | Blob): File {
  const type = blob.type || 'image/png';
  const name = (blob as File).name;
  const generic = !name || name === 'image.png';
  if (!generic) return blob as File;
  const ext = (type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
  return new File([blob], `pasted-${Date.now()}.${ext}`, { type });
}

export function AttachmentStrip({ ticketId }: Props) {
  const { attachments, loading, refresh } = useTicketAttachments(ticketId);
  const [lightbox, setLightbox] = useState<TicketAttachment | null>(null);
  const [uploadingNames, setUploadingNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | File[] | null) {
    if (!files) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    setError(null);
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
      // Force a re-fetch in case the realtime subscription didn't
      // propagate the INSERT (observed on iPhone PWA installs where the
      // websocket can stall after the device sleeps).
      refresh();
    }
  }

  // Paste (⌘/Ctrl+V) anywhere while a ticket is open: pull image blobs out of
  // the clipboard and route them through the SAME uploadTicketAttachment path
  // as the file picker, so a pasted screenshot is stored identically to an
  // upload. A window listener is used (not a div onPaste) because paste only
  // fires on focused editable elements — Safari never fires it on a plain div.
  // Text pastes are ignored (no image in the clipboard), so typing in the
  // notes/subject fields is unaffected.
  useEffect(() => {
    function onWindowPaste(e: ClipboardEvent) {
      const files = imageFilesFrom(e.clipboardData);
      if (files.length > 0) {
        e.preventDefault();
        void handleFiles(files);
      }
    }
    window.addEventListener('paste', onWindowPaste);
    return () => window.removeEventListener('paste', onWindowPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId]);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    // Prefer clipboard-style image extraction; fall back to any dropped files
    // (uploadTicketAttachment validates type/size and surfaces errors).
    const imgs = imageFilesFrom(e.dataTransfer);
    const files = imgs.length > 0 ? imgs : Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) void handleFiles(files);
  }

  async function handleDelete(att: TicketAttachment) {
    if (!window.confirm(`Delete "${att.file_name}"? This cannot be undone.`)) return;
    setError(null);
    try { await deleteTicketAttachment(att); }
    catch (e) { setError((e as Error).message); }
    finally { refresh(); }
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
        <div
          className={`${styles.attachPasteZone} ${dragOver ? styles.attachPasteZoneOver : ''}`}
          aria-label="Paste an image (Cmd/Ctrl+V) or drop a file here"
          title="Paste an image (⌘/Ctrl+V) while this ticket is open, or drop a file here"
          onDrop={handleDrop}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
        >
          📋 Paste image (⌘/Ctrl+V) or drop here
        </div>
      </div>
      <span className={styles.attachHint}>
        JPEG · PNG · WebP · HEIC · MP4 · MOV · WebM · max 25 MB
      </span>
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
