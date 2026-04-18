import { useEffect } from 'react';
import styles from '../OrderReview.module.css';

type Banner = { variant: 'success' | 'error'; message: string } | null;

export function ConfirmBanner({
  banner,
  onDismiss,
}: {
  banner: Banner;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(onDismiss, banner.variant === 'error' ? 6000 : 3000);
    return () => clearTimeout(t);
  }, [banner, onDismiss]);

  if (!banner) return null;
  const cls = banner.variant === 'error' ? styles.bannerError : styles.banner;
  return (
    <div className={cls} role="status">
      <span>{banner.message}</span>
      <button
        className={banner.variant === 'error' ? styles.bannerCloseError : styles.bannerClose}
        onClick={onDismiss}
        aria-label="Dismiss"
      >×</button>
    </div>
  );
}
