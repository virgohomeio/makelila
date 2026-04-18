import type { Order } from '../../../lib/orders';
import styles from '../OrderReview.module.css';

export function FreightCard({ order }: { order: Order }) {
  const scale = order.freight_threshold_usd * 1.25;
  const pct = Math.min(100, (order.freight_estimate_usd / scale) * 100);
  const thresholdPct = (order.freight_threshold_usd / scale) * 100;
  const over = order.freight_estimate_usd > order.freight_threshold_usd;

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>Freight Estimate</div>
      <div className={styles.cardBody}>
        <div>
          <strong>${order.freight_estimate_usd.toFixed(2)}</strong>
          <span className={styles.muted}>
            &nbsp;· threshold ${order.freight_threshold_usd.toFixed(2)}
            {over && <strong style={{ color: 'var(--color-error)' }}> · OVER</strong>}
          </span>
        </div>
        <div className={styles.costBarWrap}>
          <div
            className={`${styles.costBarFill} ${over ? styles.costBarOver : styles.costBarUnder}`}
            style={{ width: `${pct}%` }}
          />
          <div className={styles.costThreshold} style={{ left: `${thresholdPct}%` }} />
        </div>
      </div>
    </div>
  );
}
