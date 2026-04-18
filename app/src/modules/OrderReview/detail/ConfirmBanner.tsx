import { useEffect } from 'react';
import styles from '../OrderReview.module.css';

export function ConfirmBanner({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDismiss, 3000);
    return () => clearTimeout(t);
  }, [message, onDismiss]);

  if (!message) return null;
  return (
    <div className={styles.banner} role="status">
      <span>{message}</span>
      <button className={styles.bannerClose} onClick={onDismiss} aria-label="Dismiss">×</button>
    </div>
  );
}
