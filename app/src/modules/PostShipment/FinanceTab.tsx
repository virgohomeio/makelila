import { useState } from 'react';
import { useQboJournals } from '../../lib/finance';
import { useAuth } from '../../lib/auth';
import { canView } from '../../lib/permissions';
import styles from './PostShipment.module.css';

function getDateRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { from: fmt(from), to: fmt(to) };
}

export function FinanceTab() {
  const [{ from, to }] = useState(() => getDateRange());
  const { role } = useAuth();
  const { journals, loading, error } = useQboJournals(from, to);

  if (!canView(role, 'finance')) {
    return (
      <div className={styles.empty}>
        Finance data is restricted to the Finance role.
      </div>
    );
  }

  if (loading) {
    return <div className={styles.loading}>Loading journals…</div>;
  }

  if (error) {
    return <div className={styles.errorBar}>{error}</div>;
  }

  if (journals.length === 0) {
    return (
      <div className={styles.empty}>
        No journal entries in the last 30 days.
      </div>
    );
  }

  return (
    <div className={styles.tabContent}>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Currency</th>
              <th>Channel</th>
              <th className={styles.num}>Net Deposit</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {journals.map(j => {
              let statusLabel: string;
              let statusClass: string;
              if (j.error) {
                statusLabel = 'Error';
                statusClass = styles.financeStatusError;
              } else if (j.posted_at) {
                statusLabel = 'Posted';
                statusClass = styles.financeStatusPosted;
              } else {
                statusLabel = 'Pending';
                statusClass = styles.financeStatusPending;
              }

              return (
                <tr key={j.id}>
                  <td className={styles.mono}>{j.date}</td>
                  <td>{j.currency}</td>
                  <td>{j.payment_channel}</td>
                  <td className={`${styles.num} ${styles.mono}`}>
                    {j.net_deposit.toLocaleString('en-CA', {
                      style: 'currency',
                      currency: j.currency,
                    })}
                  </td>
                  <td>
                    <span className={statusClass}>{statusLabel}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
