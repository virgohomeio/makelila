import { useMemo, useState } from 'react';
import {
  useReconcileQueue, recordShippedOffline, recordDuplicate, recordStillOpen,
  type ReconcileGroup, type ReconcileItem, type ReconcileUnitRow,
} from '../../lib/reconcile';
import { formatMoney } from '../../lib/money';
import { Button, EmptyState } from '../../components/ui';
import styles from './Reconcile.module.css';

type Verdict =
  | { kind: 'shipped'; serial: string }
  | { kind: 'duplicate'; ofOrderRef: string }
  | { kind: 'open' };

type RowState =
  | { phase: 'idle' }
  | { phase: 'confirming'; verdict: Verdict }
  | { phase: 'busy' }
  | { phase: 'done'; verdict: Verdict }
  | { phase: 'error'; message: string };

function shortDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
}

function UnitChips({ units }: { units: ReconcileUnitRow[] }) {
  return (
    <div className={styles.unitList}>
      {units.map(u => (
        <span
          key={u.serial}
          className={`${styles.unitChip} ${u.customer_order_ref ? styles.unitChipClaimed : ''}`}
          title={u.customer_order_ref
            ? `Already recorded against order ${u.customer_order_ref}`
            : 'Not linked to any order'}
        >
          {u.serial} · {shortDate(u.shipped_at)}
          {u.customer_order_ref ? ` · ${u.customer_order_ref}` : ''}
        </span>
      ))}
    </div>
  );
}

function OrderRow({
  item,
  siblingRefs,
  onDone,
}: {
  item: ReconcileItem;
  siblingRefs: string[];
  onDone: () => void;
}) {
  const { order, suggestion, candidates } = item;
  const [state, setState] = useState<RowState>({ phase: 'idle' });

  const suggestedSerial = suggestion.kind === 'shipped' ? suggestion.serial : candidates[0]?.serial ?? '';
  const suggestedDup = suggestion.kind === 'duplicate' ? suggestion.ofOrderRef : siblingRefs[0] ?? '';
  const [serial, setSerial] = useState(suggestedSerial);
  const [dupRef, setDupRef] = useState(suggestedDup);

  const run = async (verdict: Verdict) => {
    setState({ phase: 'busy' });
    try {
      if (verdict.kind === 'shipped') await recordShippedOffline(order, verdict.serial);
      else if (verdict.kind === 'duplicate') await recordDuplicate(order, verdict.ofOrderRef);
      else await recordStillOpen(order);
      setState({ phase: 'done', verdict });
      onDone();
    } catch (e) {
      setState({ phase: 'error', message: (e as Error).message });
    }
  };

  const placed = order.placed_at ?? order.created_at;

  return (
    <div className={styles.orderRow}>
      <div>
        <div className={styles.orderId}>
          <span className={styles.ref}>{order.order_ref}</span>
          <span className={styles.orderMeta}>
            {shortDate(placed)} · {order.city}
            {order.region_state ? `, ${order.region_state}` : ''} · {formatMoney(order.total_usd, order.currency)}
          </span>
        </div>
        <div className={`${styles.why} ${suggestion.kind === 'shipped' && suggestion.confidence === 'low' ? styles.whyLow : ''}`}>
          {suggestion.why}
        </div>
      </div>

      <div className={styles.actions}>
        {state.phase === 'busy' && <span className={styles.orderMeta}>Saving…</span>}

        {state.phase === 'done' && (
          <span className={`${styles.done} ${state.verdict.kind === 'duplicate' ? styles.doneCancelled : ''}`}>
            {state.verdict.kind === 'shipped' && `✓ Shipped · ${state.verdict.serial}`}
            {state.verdict.kind === 'duplicate' && `✕ Duplicate of ${state.verdict.ofOrderRef}`}
            {state.verdict.kind === 'open' && '↺ Back in Sales'}
          </span>
        )}

        {/* Duplicate cancels a live order and there is no un-cancel anywhere in
            the app, so it is the one verdict that asks twice. Shipped and Open
            are one click — 79 of these to get through. */}
        {state.phase === 'confirming' && state.verdict.kind === 'duplicate' && (
          <span className={styles.confirmBar}>
            Cancel {order.order_ref} as a duplicate of {state.verdict.ofOrderRef}?
            <Button small variant="danger" onClick={() => void run(state.verdict)}>Confirm</Button>
            <Button small variant="ghost" onClick={() => setState({ phase: 'idle' })}>Back</Button>
          </span>
        )}

        {(state.phase === 'idle' || state.phase === 'error') && (
          <>
            {state.phase === 'error' && <span className={styles.rowError}>{state.message}</span>}

            {candidates.length > 0 && (
              <select
                className={styles.picker}
                value={serial}
                onChange={e => setSerial(e.target.value)}
                aria-label={`Unit shipped for ${order.order_ref}`}
              >
                {candidates.map(c => (
                  <option key={c.serial} value={c.serial}>
                    {c.serial} · {shortDate(c.shipped_at)}
                  </option>
                ))}
              </select>
            )}
            <Button
              small
              className={suggestion.kind === 'shipped' ? styles.suggested : undefined}
              disabled={!serial}
              onClick={() => void run({ kind: 'shipped', serial })}
            >Shipped</Button>

            {siblingRefs.length > 0 && (
              <>
                {siblingRefs.length > 1 && (
                  <select
                    className={styles.picker}
                    value={dupRef}
                    onChange={e => setDupRef(e.target.value)}
                    aria-label={`Duplicate of, for ${order.order_ref}`}
                  >
                    {siblingRefs.map(r => <option key={r} value={r}>of {r}</option>)}
                  </select>
                )}
                <Button
                  small
                  className={suggestion.kind === 'duplicate' ? styles.suggested : undefined}
                  disabled={!dupRef}
                  onClick={() => setState({ phase: 'confirming', verdict: { kind: 'duplicate', ofOrderRef: dupRef } })}
                >Duplicate</Button>
              </>
            )}

            <Button
              small
              className={suggestion.kind === 'none' ? styles.suggested : undefined}
              onClick={() => void run({ kind: 'open' })}
            >Open</Button>
          </>
        )}
      </div>
    </div>
  );
}

function Group({ group, onDone }: { group: ReconcileGroup; onDone: () => void }) {
  const refs = group.items.map(i => i.order.order_ref);
  return (
    <section className={styles.group}>
      <div className={styles.groupHead}>
        <span className={styles.custName}>{group.customerName}</span>
        <span className={styles.custMeta}>
          {group.items.length} order{group.items.length === 1 ? '' : 's'} ·{' '}
          {group.units.length} shipped unit{group.units.length === 1 ? '' : 's'}
        </span>
      </div>
      <UnitChips units={group.units} />
      {group.items.map(item => (
        <OrderRow
          key={item.order.id}
          item={item}
          siblingRefs={refs.filter(r => r !== item.order.order_ref)}
          onDone={onDone}
        />
      ))}
    </section>
  );
}

/** Sales → Reconcile. Orders still sitting in `pending` whose customer already
 *  has a machine, with nothing linking the two. Each is a shipment nobody
 *  recorded, a duplicate order, or genuinely still open. */
export default function Reconcile() {
  const { groups, loading, error, refetch } = useReconcileQueue();
  const [decided, setDecided] = useState(0);

  const total = useMemo(
    () => groups.reduce((n, g) => n + g.items.length, 0),
    [groups],
  );

  if (loading) return <div className={styles.wrap}>Loading…</div>;

  if (error) {
    return (
      <div className={styles.wrap}>
        <div className={styles.loadError}>
          Could not load the reconcile queue: {error}
          {error.includes('reconcile_outcome') && (
            <> — the 20260828120000_order_reconciliation migration has not been applied to this database yet.</>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.intro}>
        <div className={styles.introHead}>Orders that shipped before the app knew</div>
        These customers already have a machine, but nothing links it to this order — so the order
        never left Pending and Sales stopped seeing it. Say what happened to each: it shipped
        against this order, it is a duplicate of another order that shipped, or nothing has gone
        out yet and it belongs back in the queue.
      </div>

      <div className={styles.toolbar}>
        <span className={styles.progress}>
          <strong>{total}</strong> to review
          {decided > 0 && <> · <strong>{decided}</strong> done this session</>}
        </span>
        <Button small variant="ghost" onClick={() => { setDecided(0); void refetch(); }}>Refresh</Button>
      </div>

      {total === 0 ? (
        <EmptyState
          title="Nothing to reconcile"
          body="Every pending order with a shipped machine behind it has a verdict."
        />
      ) : (
        groups.map(g => <Group key={g.key} group={g} onDone={() => setDecided(n => n + 1)} />)
      )}
    </div>
  );
}
