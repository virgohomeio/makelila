import { useState } from 'react';
import { setQueuePriority, goBackStep, type FulfillmentQueueRow } from '../../../lib/fulfillment';
import { orderDue } from '../../../lib/orders';
import styles from '../Fulfillment.module.css';

export function QueueHeader({
  row,
  order,
}: {
  row: FulfillmentQueueRow;
  order: { order_ref: string; customer_name: string; city: string; region_state: string | null; country: 'US'|'CA'; placed_at: string | null; created_at: string };
}) {
  const due = orderDue(order.placed_at ?? order.created_at);
  const STEP_LABELS = ['', 'Assign', 'Test', 'Label', 'Dock', 'Email', 'Fulfilled'];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fulfilled = row.step === 6;

  const handleTogglePriority = async () => {
    setBusy(true); setError(null);
    try { await setQueuePriority(row.id, !row.priority); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const canGoBack = row.step > 1 && row.step < 6;
  const backTitle = row.step === 1
    ? 'No previous step — already at Assign'
    : row.step >= 6
      ? 'Order is already fulfilled — cannot rewind'
      : `Back to ${STEP_LABELS[row.step - 1]}`;
  const handleBack = async () => {
    if (!canGoBack) return;
    const prevLabel = STEP_LABELS[row.step - 1];
    if (!window.confirm(`Step back to "${prevLabel}"? Data already saved for later steps is kept.`)) return;
    setBusy(true); setError(null);
    try { await goBackStep(row.id, row.step); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className={styles.header}>
      <div className={styles.headerRow}>
        <div>
          <div className={styles.headerTitle}>
            {row.priority && !fulfilled && <span className={styles.priorityBadge} title="Priority — expedite">⭐</span>}
            {order.customer_name} — LILA Pro
          </div>
          <div className={styles.headerMeta}>
            {order.order_ref} · {order.city}{order.region_state ? `, ${order.region_state}` : ''} · {order.country}
            {row.due_date && <> · Due {new Date(row.due_date).toLocaleDateString()}</>}
          </div>
        </div>
        <div className={styles.headerRight}>
          {due.dueDate && (
            <span
              className={`${styles.duePill} ${styles[`due_${due.severity}`]}`}
              title="Order-confirmation SLA: placed date + 2 days"
            >
              Due: {due.dueLabel}
            </span>
          )}
          <button
            className={styles.backBtn}
            onClick={handleBack}
            disabled={busy || !canGoBack}
            title={backTitle}
          >← Back</button>
          {!fulfilled && (
            <button
              className={row.priority ? styles.priorityBtnOn : styles.priorityBtnOff}
              onClick={handleTogglePriority}
              disabled={busy}
              title="Sales: flag this order as priority so packers see it first"
            >
              {busy ? '…' : row.priority ? '⭐ Priority · clear' : '☆ Prioritize'}
            </button>
          )}
        </div>
      </div>
      {error && <div style={{ color: 'var(--color-error)', fontSize: 11, marginTop: 4 }}>{error}</div>}
      <div className={styles.progressBar} aria-label={`Step ${row.step} of 6 — ${STEP_LABELS[row.step]}`}>
        {[1,2,3,4,5,6].map(s => (
          <div
            key={s}
            className={[
              styles.progressStep,
              s < row.step ? styles.done : '',
              s === row.step ? styles.current : '',
            ].filter(Boolean).join(' ')}
          />
        ))}
      </div>
    </div>
  );
}
