import type { BuildDefect } from '../../../lib/build';
import styles from '../Build.module.css';

type Props = { defect: BuildDefect; onClose: () => void; };

export function DefectDetail({ defect, onClose }: Props) {
  return (
    <div className={styles.detailOverlay} style={{ width: 380, right: 480 }}>
      <div className={styles.detailHead}>
        <div>
          <h3 className={styles.detailTitle}>{defect.subject}</h3>
          <div className={styles.detailSub}>{defect.category} · {defect.severity}</div>
        </div>
        <button className={styles.detailClose} onClick={onClose}>✕</button>
      </div>
      <div className={styles.detailBody}>
        <div className={styles.empty}>Defect detail — to be implemented in Task 9.</div>
      </div>
    </div>
  );
}
