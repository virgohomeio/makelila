import { useState } from 'react';
import type { Order } from '../../../lib/orders';
import { updateFreightEstimate } from '../../../lib/orders';
import styles from '../OrderReview.module.css';

function EditFreight({ order }: { order: Order }) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(String(order.freight_estimate_usd ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n < 0) { setError('Amount must be a non-negative number'); return; }
    setBusy(true); setError(null);
    try {
      await updateFreightEstimate(order.id, n);
      setEditing(false);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  if (!editing) {
    return (
      <div className={styles.freightHint}>
        <button
          onClick={() => { setEditing(true); setAmount(String(order.freight_estimate_usd ?? '')); }}
          style={{
            background: 'transparent', border: 'none', color: 'var(--color-info)',
            textDecoration: 'underline', cursor: 'pointer', padding: 0, fontSize: 10,
          }}
        >Edit freight (paste ClickShip quote)</button>
      </div>
    );
  }
  return (
    <div>
      <div className={styles.freightEdit}>
        <input
          type="number" step="0.01" min="0"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          placeholder="USD"
        />
        <button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button className={styles.cancelBtn} onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
      </div>
      {error && <div style={{ color: 'var(--color-error)', fontSize: 10, marginTop: 4 }}>{error}</div>}
      <div className={styles.freightHint}>
        Get quote on <a href="https://app.clickship.com/clickship/app-frame/my-orders?tabKey=nav-unfulfilledunfulfilled-tab&amp;status=Unfulfilled" target="_blank" rel="noopener noreferrer">ClickShip — Unfulfilled Orders</a> and paste the total.
      </div>
    </div>
  );
}

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
        <EditFreight order={order} />
      </div>
    </div>
  );
}
