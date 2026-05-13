import { useEffect, useState } from 'react';
import { useTicketAttachments, attachmentSignedUrl } from '../../lib/service';
import type { TicketAttachment } from '../../lib/service';
import styles from './Service.module.css';

type Props = { ticketId: string };

export function AttachmentStrip({ ticketId }: Props) {
  const { attachments, loading } = useTicketAttachments(ticketId);
  const [lightbox, setLightbox] = useState<TicketAttachment | null>(null);

  if (loading) return <div className={styles.loading}>Loading attachments…</div>;
  if (attachments.length === 0) return <div style={{ fontSize: 11, color: 'var(--color-ink-subtle)' }}>No attachments</div>;

  return (
    <>
      <div className={styles.attachStrip}>
        {attachments.map(a => (
          <AttachmentTile key={a.id} att={a} onClick={() => setLightbox(a)} />
        ))}
      </div>
      {lightbox && <Lightbox att={lightbox} onClose={() => setLightbox(null)} />}
    </>
  );
}

function AttachmentTile({ att, onClick }: { att: TicketAttachment; onClick: () => void }) {
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

  if (!url) {
    return <div className={styles.attachThumb} style={{ opacity: 0.5 }} />;
  }

  if (isImage) {
    return (
      <div className={styles.attachThumb} onClick={onClick}>
        <img src={url} alt={att.file_name} />
        <span className={`${styles.pill} badge`}>IMG</span>
      </div>
    );
  }
  if (isVideo) {
    return (
      <div className={styles.attachThumb} onClick={onClick}>
        <video src={url} muted />
        <span className={`${styles.pill} badge`}>{sizeLabel}</span>
      </div>
    );
  }
  return (
    <a href={url} download={att.file_name} className={styles.attachFile}>
      📎 {att.file_name}
    </a>
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
