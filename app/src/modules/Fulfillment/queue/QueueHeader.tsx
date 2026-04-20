import { useState } from 'react';
import { setQueuePriority, goBackStep, type FulfillmentQueueRow } from '../../../lib/fulfillment';
import { orderDue } from '../../../lib/orders';
import { useAuth } from '../../../lib/auth';
import styles from '../Fulfillment.module.css';

const ADMIN_EMAILS = ['huayi@virgohome.io'] as const;

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
  const { user } = useAuth();

  const fulfilled = row.step === 6;
  const isAdmin = !!user?.email && ADMIN_EMAILS.includes(user.email as typeof ADMIN_EMAILS[number]);

  const handleTogglePriority = async () => {
    setBusy(true); setError(null);
    try { await setQueuePriority(row.id, !row.priority); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  // Normal rewind available on steps 2-5. Step 6 (Fulfilled) can only be
  // rewound by admins (see ADMIN_EMAILS) — going back clears email_sent_at
  // and fulfilled_at so the order can be re-sent.
  const canGoBack =
    (row.step > 1 && row.step < 6) ||
    (row.step === 6 && isAdmin);
  const backTitle = row.step === 1
    ? 'No previous step — already at Assign'
    : row.step === 6 && !isAdmin
      ? 'Only Huayi can revert a fulfilled order'
      : `Back to ${STEP_LABELS[row.step - 1]}`;
  const handleBack = async () => {
    if (!canGoBack) return;
    const prevLabel = STEP_LABELS[row.step - 1];
    const confirmMsg = row.step === 6
      ? `Revert fulfillment? This clears the sent-email timestamp so the order drops back to "${prevLabel}" and can be re-sent.`
      : `Step back to "${prevLabel}"? Data already saved for later steps is kept.`;
    if (!window.confirm(confirmMsg)) return;
    setBusy(true); setError(null);
    try { await goBackStep(row.id, row.step); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const fulfilledOn = row.fulfilled_at
    ? new Date(row.fulfilled_at).toLocaleDateString()
    : '';

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
          {fulfilled ? (
            <span
              className={`${styles.duePill} ${styles.fulfilledPill}`}
              title="Order fulfilled — shipment confirmation email sent to customer"
            >
              Fulfilled: {fulfilledOn || '—'}
            </span>
          ) : due.dueDate && (
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
        {[1,2,3,4,5,6].map(s => {
          // At step 6 every segment is "done" (green). Otherwise: past steps
          // are done, current step is highlighted, future steps are neutral.
          const isDone = fulfilled ? true : s < row.step;
          const isCurrent = !fulfilled && s === row.step;
          return (
            <div
              key={s}
              className={[
                styles.progressStep,
                isDone ? styles.done : '',
                isCurrent ? styles.current : '',
              ].filter(Boolean).join(' ')}
            />
          );
        })}
      </div>
    </div>
  );
}
