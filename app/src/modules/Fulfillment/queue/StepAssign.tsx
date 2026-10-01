import { useMemo, useState } from 'react';
import { assignUnits, orderUnitTarget, type FulfillmentQueueRow } from '../../../lib/fulfillment';
import { useUnits, type Unit } from '../../../lib/stock';
import { StepBlockers } from './StepBlockers';
import styles from '../Fulfillment.module.css';

function qcIssues(u: Unit): string[] {
  const issues: string[] = [];
  if (u.electrical_check === 'fail') issues.push('Electrical FAIL');
  else if (u.electrical_check === 'incomplete') issues.push('Electrical incomplete');
  if (u.mechanical_check === 'fail') issues.push('Mechanical FAIL');
  else if (u.mechanical_check === 'incomplete') issues.push('Mechanical incomplete');
  return issues;
}

/** Step 1 — reserve the machines this order is for.
 *
 *  Multi-select, because an order can be for more than one machine and this
 *  step is the only thing that reserves one. M-0001 is three LILA Pros: picking
 *  one and advancing left the other two sellable, with nothing recording that
 *  they were owed to James San Roman.
 *
 *  Every unit picked is confirmed in one action, which is also why the order's
 *  own quantity is on screen: the row moves to step 2 once this is confirmed,
 *  and topping it up afterwards means rewinding (which releases the lot). The
 *  count is advisory — what is physically on the pallet beats a line item — so
 *  picking fewer only asks for a confirmation, it does not block.
 */
export function StepAssign({
  row,
  order,
}: {
  row: FulfillmentQueueRow;
  order: { line_items?: unknown };
}) {
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
  const [picked, setPicked] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = orderUnitTarget(order.line_items);

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

  const toggle = (serial: string) =>
    setPicked(p => (p.includes(serial) ? p.filter(s => s !== serial) : [...p, serial]));

  const pickedShipped = picked.filter(s => units.find(u => u.serial === s)?.status === 'shipped');

  const handleConfirm = async () => {
    if (picked.length === 0) return;
    // Under-picking is legitimate but it should not be accidental: confirming
    // sends the row to step 2, and adding the rest later means a rewind.
    if (picked.length < target && !window.confirm(
      `This order is for ${target} machine${target === 1 ? '' : 's'} and you have picked `
      + `${picked.length}.\n\nAssign just ${picked.length}? The rest can only be added by `
      + 'stepping this order back to Assign again, which releases the ones you pick now.',
    )) return;
    setBusy(true); setError(null);
    try {
      await assignUnits(row.id, picked, row.order_id);
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

  const short = target - picked.length;

  return (
    <div>
      <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
        {backfillMode
          ? `Assign or backfill ${target === 1 ? 'a unit' : `${target} units`}`
          : `Assign ${target === 1 ? 'a ready unit' : `${target} ready units`}`}
      </h3>
      <p style={{ fontSize: 11, color: 'var(--color-ink-subtle)', marginBottom: 6 }}>
        {candidates.length} unit{candidates.length === 1 ? '' : 's'} {backfillMode ? '(ready + already-shipped)' : 'marked ready in Stock'}.
        {' '}Click to pick{target === 1 ? ' one' : ` all ${target}`}; click again to unpick.
      </p>
      {/* The count the order asked for, against what is picked. An operator
          filling a three-machine order has no other way to see that they have
          two in hand. */}
      <div
        style={{
          fontSize: 11.5, fontWeight: 600, marginBottom: 8, padding: '5px 9px',
          borderRadius: 4, display: 'inline-block',
          background: picked.length === target ? 'var(--color-success-bg)' : 'var(--color-surface)',
          border: `1px solid ${picked.length === target ? 'var(--color-success-border)' : 'var(--color-border)'}`,
          color: picked.length === target ? 'var(--color-success)' : 'var(--color-ink-muted)',
        }}
      >
        {picked.length} of {target} picked
        {picked.length === target
          ? ' — complete'
          : short > 0
            ? ` — ${short} more to go`
            : ` — ${-short} more than this order is for`}
      </div>
      <label style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 8, marginLeft: 10, cursor: 'pointer' }}>
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
      {pickedShipped.length > 0 && (
        <div style={{
          fontSize: 11, color: '#22543d', background: '#c6f6d5', padding: '4px 8px', borderRadius: 4, marginBottom: 8,
        }}>
          {pickedShipped.length === 1
            ? <>Unit <strong>{pickedShipped[0]}</strong> is already shipped — it will be recorded as a backfill.</>
            : <>{pickedShipped.length} picked units are <strong>already shipped</strong> — they will be recorded as backfills.</>}
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
      {/* Picked units stay listed while a search hides them, so a pick made
          before typing cannot be silently lost. */}
      {picked.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--color-ink-muted)', marginBottom: 8 }}>
          Picked: {picked.map(s => (
            <button
              key={s}
              type="button"
              onClick={() => toggle(s)}
              title={`Unpick ${s}`}
              style={{
                fontVariantNumeric: 'tabular-nums', marginRight: 6, cursor: 'pointer',
                background: 'var(--color-surface)', border: '1px solid var(--color-border)',
                borderRadius: 4, padding: '2px 6px', font: 'inherit',
              }}
            >{s} ×</button>
          ))}
        </div>
      )}
      <div className={styles.slotGrid}>
        {filtered.map(u => {
          const issues = qcIssues(u);
          const blocked = issues.length > 0;
          const isPicked = picked.includes(u.serial);
          return (
            <div
              key={u.serial}
              className={[
                styles.slotPick,
                isPicked ? styles.selected : '',
                blocked ? styles.slotPickQcWarn : '',
              ].filter(Boolean).join(' ')}
              title={blocked ? `QC issues: ${issues.join(', ')} — manager override required` : undefined}
              onClick={() => {
                if (isPicked) { toggle(u.serial); return; }
                if (!blocked) { toggle(u.serial); return; }
                if (window.confirm(`⚠ QC issues on ${u.serial}:\n• ${issues.join('\n• ')}\n\nOverride and assign anyway? (Manager confirmation required)`)) {
                  toggle(u.serial);
                }
              }}
            >
              <div className={styles.slotPickTop}>
                {isPicked ? '✓ ' : ''}{u.serial.slice(-5)}
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
        <button className={styles.confirmBtn} onClick={handleConfirm} disabled={picked.length === 0 || busy}>
          {busy
            ? 'Assigning…'
            : picked.length === 0
              ? '✓ Confirm'
              : picked.length === 1
                ? `✓ Confirm ${picked[0]}`
                : `✓ Confirm ${picked.length} units`}
        </button>
        <StepBlockers blockers={picked.length === 0 ? ['at least one unit picked from the grid above'] : []} />
        {error && <span style={{ color: 'var(--color-error)', fontSize: 11 }}>{error}</span>}
      </div>
    </div>
  );
}
