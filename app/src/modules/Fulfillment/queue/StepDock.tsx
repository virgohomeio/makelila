import { useState } from 'react';
import { confirmDock, type FulfillmentQueueRow } from '../../../lib/fulfillment';
import styles from '../Fulfillment.module.css';

// Step 4 is a single confirmation: the carrier has the box. The old five-item
// handoff checklist was ticked all at once in practice, so it bought nothing.
export function StepDock({ row }: { row: FulfillmentQueueRow }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true); setError(null);
    try { await confirmDock(row.id); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <div className={styles.stepBar}>
        <button className={styles.confirmBtn} onClick={confirm} disabled={busy}>
          {busy ? 'Saving…' : '✓ Pickup confirmed, proceed to customer email'}
        </button>
      </div>
      {error && <div style={{ color: 'var(--color-error)', fontSize: 11, marginTop: 6 }}>{error}</div>}
    </div>
  );
}
