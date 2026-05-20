import type { BuildDefect, BurnInTest } from '../../../lib/build';
import type { Unit } from '../../../lib/stock';
import styles from '../Build.module.css';

type Props = {
  unit: Unit;
  defects: BuildDefect[];
  tests: BurnInTest[];
  onClose: () => void;
};

export function UnitDetail({ unit, onClose }: Props) {
  return (
    <div className={styles.detailOverlay}>
      <div className={styles.detailHead}>
        <div>
          <h3 className={styles.detailTitle + ' ' + styles.cardMono}>{unit.serial}</h3>
          <div className={styles.detailSub}>{unit.batch} · {unit.status}</div>
        </div>
        <button className={styles.detailClose} onClick={onClose}>&#10005;</button>
      </div>
      <div className={styles.detailBody}>
        <div className={styles.empty}>Unit detail — to be implemented in Task 8.</div>
      </div>
    </div>
  );
}
