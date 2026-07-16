import { useState } from 'react';
import { createPO } from '../../lib/build';
import styles from './Build.module.css';

type Props = {
  onClose: () => void;
  onCreated?: () => void;
  // Seed the form from a "Start a PO" action on the To-Build column.
  prefill?: { batch?: string; qty_ordered?: number };
};

export function NewPOModal({ onClose, onCreated, prefill }: Props) {
  const [form, setForm] = useState({
    po_number: '',
    batch: prefill?.batch ?? 'P100',
    qty_ordered: prefill?.qty_ordered ?? 100,
    unit_cost_usd: '',
    manufacturer: 'Benliang',
    ship_target_date: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.po_number.trim()) { setError('PO number required'); return; }
    setBusy(true); setError(null);
    try {
      await createPO({
        po_number: form.po_number,
        batch: form.batch,
        qty_ordered: form.qty_ordered,
        unit_cost_usd: form.unit_cost_usd ? parseFloat(form.unit_cost_usd) : undefined,
        manufacturer: form.manufacturer,
        ship_target_date: form.ship_target_date || undefined,
      });
      onCreated?.();
      onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 'var(--radius-md)',
          padding: 20, width: 420, maxHeight: '90vh', overflowY: 'auto' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>New Factory PO</h3>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>PO Number</span>
            <input className={styles.input} required value={form.po_number}
              onChange={e => setForm(s => ({ ...s, po_number: e.target.value }))}
              placeholder="BL-P100-2026-05-001" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>Batch</span>
            <select className={styles.select} value={form.batch}
              onChange={e => setForm(s => ({ ...s, batch: e.target.value }))}>
              <option value="P50N">P50N</option>
              <option value="P100">P100</option>
              <option value="P100X">P100X</option>
              <option value="P150">P150</option>
              <option value="P200">P200</option>
              <option value="LILA-Mini">LILA-Mini</option>
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>Quantity</span>
            <input className={styles.input} type="number" min={1} value={form.qty_ordered}
              onChange={e => setForm(s => ({ ...s, qty_ordered: parseInt(e.target.value, 10) }))} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>Unit cost (USD, optional)</span>
            <input className={styles.input} type="number" step="0.01" value={form.unit_cost_usd}
              onChange={e => setForm(s => ({ ...s, unit_cost_usd: e.target.value }))} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>Manufacturer</span>
            <input className={styles.input} value={form.manufacturer}
              onChange={e => setForm(s => ({ ...s, manufacturer: e.target.value }))} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>Target ship date (optional)</span>
            <input className={styles.input} type="date" value={form.ship_target_date}
              onChange={e => setForm(s => ({ ...s, ship_target_date: e.target.value }))} />
          </label>
          {error && <div style={{ color: 'var(--color-error)', fontSize: 11 }}>{error}</div>}
          <div className={styles.actionsRow}>
            <button type="submit" className={styles.btnPrimary} disabled={busy}>Create PO</button>
            <button type="button" className={styles.btnSecondary} disabled={busy} onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
