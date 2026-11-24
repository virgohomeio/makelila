import { useMemo } from 'react';
import type { Order } from '../../../lib/orders';
import { evaluateAutoConfirm, useReadyUnitCount } from '../../../lib/autoConfirm';
import { indexRefundFlags, useRefundMarks } from '../../../lib/refundedOrders';
import styles from '../OrderReview.module.css';

/** What auto-confirm WOULD do with this order. Read-only: nothing here
 *  confirms anything. It is on screen so the team can check the five rules
 *  against their own decisions on real orders before auto-confirm is turned
 *  on (Huayi's build order, item 5). */
export function AutoConfirmDryRun({ order }: { order: Order }) {
  const readyUnits = useReadyUnitCount(order.id);
  const { marks } = useRefundMarks();
  const refundFlag = useMemo(
    () => indexRefundFlags([order], marks).get(order.id) ?? null,
    [order, marks],
  );
  const v = evaluateAutoConfirm(order, { readyUnits, refundFlag });
  if (v.notApplicable) return null;

  return (
    <details className={styles.autoConfirm}>
      <summary className={styles.autoConfirmSummary}>
        <span className={v.wouldConfirm ? styles.autoConfirmYes : styles.autoConfirmNo}>
          {v.wouldConfirm ? 'Would auto-confirm' : 'Would not auto-confirm'}
        </span>
        <span className={styles.autoConfirmNote}>
          dry run · auto-confirm is off
          {!v.wouldConfirm && ` · ${v.checks.filter(c => !c.pass).map(c => c.label.toLowerCase()).join(', ')}`}
        </span>
      </summary>
      <ul className={styles.autoConfirmList}>
        {v.checks.map(c => (
          <li key={c.key}>
            <span aria-hidden="true">{c.pass ? '✓' : '✗'}</span>{' '}
            <strong>{c.label}</strong>: {c.detail}
          </li>
        ))}
      </ul>
    </details>
  );
}
