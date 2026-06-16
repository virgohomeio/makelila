import styles from './MobileBackHeader.module.css';

// Sticky top header for mobile drill-down screens. Tap the chevron/title to
// invoke `onBack` — typically a setter that returns the user to a higher
// level (tab picker, list view, etc.).
export function MobileBackHeader({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button type="button" className={styles.header} onClick={onBack} aria-label="Back">
      <span className={styles.chevron}>‹</span>
      <span className={styles.title}>{label}</span>
    </button>
  );
}
