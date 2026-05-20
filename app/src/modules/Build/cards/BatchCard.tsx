import {
  type FactoryOrder, type FreightShipment,
  PO_STATUS_META, FREIGHT_STATUS_META,
} from '../../../lib/build';
import styles from '../Build.module.css';

type Mode = 'po' | 'freight';

type Props = {
  mode: Mode;
  order: FactoryOrder;
  freight?: FreightShipment;
  unitsMadeCount?: number;
  onClick: () => void;
};

export function BatchCard({ mode, order, freight, unitsMadeCount, onClick }: Props) {
  if (mode === 'po') {
    const meta = PO_STATUS_META[order.status];
    const pct = unitsMadeCount !== undefined && order.qty_ordered > 0
      ? Math.round((unitsMadeCount / order.qty_ordered) * 100)
      : 0;
    return (
      <div className={styles.card} onClick={onClick}>
        <div className={styles.cardTitle}>{order.batch}</div>
        <div className={styles.cardMono} style={{ fontSize: 10, color: 'var(--color-ink-subtle)' }}>
          {order.po_number}
        </div>
        <div style={{ fontSize: 10, color: 'var(--color-ink-muted)', marginTop: 4 }}>
          {unitsMadeCount ?? '?'} / {order.qty_ordered} made · {order.manufacturer}
        </div>
        {unitsMadeCount !== undefined && (
          <div className={styles.cardProgress}>
            <div className={styles.cardProgressFill} style={{ width: `${pct}%` }} />
          </div>
        )}
        <div className={styles.cardMeta}>
          <span className={styles.pill} style={{ background: meta.bg, color: meta.color }}>
            {meta.label}
          </span>
          {order.ship_target_date && (
            <span>ETD {new Date(order.ship_target_date).toLocaleDateString()}</span>
          )}
        </div>
      </div>
    );
  }
  if (!freight) return null;
  const meta = FREIGHT_STATUS_META[freight.status];
  return (
    <div className={styles.card} onClick={onClick}>
      <div className={styles.cardTitle}>{order.batch}</div>
      <div className={styles.cardMono} style={{ fontSize: 10, color: 'var(--color-ink-subtle)' }}>
        {freight.container_no ?? '(no container)'}
      </div>
      <div style={{ fontSize: 10, color: 'var(--color-ink-muted)', marginTop: 4 }}>
        {freight.carrier ?? 'Carrier TBD'}
        {freight.eta_canada && ` · ETA ${new Date(freight.eta_canada).toLocaleDateString()}`}
      </div>
      <div className={styles.cardMeta}>
        <span className={styles.pill} style={{ background: meta.bg, color: meta.color }}>
          {meta.label}
        </span>
      </div>
    </div>
  );
}
