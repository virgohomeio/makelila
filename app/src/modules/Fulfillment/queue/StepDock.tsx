import { useState } from 'react';
import { confirmDock, type FulfillmentQueueRow } from '../../../lib/fulfillment';
import styles from '../Fulfillment.module.css';

// Step 5 (since 2026-11-05; was step 4) is a single confirmation: the carrier
// has the box. It comes after the shipping email and is what marks the row
// fulfilled. The old five-item handoff checklist was ticked all at once in
// practice, so it bought nothing.
export function StepDock({ row, onConfirmed }: { row: FulfillmentQueueRow; onConfirmed?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true); setError(null);
    try { await confirmDock(row.id); onConfirmed?.(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <div className={styles.stepBar}>
        <button className={styles.confirmBtn} onClick={confirm} disabled={busy}>
          {busy ? 'Saving…' : '✓ Pickup confirmed — mark fulfilled'}
        </button>
      </div>
      {error && <div style={{ color: 'var(--color-error)', fontSize: 11, marginTop: 6 }}>{error}</div>}
    </div>
  );
}
