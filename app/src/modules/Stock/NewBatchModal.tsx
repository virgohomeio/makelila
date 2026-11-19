import { useState } from 'react';
import { createBatch } from '../../lib/stock';
import styles from './Stock.module.css';

type Props = { onClose: () => void };

export function NewBatchModal({ onClose }: Props) {
  const [f, setF] = useState({
    id: '', version: '', manufacturer: '', manufacturer_short: '', incoterm: '',
    unit_count: '', unit_cost_usd: '', total_cost_usd: '',
    invoice_no: '', invoice_date: '', expected_arrival_date: '', arrived_at: '',
    destination: '', notes: '',
  });
  // Once the operator edits the total by hand we stop recomputing it. P50N is
  // why this field is not derived: 314.00 × 40 = 12,560, but the stored total
  // is 13,300 because that invoice also covered 40 replacement top lids.
  const [totalTouched, setTotalTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set(key: keyof typeof f, value: string) {
    setF(prev => {
      const next = { ...prev, [key]: value };
      if (!totalTouched && (key === 'unit_cost_usd' || key === 'unit_count')) {
        const cost = parseFloat(next.unit_cost_usd);
        const count = parseInt(next.unit_count, 10);
        next.total_cost_usd =
          Number.isFinite(cost) && Number.isInteger(count) ? (cost * count).toFixed(2) : '';
      }
      return next;
    });
  }

  const num = (v: string): number | null => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };

  async function submit() {
    setBusy(true); setError(null);
    try {
      await createBatch({
        id: f.id,
        unit_count: parseInt(f.unit_count, 10),
        manufacturer: f.manufacturer,
        version: f.version,
        manufacturer_short: f.manufacturer_short,
        incoterm: f.incoterm,
        unit_cost_usd: num(f.unit_cost_usd),
        total_cost_usd: num(f.total_cost_usd),
        invoice_no: f.invoice_no,
        invoice_date: f.invoice_date,
        expected_arrival_date: f.expected_arrival_date,
        arrived_at: f.arrived_at,
        destination: f.destination,
        notes: f.notes,
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const text = (key: keyof typeof f, label: string, placeholder?: string, type = 'text') => (
    <div className={styles.modalRow}>
      <label>{label}</label>
      <input
        type={type} value={f[key]} placeholder={placeholder}
        onChange={e => set(key, e.target.value)}
        className={styles.modalInput}
      />
    </div>
  );

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <strong>New batch</strong>
          <button onClick={onClose} className={styles.modalClose}>✕</button>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.modalGrid}>
            <div className={styles.modalRow}>
              <label>Batch ID *</label>
              <input
                type="text" value={f.id} placeholder="P200"
                onChange={e => set('id', e.target.value)}
                className={styles.modalInput}
                autoFocus
              />
            </div>
            {text('version', 'Version', 'v3.8')}
            <div className={styles.modalRow}>
              <label>Manufacturer *</label>
              <input
                type="text" value={f.manufacturer} placeholder="Dongguan LC Technology"
                onChange={e => set('manufacturer', e.target.value)}
                className={styles.modalInput}
              />
            </div>
            {text('manufacturer_short', 'Short name', 'LC')}
            {text('incoterm', 'Incoterm', 'CNF Toronto')}
            <div className={styles.modalRow}>
              <label>Unit count *</label>
              <input
                type="number" min={1} value={f.unit_count} placeholder="200"
                onChange={e => set('unit_count', e.target.value)}
                className={styles.modalInput}
              />
            </div>
            {text('unit_cost_usd', 'Unit cost (USD)', '298.00', 'number')}
            <div className={styles.modalRow}>
              <label>Total cost (USD)</label>
              <input
                type="number" step="0.01" value={f.total_cost_usd}
                onChange={e => { setTotalTouched(true); set('total_cost_usd', e.target.value); }}
                className={styles.modalInput}
              />
            </div>
            {text('invoice_no', 'Invoice #', 'CP20260701-Rev1')}
            {text('invoice_date', 'Invoice date', undefined, 'date')}
            {text('expected_arrival_date', 'Expected arrival', undefined, 'date')}
            {text('arrived_at', 'Arrived on', undefined, 'date')}
          </div>
          {text('destination', 'Destination', 'MicroArt, Markham')}
          <div className={styles.modalRow}>
            <label>Notes</label>
            <textarea
              value={f.notes} onChange={e => set('notes', e.target.value)}
              placeholder="Container #, customs broker, parts changes vs the last batch…"
              className={styles.modalTextarea}
              rows={2}
            />
          </div>
          <div className={styles.modalHint}>
            Leave <strong>Arrived on</strong> empty for a batch still in production —
            the card will read “In production”. Unit count is invoice metadata: the
            card shows <strong>Total 0</strong> until serials are claimed in Build.
          </div>
          {error && <div className={styles.modalError}>{error}</div>}
        </div>
        <div className={styles.modalFoot}>
          <button onClick={onClose} className={styles.modalSecondary} disabled={busy}>Cancel</button>
          <button
            onClick={() => void submit()}
            className={styles.modalPrimary}
            disabled={busy || !f.id.trim() || !f.manufacturer.trim() || !f.unit_count}
          >
            {busy ? 'Creating…' : 'Create batch'}
          </button>
        </div>
      </div>
    </div>
  );
}
