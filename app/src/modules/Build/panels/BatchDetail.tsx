import type { FactoryOrder, FreightShipment } from '../../../lib/build';
import styles from '../Build.module.css';

type Props = {
  order: FactoryOrder;
  freight: FreightShipment | null;
  unitsLanded: number;
  onClose: () => void;
};

export function BatchDetail({ order, onClose }: Props) {
  return (
    <div className={styles.detailOverlay}>
      <div className={styles.detailHead}>
        <div>
          <h3 className={styles.detailTitle}>{order.batch}</h3>
          <div className={styles.detailSub}>{order.po_number}</div>
        </div>
        <button className={styles.detailClose} onClick={onClose}>&#10005;</button>
      </div>
      <div className={styles.detailBody}>
        <div className={styles.empty}>Batch detail — to be implemented in Task 7.</div>
      </div>
    </div>
  );
}
