import { useCacByChannel } from '../../lib/marketing/cac';
import styles from './CacDashboard.module.css';

export function CacDashboard() {
  const { rows, loading } = useCacByChannel();

  if (loading) return <div className={styles.noData}>Loading…</div>;
  if (rows.length === 0) return <div className={styles.noData}>No attribution data yet. Ship Features 3 and 7 first.</div>;

  const maxCac = Math.max(...rows.map(r => r.cac_cad ?? 0), 1);

  return (
    <div className={styles.container}>
      <div className={styles.title}>Cost of Acquisition by Channel</div>
      <table className={styles.table}>
        <thead>
          <tr>
            <th style={{ width: '25%' }}>Channel</th>
            <th style={{ width: '15%', textAlign: 'right' }}>Customers</th>
            <th style={{ width: '20%', textAlign: 'right' }}>Spend (CAD)</th>
            <th style={{ width: '40%', textAlign: 'right' }}>CAC</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.channel}>
              <td style={{ textTransform: 'capitalize', fontWeight: 600 }}>{row.channel}</td>
              <td style={{ textAlign: 'right' }}>{row.customers_acquired}</td>
              <td style={{ textAlign: 'right' }}>
                {row.spend_cad > 0
                  ? `$${row.spend_cad.toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
                  : <span className={styles.null}>—</span>}
              </td>
              <td style={{ textAlign: 'right' }}>
                {row.cac_cad != null ? (
                  <>
                    <span
                      className={styles.bar}
                      style={{ width: `${(row.cac_cad / maxCac) * 80}px` }}
                    />
                    <strong>${row.cac_cad.toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</strong>
                  </>
                ) : (
                  <span className={styles.null}>—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
