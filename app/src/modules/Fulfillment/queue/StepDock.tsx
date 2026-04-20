import { useState } from 'react';
import { toggleDockCheck, confirmDock, type FulfillmentQueueRow } from '../../../lib/fulfillment';
import styles from '../Fulfillment.module.css';

const ITEMS = [
  { key: 'printed' as const,  col: 'dock_printed' as const,  label: 'Label printed' },
  { key: 'affixed' as const,  col: 'dock_affixed' as const,  label: 'Label affixed to box' },
  { key: 'docked' as const,   col: 'dock_docked' as const,   label: 'Box on outbound dock' },
  { key: 'notified' as const, col: 'dock_notified' as const, label: 'Carrier notified for pickup' },
];

export function StepDock({ row }: { row: FulfillmentQueueRow }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allDone = ITEMS.every(i => row[i.col]);

  const toggle = async (item: typeof ITEMS[number]) => {
    const next = !row[item.col];
    try { await toggleDockCheck(row.id, item.key, next); }
    catch (e) { setError((e as Error).message); }
  };

  const confirm = async () => {
    if (!allDone) return;
    setBusy(true); setError(null);
    try { await confirmDock(row.id); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Dock handoff checklist</h3>
      <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
        {ITEMS.map(i => (
          <li key={i.key} style={{ padding: '6px 0' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12 }}>
              <input type="checkbox" checked={row[i.col]} onChange={() => toggle(i)} />
              {i.label}
            </label>
          </li>
        ))}
      </ul>
      <div className={styles.stepBar}>
        <button className={styles.confirmBtn} onClick={confirm} disabled={!allDone || busy}>
          {busy ? 'Saving…' : '✓ Confirm dock & proceed to Step 5'}
        </button>
      </div>
      {error && <div style={{ color: 'var(--color-error)', fontSize: 11, marginTop: 6 }}>{error}</div>}
    </div>
  );
}
