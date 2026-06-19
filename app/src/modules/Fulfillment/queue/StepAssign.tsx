import { useMemo, useState } from 'react';
import { assignUnit, type FulfillmentQueueRow } from '../../../lib/fulfillment';
import { useUnits, type Unit } from '../../../lib/stock';
import styles from '../Fulfillment.module.css';

function qcIssues(u: Unit): string[] {
  const issues: string[] = [];
  if (u.electrical_check === 'fail') issues.push('Electrical FAIL');
  else if (u.electrical_check === 'incomplete') issues.push('Electrical incomplete');
  if (u.mechanical_check === 'fail') issues.push('Mechanical FAIL');
  else if (u.mechanical_check === 'incomplete') issues.push('Mechanical incomplete');
  return issues;
}

export function StepAssign({ row }: { row: FulfillmentQueueRow }) {
  const { units, loading } = useUnits();
  // Stock is the source of truth: only units the team has marked 'ready' under
  // the Stock tab are available to ship.
  // Backlog #57 — temporary backfill mode also surfaces 'shipped' units so
  // Raymond can pair a historical (already-delivered) unit with its order
  // in makelila without losing the shipped status. Visible warning when on.
  const [backfillMode, setBackfillMode] = useState(false);
  const candidates = useMemo(
    () => units.filter(u => u.status === 'ready' || (backfillMode && u.status === 'shipped')),
    [units, backfillMode],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(u =>
      u.serial.toLowerCase().includes(q)
      || u.batch.toLowerCase().includes(q)
      || (u.location?.toLowerCase().includes(q) ?? false)
      || (u.customer_name?.toLowerCase().includes(q) ?? false),
    );
  }, [candidates, search]);

  const pickedUnit = picked ? units.find(u => u.serial === picked) : null;
  const isPickedShipped = pickedUnit?.status === 'shipped';

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
  if (candidates.length === 0 && !backfillMode) {
    return (
      <div>
        <div style={{ marginBottom: 10 }}>
          No units are ready to ship. Mark a machine “ready” in the Stock tab first.
        </div>
        <label style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={backfillMode} onChange={e => setBackfillMode(e.target.checked)} />
          Backfill mode — include already-shipped units (Raymond's historical pairing flow, #57)
        </label>
      </div>
    );
  }

  return (
    <div>
      <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
        {backfillMode ? 'Assign or backfill a unit' : 'Assign a ready unit'}
      </h3>
      <p style={{ fontSize: 11, color: 'var(--color-ink-subtle)', marginBottom: 6 }}>
        {candidates.length} unit{candidates.length === 1 ? '' : 's'} {backfillMode ? '(ready + already-shipped)' : 'marked ready in Stock'}. Click one to assign it to this order.
      </p>
      <label style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 8, cursor: 'pointer' }}>
        <input type="checkbox" checked={backfillMode} onChange={e => setBackfillMode(e.target.checked)} />
        Backfill mode — include already-shipped units (#57)
      </label>
      {backfillMode && (
        <div style={{
          fontSize: 11, color: '#744210', background: '#fefcbf',
          borderLeft: '4px solid #d69e2e', padding: '6px 10px', borderRadius: 4, marginBottom: 10,
        }}>
          ⚠️ Backfill mode is on. Picking a <strong>shipped</strong> unit will pair it to this order WITHOUT
          flipping its status (it stays shipped). Use this only for historical units that left the warehouse
          before makelila tracked the shipment. The unit will be stamped with <code>backfilled_at</code>.
        </div>
      )}
      {isPickedShipped && (
        <div style={{
          fontSize: 11, color: '#22543d', background: '#c6f6d5', padding: '4px 8px', borderRadius: 4, marginBottom: 8,
        }}>
          Picked unit is <strong>already shipped</strong> — will be recorded as a backfill.
        </div>
      )}
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
          No matches for "{search}". {candidates.length} {backfillMode ? 'pickable' : 'ready'} unit{candidates.length === 1 ? '' : 's'} — clear search to see all.
        </div>
      )}
      <div className={styles.slotGrid}>
        {filtered.map(u => {
          const issues = qcIssues(u);
          const blocked = issues.length > 0;
          return (
            <div
              key={u.serial}
              className={[
                styles.slotPick,
                picked === u.serial ? styles.selected : '',
                blocked ? styles.slotPickQcWarn : '',
              ].filter(Boolean).join(' ')}
              title={blocked ? `QC issues: ${issues.join(', ')} — manager override required` : undefined}
              onClick={() => {
                if (!blocked) { setPicked(u.serial); return; }
                if (window.confirm(`⚠ QC issues on ${u.serial}:\n• ${issues.join('\n• ')}\n\nOverride and assign anyway? (Manager confirmation required)`)) {
                  setPicked(u.serial);
                }
              }}
            >
              <div className={styles.slotPickTop}>
                {u.serial.slice(-5)}
                <span className={styles.slotPickBatch}>{u.batch}</span>
              </div>
              {blocked && (
                <div className={styles.slotPickQcBadge}>⚠ QC</div>
              )}
              <div className={styles.slotPickBottom}>
                {u.location ?? 'no location'}
              </div>
            </div>
          );
        })}
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
