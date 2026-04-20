import { useState } from 'react';
import {
  STATUS_META, STATUS_ORDER, updateUnitStatus, type Unit, type UnitStatus,
} from '../../lib/stock';
import styles from './Stock.module.css';

export function UnitTable({ units }: { units: Unit[] }) {
  // Preview-confirm pattern: pending status per row.
  // We keep a map of serial → pendingStatus so one row's edit doesn't clobber another's.
  const [pending, setPending] = useState<Record<string, UnitStatus>>({});
  const [busySerial, setBusySerial] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const commit = async (serial: string) => {
    const next = pending[serial];
    if (!next) return;
    setBusySerial(serial); setError(null);
    try {
      await updateUnitStatus(serial, next);
      setPending(prev => {
        const { [serial]: _unused, ...rest } = prev;
        void _unused;
        return rest;
      });
    } catch (e) {
      setError(`${serial}: ${(e as Error).message}`);
    } finally {
      setBusySerial(null);
    }
  };

  if (units.length === 0) {
    return <div className={styles.empty}>No units match the current filters.</div>;
  }

  return (
    <div className={styles.tableWrap}>
      {error && <div className={styles.errorBar}>{error}</div>}
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Serial</th>
            <th>Batch</th>
            <th>Status</th>
            <th>Tested</th>
            <th>Location / Customer</th>
            <th>Tracking</th>
            <th>Notes</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {units.map(u => {
            const statusVal = pending[u.serial] ?? u.status;
            const meta = STATUS_META[statusVal];
            const changed = statusVal !== u.status;
            return (
              <tr key={u.serial}>
                <td className={styles.serial}>{u.serial}</td>
                <td className={styles.batch}>{u.batch}</td>
                <td>
                  <select
                    value={statusVal}
                    onChange={e => setPending(prev => ({
                      ...prev,
                      [u.serial]: e.target.value as UnitStatus,
                    }))}
                    className={styles.statusSelect}
                    style={{
                      color: meta.color,
                      background: meta.bg,
                      borderColor: meta.border,
                    }}
                    disabled={busySerial === u.serial}
                  >
                    {STATUS_ORDER.map(s => (
                      <option key={s} value={s}>{STATUS_META[s].label}</option>
                    ))}
                  </select>
                </td>
                <td>{u.tested ? '✓' : '—'}</td>
                <td>
                  {u.customer_name
                    ? <span>{u.customer_name}{u.customer_order_ref ? ` · ${u.customer_order_ref}` : ''}</span>
                    : <span className={styles.muted}>{u.location ?? '—'}</span>}
                </td>
                <td className={styles.tracking}>
                  {u.carrier && u.tracking_num
                    ? <>{u.carrier} · {u.tracking_num}</>
                    : <span className={styles.muted}>—</span>}
                </td>
                <td className={styles.notes} title={u.notes ?? ''}>
                  {u.notes ?? <span className={styles.muted}>—</span>}
                </td>
                <td>
                  {changed && (
                    <button
                      className={styles.updateBtn}
                      onClick={() => void commit(u.serial)}
                      disabled={busySerial === u.serial}
                    >
                      {busySerial === u.serial ? '…' : 'Update'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
