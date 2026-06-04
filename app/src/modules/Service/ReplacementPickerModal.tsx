import { useMemo, useState } from 'react';
import { useParts } from '../../lib/parts';
import { useUnits } from '../../lib/stock';
import { createReplacementOrder, type ReplacementLineItem } from '../../lib/orders';
import styles from './Service.module.css';

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
  const [cart, setCart] = useState<CartLine[]>([]);
  // addr is seeded from the prop once. Callers must unmount-and-remount the
  // modal (e.g., {open && <Modal />}) if they change the address — otherwise
  // the operator's edits would be silently overwritten.
  const [addr, setAddr] = useState(address);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableParts = useMemo(
    () => parts.filter(p => p.category === 'replacement' && p.on_hand > 0
      && (search === ''
          || p.name.toLowerCase().includes(search.toLowerCase())
          || p.sku.toLowerCase().includes(search.toLowerCase()))),
    [parts, search],
  );
  const cartUnitSerials = useMemo(
    () => new Set(cart.filter(l => l.kind === 'unit').map(l => (l as Extract<CartLine, { kind: 'unit' }>).unit_serial)),
    [cart],
  );
  const availableUnits = useMemo(
    () => units.filter(u => u.status === 'ready'
      && (search === ''
          || u.serial.toLowerCase().includes(search.toLowerCase())
          || u.batch.toLowerCase().includes(search.toLowerCase())
          || (u.color ?? '').toLowerCase().includes(search.toLowerCase()))),
    [units, search],
  );

  const cogs = cart.reduce((sum, li) =>
    li.kind === 'part' ? sum + li.cost_per_unit_usd * li.qty : sum + li.cost_usd, 0);

  function addPart(p: typeof parts[number]) {
    setCart(prev => {
      const existing = prev.findIndex(l => l.kind === 'part' && l.part_id === p.id);
      if (existing >= 0) {
        const next = [...prev];
        const cur = next[existing] as Extract<CartLine, { kind: 'part' }>;
        next[existing] = { ...cur, qty: Math.min(p.on_hand, cur.qty + 1) };
        return next;
      }
      return [...prev, {
        kind: 'part', part_id: p.id, sku: p.sku, name: p.name,
        qty: 1, cost_per_unit_usd: p.cost_per_unit_usd ?? 0,
      }];
    });
  }

  function addUnit(u: typeof units[number]) {
    setCart(prev => {
      if (prev.some(l => l.kind === 'unit' && l.unit_serial === u.serial)) return prev;
      return [...prev, {
        kind: 'unit', unit_serial: u.serial, batch: u.batch,
        name: `LILA (${u.batch}, ${u.color ?? '?'})`, qty: 1, cost_usd: 312,  // TODO: source from batches.unit_cost_usd via join — placeholder per spec deferred follow-up.
      }];
    });
  }

  function setQty(idx: number, qty: number) {
    setCart(prev => {
      const next = [...prev];
      const li = next[idx];
      if (li.kind !== 'part') return prev;
      const cap = parts.find(p => p.id === li.part_id)?.on_hand ?? li.qty;
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
      const result = await createReplacementOrder({
        ticket_id: ticket.id,
        customer_name: ticket.customer_name ?? 'Unknown',
        customer_email: ticket.customer_email,
        customer_phone: ticket.customer_phone,
        address: addr,
        line_items: cart,
      });
      onCreated(result);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className={styles.modalBackdrop} onClick={() => {
      // Guard against losing cart contents on accidental backdrop clicks.
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
            placeholder="Search parts or units…"
            value={search}
            onChange={e => setSearch(e.target.value)} />

          <div className={styles.rpPickerList}>
            {(partsLoading || unitsLoading) && (
              <p style={{ padding: '8px 12px', color: '#888' }}>Loading inventory…</p>
            )}
            {availableParts.length > 0 && <h4 className={styles.rpPickerHeading}>Parts</h4>}
            {availableParts.map(p => (
              <button key={p.id} className={styles.rpPickerRow} onClick={() => addPart(p)}>
                <span>{p.name}</span>
                <span className={styles.rpPickerMeta}>
                  {p.on_hand} on hand · ${(p.cost_per_unit_usd ?? 0).toFixed(2)}
                </span>
              </button>
            ))}
            {availableUnits.length > 0 && <h4 className={styles.rpPickerHeading}>Replacement Unit</h4>}
            {availableUnits.map(u => {
              const inCart = cartUnitSerials.has(u.serial);
              return (
                <button key={u.serial} className={styles.rpPickerRow} onClick={() => addUnit(u)} disabled={inCart}>
                  <span>{u.serial}{inCart ? ' ✓' : ''}</span>
                  <span className={styles.rpPickerMeta}>{u.batch} · {u.color ?? '—'} · ready</span>
                </button>
              );
            })}
          </div>

          <ul className={styles.rpCartList}>
            {cart.map((li, i) => (
              <li key={li.kind === 'part' ? `p-${li.part_id}` : `u-${li.unit_serial}`}>
                {li.kind === 'part' ? (
                  <>
                    <span>{li.qty}× {li.name}</span>
                    <span>${(li.cost_per_unit_usd * li.qty).toFixed(2)}</span>
                    <button aria-label={`Decrease ${li.name} qty`} onClick={() => setQty(i, li.qty - 1)}>−</button>
                    <button aria-label={`Increase ${li.name} qty`} onClick={() => setQty(i, li.qty + 1)}>+</button>
                  </>
                ) : (
                  <>
                    <span>{li.unit_serial}</span>
                    <span>${li.cost_usd.toFixed(2)}</span>
                  </>
                )}
                <button aria-label="Remove line" onClick={() => removeLine(i)}>✕</button>
              </li>
            ))}
          </ul>

          <div className={styles.rpCogs}>COGS total: ${cogs.toFixed(2)}</div>

          {error && <p className={styles.modalError}>{error}</p>}
        </div>

        <footer className={styles.modalFoot}>
          <button className={styles.modalSecondary} onClick={onClose} disabled={busy}>Cancel</button>
          <button className={styles.modalPrimary} onClick={confirm} disabled={busy || cart.length === 0}>
            {busy ? 'Creating…' : 'Create replacement order'}
          </button>
        </footer>
      </div>
    </div>
  );
}
