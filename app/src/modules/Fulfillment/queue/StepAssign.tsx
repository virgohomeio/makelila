import { useMemo, useState } from 'react';
import { useShelf, assignUnit, type FulfillmentQueueRow, type ShelfSlot } from '../../../lib/fulfillment';
import styles from '../Fulfillment.module.css';

function autoSuggestSerial(slots: ShelfSlot[]): string | null {
  // Prefer slot_index 3 or 4 (front row) first; then 0,1,2 (back row). Skid order A1→A30.
  const sorted = [...slots].sort((a, b) => {
    const aFront = a.slot_index >= 3 ? 0 : 1;
    const bFront = b.slot_index >= 3 ? 0 : 1;
    if (aFront !== bFront) return aFront - bFront;
    // Skid 'A7' → 7; 'A30' → 30
    const aNum = parseInt(a.skid.replace(/^[A-Z]+/, ''), 10);
    const bNum = parseInt(b.skid.replace(/^[A-Z]+/, ''), 10);
    if (aNum !== bNum) return aNum - bNum;
    return a.slot_index - b.slot_index;
  });
  return sorted.find(s => s.status === 'available' && s.serial)?.serial ?? null;
}

export function StepAssign({ row }: { row: FulfillmentQueueRow }) {
  const { slots, loading } = useShelf();
  const available = useMemo(() => slots.filter(s => s.status === 'available' && s.serial), [slots]);
  const suggested = useMemo(() => autoSuggestSerial(slots), [slots]);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effective = picked ?? suggested;

  const handleConfirm = async () => {
    if (!effective) return;
    setBusy(true); setError(null);
    try {
      await assignUnit(row.id, effective);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div>Loading shelf…</div>;
  if (available.length === 0) return <div>No available units on the shelf. Flag a rework as resolved first.</div>;

  return (
    <div>
      <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Assign a tested unit from the shelf</h3>
      <p style={{ fontSize: 11, color: 'var(--color-ink-subtle)', marginBottom: 10 }}>
        Auto-suggested next: <strong>{suggested ?? '—'}</strong>. Click any available slot to override.
      </p>
      <div className={styles.slotGrid}>
        {available.map(s => (
          <div
            key={`${s.skid}-${s.slot_index}`}
            className={[
              styles.slotPick,
              effective === s.serial ? styles.selected : '',
              s.serial === suggested ? styles.suggested : '',
            ].filter(Boolean).join(' ')}
            onClick={() => setPicked(s.serial!)}
          >
            <div className={styles.slotPickTop}>
              {s.serial?.slice(-5)}
              <span className={styles.slotPickBatch}>{s.batch}</span>
            </div>
            <div className={styles.slotPickBottom}>
              {s.skid} · slot {s.slot_index}
            </div>
          </div>
        ))}
      </div>
      <div className={styles.stepBar}>
        <button className={styles.confirmBtn} onClick={handleConfirm} disabled={!effective || busy}>
          {busy ? 'Assigning…' : `✓ Confirm ${effective ?? ''}`}
        </button>
        {error && <span style={{ color: 'var(--color-error)', fontSize: 11 }}>{error}</span>}
      </div>
    </div>
  );
}
