import { useMemo, useState } from 'react';
import { assignUnit, type FulfillmentQueueRow } from '../../../lib/fulfillment';
import { useUnits } from '../../../lib/stock';
import styles from '../Fulfillment.module.css';

export function StepAssign({ row }: { row: FulfillmentQueueRow }) {
  const { units, loading } = useUnits();
  // Stock is the source of truth: only units the team has marked 'ready' under
  // the Stock tab are available to ship.
  const ready = useMemo(() => units.filter(u => u.status === 'ready'), [units]);
  const [picked, setPicked] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ready;
    return ready.filter(u =>
      u.serial.toLowerCase().includes(q)
      || u.batch.toLowerCase().includes(q)
      || (u.location?.toLowerCase().includes(q) ?? false),
    );
  }, [ready, search]);

  const handleConfirm = async () => {
    if (!picked) return;
    setBusy(true); setError(null);
    try {
      await assignUnit(row.id, picked, row.order_id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div>Loading ready units…</div>;
  if (ready.length === 0) {
    return <div>No units are ready to ship. Mark a machine “ready” in the Stock tab first.</div>;
  }

  return (
    <div>
      <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Assign a ready unit</h3>
      <p style={{ fontSize: 11, color: 'var(--color-ink-subtle)', marginBottom: 10 }}>
        {ready.length} unit{ready.length === 1 ? '' : 's'} marked ready in Stock. Click one to assign it to this order.
      </p>
      <input
        type="search"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search by serial, batch, or location…"
        style={{
          width: '100%', maxWidth: 320, marginBottom: 10,
          padding: '6px 10px', fontSize: 12,
          border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
        }}
      />
      {filtered.length === 0 && (
        <div style={{ fontSize: 11, color: 'var(--color-ink-subtle)', marginBottom: 8 }}>
          No matches for "{search}". {ready.length} ready unit{ready.length === 1 ? '' : 's'} — clear search to see all.
        </div>
      )}
      <div className={styles.slotGrid}>
        {filtered.map(u => (
          <div
            key={u.serial}
            className={[styles.slotPick, picked === u.serial ? styles.selected : ''].filter(Boolean).join(' ')}
            onClick={() => setPicked(u.serial)}
          >
            <div className={styles.slotPickTop}>
              {u.serial.slice(-5)}
              <span className={styles.slotPickBatch}>{u.batch}</span>
            </div>
            <div className={styles.slotPickBottom}>
              {u.location ?? 'no location'}
            </div>
          </div>
        ))}
      </div>
      <div className={styles.stepBar}>
        <button className={styles.confirmBtn} onClick={handleConfirm} disabled={!picked || busy}>
          {busy ? 'Assigning…' : `✓ Confirm ${picked ?? ''}`}
        </button>
        {error && <span style={{ color: 'var(--color-error)', fontSize: 11 }}>{error}</span>}
      </div>
    </div>
  );
}
