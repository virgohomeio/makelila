import { useMemo, useState } from 'react';
import { useParts } from '../../lib/parts';
import { useBatches, useUnits } from '../../lib/stock';
import {
  createReplacementOrder, createPendingReplacement, hasPendingLine,
  type ReplacementLineItem,
} from '../../lib/orders';
import styles from './Service.module.css';

// Backlog #64 — fallback when batches.unit_cost_usd is null (cost not
// yet recorded for that batch). Replacement orders still need a number
// for COGS rollups (#58 profitability); the long-run average ~$314
// from P100 is a reasonable approximation for un-costed batches.
const FALLBACK_UNIT_COST_USD = 314;

type CartLine = ReplacementLineItem;

type Props = {
  ticket: {
    id: string;
    customer_name: string | null;
    customer_email: string | null;
    customer_phone: string | null;
    ticket_number: string;
  };
  address: {
    address_line: string | null;
    city: string;
    region_state: string | null;
    country: 'US' | 'CA';
    postal_code: string | null;
  };
  onClose: () => void;
  onCreated: (result: { id: string; order_ref: string }) => void;
};

export default function ReplacementPickerModal({ ticket, address, onClose, onCreated }: Props) {
  const { parts, loading: partsLoading } = useParts();
  const { units, loading: unitsLoading } = useUnits();
  const { batches } = useBatches();
  const batchCost = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const b of batches) m.set(b.id, b.unit_cost_usd);
    return m;
  }, [batches]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [addr, setAddr] = useState(address);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = (s: string) => search === '' || s.toLowerCase().includes(search.toLowerCase());

  // Section 1 — replacement parts in stock.
  const partsInStock = useMemo(
    () => parts.filter(p => p.category === 'replacement' && p.on_hand > 0
      && (matches(p.name) || matches(p.sku))),
    [parts, search],
  );
  // Section 3 — replacement parts we're out of (on_hand = 0).
  const partsOutOfStock = useMemo(
    () => parts.filter(p => p.category === 'replacement' && p.on_hand <= 0
      && (matches(p.name) || matches(p.sku))),
    [parts, search],
  );
  // Section 2 — ready units.
  const cartUnitSerials = useMemo(
    () => new Set(cart.filter(l => l.kind === 'unit').map(l => (l as Extract<CartLine, { kind: 'unit' }>).unit_serial)),
    [cart],
  );
  const unitsReady = useMemo(
    () => units.filter(u => u.status === 'ready'
      && (matches(u.serial) || matches(u.batch) || matches(u.color ?? ''))),
    [units, search],
  );
  // Section 4 — pending batches: batches not yet arrived (P100X + future).
  const cartPendingBatches = useMemo(
    () => new Set(cart.filter(l => l.kind === 'unit_pending').map(l => (l as Extract<CartLine, { kind: 'unit_pending' }>).batch)),
    [cart],
  );
  const pendingBatches = useMemo(
    () => batches.filter(b => b.arrived_at == null && matches(b.id)),
    [batches, search],
  );

  const cogs = cart.reduce((sum, li) =>
    (li.kind === 'part' || li.kind === 'part_pending')
      ? sum + li.cost_per_unit_usd * li.qty
      : sum + li.cost_usd, 0);

  const pending = hasPendingLine(cart);

  function addPart(p: typeof parts[number], kind: 'part' | 'part_pending') {
    setCart(prev => {
      const existing = prev.findIndex(l => (l.kind === 'part' || l.kind === 'part_pending') && l.part_id === p.id);
      if (existing >= 0) {
        const next = [...prev];
        const cur = next[existing] as Extract<CartLine, { kind: 'part' | 'part_pending' }>;
        // In-stock parts cap at on_hand; out-of-stock pending parts have no cap.
        const cap = kind === 'part' ? p.on_hand : Infinity;
        next[existing] = { ...cur, qty: Math.min(cap, cur.qty + 1) };
        return next;
      }
      return [...prev, {
        kind, part_id: p.id, sku: p.sku, name: p.name,
        qty: 1, cost_per_unit_usd: p.cost_per_unit_usd ?? 0,
      }];
    });
  }

  function addUnit(u: typeof units[number]) {
    setCart(prev => {
      if (prev.some(l => l.kind === 'unit' && l.unit_serial === u.serial)) return prev;
      const cost = batchCost.get(u.batch) ?? FALLBACK_UNIT_COST_USD;
      return [...prev, {
        kind: 'unit', unit_serial: u.serial, batch: u.batch,
        name: `LILA (${u.batch}, ${u.color ?? '?'})`, qty: 1, cost_usd: cost,
      }];
    });
  }

  function addPendingBatch(b: typeof batches[number]) {
    setCart(prev => {
      if (prev.some(l => l.kind === 'unit_pending' && l.batch === b.id)) return prev;
      const cost = batchCost.get(b.id) ?? FALLBACK_UNIT_COST_USD;
      return [...prev, {
        kind: 'unit_pending', batch: b.id, name: `LILA (${b.id}, awaiting batch)`, qty: 1, cost_usd: cost,
      }];
    });
  }

  function setQty(idx: number, qty: number) {
    setCart(prev => {
      const next = [...prev];
      const li = next[idx];
      if (li.kind !== 'part' && li.kind !== 'part_pending') return prev;
      const cap = li.kind === 'part' ? (parts.find(p => p.id === li.part_id)?.on_hand ?? li.qty) : Infinity;
      next[idx] = { ...li, qty: Math.max(1, Math.min(cap, qty)) };
      return next;
    });
  }

  function removeLine(idx: number) {
    setCart(prev => prev.filter((_, i) => i !== idx));
  }

  async function confirm() {
    if (cart.length === 0) { setError('Pick at least one item.'); return; }
    setBusy(true); setError(null);
    try {
      const payload = {
        ticket_id: ticket.id,
        customer_name: ticket.customer_name ?? 'Unknown',
        customer_email: ticket.customer_email,
        customer_phone: ticket.customer_phone,
        address: addr,
        line_items: cart,
      };
      const result = pending
        ? await createPendingReplacement(payload)
        : await createReplacementOrder(payload);
      onCreated(result);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className={styles.modalBackdrop} onClick={() => {
      if (cart.length > 0) {
        if (!window.confirm('Discard the replacement order in progress?')) return;
      }
      onClose();
    }}>
      <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
        <header className={styles.modalHead}>
          <span>Send replacement — {ticket.customer_name} (ticket {ticket.ticket_number})</span>
          <button className={styles.modalClose} onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className={styles.modalBody}>
          <section className={styles.rpAddressBlock}>
            <label>Ship to:</label>
            <input value={addr.address_line ?? ''}
              onChange={e => setAddr({ ...addr, address_line: e.target.value })}
              placeholder="Address" className={styles.modalInput} />
            <div className={styles.rpAddressRow}>
              <input value={addr.city}
                onChange={e => setAddr({ ...addr, city: e.target.value })}
                placeholder="City" className={styles.modalInput} />
              <input value={addr.region_state ?? ''}
                onChange={e => setAddr({ ...addr, region_state: e.target.value })}
                placeholder="State/Prov" className={styles.modalInput} />
              <input value={addr.postal_code ?? ''}
                onChange={e => setAddr({ ...addr, postal_code: e.target.value })}
                placeholder="Postal" className={styles.modalInput} />
              <select value={addr.country}
                onChange={e => setAddr({ ...addr, country: e.target.value as 'US' | 'CA' })}
                className={styles.modalSelect}>
                <option value="CA">CA</option>
                <option value="US">US</option>
              </select>
            </div>
          </section>

          <input className={styles.modalInput}
            placeholder="Search parts, units, or batches…"
            value={search}
            onChange={e => setSearch(e.target.value)} />

          <div className={styles.rpPickerList}>
            {(partsLoading || unitsLoading) && (
              <p style={{ padding: '8px 12px', color: '#888' }}>Loading inventory…</p>
            )}

            {partsInStock.length > 0 && <h4 className={styles.rpPickerHeading}>Parts (In Stock)</h4>}
            {partsInStock.map(p => (
              <button key={`is-${p.id}`} className={styles.rpPickerRow} onClick={() => addPart(p, 'part')}>
                <span>{p.name}</span>
                <span className={styles.rpPickerMeta}>{p.on_hand} on hand · ${(p.cost_per_unit_usd ?? 0).toFixed(2)}</span>
              </button>
            ))}

            {unitsReady.length > 0 && <h4 className={styles.rpPickerHeading}>Replacement Units Available</h4>}
            {unitsReady.map(u => {
              const inCart = cartUnitSerials.has(u.serial);
              return (
                <button key={u.serial} className={styles.rpPickerRow} onClick={() => addUnit(u)} disabled={inCart}>
                  <span>{u.serial}{inCart ? ' ✓' : ''}</span>
                  <span className={styles.rpPickerMeta}>{u.batch} · {u.color ?? '—'} · ready</span>
                </button>
              );
            })}

            {partsOutOfStock.length > 0 && <h4 className={styles.rpPickerHeading}>Parts (Out of Stock)</h4>}
            {partsOutOfStock.map(p => (
              <button key={`oos-${p.id}`} className={styles.rpPickerRow} onClick={() => addPart(p, 'part_pending')}>
                <span>{p.name}</span>
                <span className={styles.rpPickerMeta}>0 on hand · pending</span>
              </button>
            ))}

            {pendingBatches.length > 0 && <h4 className={styles.rpPickerHeading}>Pending Batch</h4>}
            {pendingBatches.map(b => {
              const inCart = cartPendingBatches.has(b.id);
              return (
                <button key={`pb-${b.id}`} className={styles.rpPickerRow} onClick={() => addPendingBatch(b)} disabled={inCart}>
                  <span>{b.id}{inCart ? ' ✓' : ''}</span>
                  <span className={styles.rpPickerMeta}>awaiting batch{b.arrived_at ? '' : ' · not arrived'}</span>
                </button>
              );
            })}
          </div>

          <ul className={styles.rpCartList}>
            {cart.map((li, i) => {
              const isPartLike = li.kind === 'part' || li.kind === 'part_pending';
              const pendingTag = (li.kind === 'part_pending' || li.kind === 'unit_pending') ? ' (pending)' : '';
              return (
                <li key={
                  li.kind === 'part' || li.kind === 'part_pending' ? `p-${li.part_id}`
                  : li.kind === 'unit' ? `u-${li.unit_serial}`
                  : `pb-${li.batch}`
                }>
                  {isPartLike ? (
                    <>
                      <span>{(li as Extract<CartLine, { kind: 'part' | 'part_pending' }>).qty}× {li.name}{pendingTag}</span>
                      <span>${((li as Extract<CartLine, { kind: 'part' | 'part_pending' }>).cost_per_unit_usd * (li as Extract<CartLine, { kind: 'part' | 'part_pending' }>).qty).toFixed(2)}</span>
                      <button aria-label={`Decrease ${li.name} qty`} onClick={() => setQty(i, (li as Extract<CartLine, { kind: 'part' | 'part_pending' }>).qty - 1)}>−</button>
                      <button aria-label={`Increase ${li.name} qty`} onClick={() => setQty(i, (li as Extract<CartLine, { kind: 'part' | 'part_pending' }>).qty + 1)}>+</button>
                    </>
                  ) : (
                    <>
                      <span>{li.kind === 'unit' ? li.unit_serial : li.name}{pendingTag}</span>
                      <span>${(li as Extract<CartLine, { kind: 'unit' | 'unit_pending' }>).cost_usd.toFixed(2)}</span>
                    </>
                  )}
                  <button aria-label="Remove line" onClick={() => removeLine(i)}>✕</button>
                </li>
              );
            })}
          </ul>

          <div className={styles.rpCogs}>COGS total: ${cogs.toFixed(2)}</div>

          {pending && cart.length > 0 && (
            <p className={styles.rpPickerMeta} style={{ padding: '0 12px' }}>
              Cart has out-of-stock / pending-batch items — this will create a <strong>pending</strong> replacement
              under Awaiting Stock / Batch.
            </p>
          )}

          {error && <p className={styles.modalError}>{error}</p>}
        </div>

        <footer className={styles.modalFoot}>
          <button className={styles.modalSecondary} onClick={onClose} disabled={busy}>Cancel</button>
          <button className={styles.modalPrimary} onClick={confirm} disabled={busy || cart.length === 0}>
            {busy ? 'Creating…' : pending ? 'Create pending replacement' : 'Create replacement order'}
          </button>
        </footer>
      </div>
    </div>
  );
}
