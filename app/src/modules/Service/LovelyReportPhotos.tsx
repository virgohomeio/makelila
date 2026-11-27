import { useLovelyFeedbackPhoto, useLovelyReportPhotos } from '../../lib/lovelyTickets';
import styles from './Service.module.css';

// The screenshot a customer attached when sending feedback from the Lovely app.
// Mounts only for tickets that carry a lovely_feedback_photo_path.
export function LovelyFeedbackPhoto({ path }: { path: string }) {
  const { url, loading, error } = useLovelyFeedbackPhoto(path);

  if (error) return <div className={styles.muted}>Photo unavailable. {error}</div>;
  if (loading || !url) return <div className={styles.muted}>Loading photo…</div>;

  return (
    <div className={styles.lovelyPhotos}>
      <a href={url} target="_blank" rel="noreferrer" className={styles.lovelyPhoto}>
        <img src={url} alt="Lovely app feedback photo" loading="lazy" />
      </a>
    </div>
  );
}

// Photos a customer attached to a Lovely app damage report. Read live from
// the Lovely project (never copied), so this only mounts for tickets that
// carry a lovely_report_id.
export function LovelyReportPhotos({ reportId }: { reportId: string }) {
  const { paths, urls, loading, error } = useLovelyReportPhotos(reportId);

  if (error) return <div className={styles.muted}>Photos unavailable. {error}</div>;
  if (loading && paths.length === 0) return <div className={styles.muted}>Loading photos…</div>;
  if (paths.length === 0) return <div className={styles.muted}>No photos on this report.</div>;

  return (
    <div className={styles.lovelyPhotos}>
      {paths.map((p, i) => {
        const url = urls[p];
        return url ? (
          <a key={p} href={url} target="_blank" rel="noreferrer" className={styles.lovelyPhoto}>
            <img src={url} alt={`Lovely app photo ${i + 1}`} loading="lazy" />
          </a>
        ) : (
          <div key={p} className={`${styles.lovelyPhoto} ${styles.lovelyPhotoPending}`} />
        );
      })}
    </div>
  );
}
