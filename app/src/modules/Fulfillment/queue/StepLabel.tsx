import { useState } from 'react';
import { confirmLabel, type FulfillmentQueueRow } from '../../../lib/fulfillment';
import styles from '../Fulfillment.module.css';

const CARRIERS = ['UPS', 'FedEx', 'Purolator', 'Canada Post'] as const;

export function StepLabel({ row }: { row: FulfillmentQueueRow }) {
  const [carrier, setCarrier] = useState<string>('');
  const [tracking, setTracking] = useState<string>('');
  const [pdf, setPdf] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = carrier && tracking.trim();

  const handleConfirm = async () => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      await confirmLabel(row.id, {
        carrier,
        tracking_num: tracking.trim(),
        ...(pdf ? { label_pdf: pdf } : {}),
      });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Attach the shipping label details</h3>

      <label style={{ display: 'block', fontSize: 11, color: 'var(--color-ink-subtle)', marginTop: 8 }}>
        Carrier:
      </label>
      <select
        value={carrier}
        onChange={e => setCarrier(e.target.value)}
        style={{ padding: '6px 10px', fontSize: 11, border: '1px solid var(--color-border)', borderRadius: 4 }}
      >
        <option value="">— select —</option>
        {CARRIERS.map(c => <option key={c} value={c}>{c}</option>)}
      </select>

      <label style={{ display: 'block', fontSize: 11, color: 'var(--color-ink-subtle)', marginTop: 10 }}>
        Tracking number:
      </label>
      <input
        type="text"
        value={tracking}
        onChange={e => setTracking(e.target.value)}
        placeholder="1Z… / paste from the label"
        style={{
          width: '100%', maxWidth: 340, padding: '6px 10px', fontSize: 11,
          border: '1px solid var(--color-border)', borderRadius: 4, fontFamily: 'ui-monospace, monospace',
        }}
      />

      <label style={{ display: 'block', fontSize: 11, color: 'var(--color-ink-subtle)', marginTop: 10 }}>
        Label PDF (optional):
      </label>
      {pdf ? (
        <div style={{ fontSize: 11, color: 'var(--color-ink)', marginTop: 3 }}>
          {pdf.name} · {(pdf.size / 1024).toFixed(0)} KB
          <button
            onClick={() => setPdf(null)}
            style={{
              marginLeft: 8, background: 'transparent', border: '1px solid var(--color-border)',
              color: 'var(--color-ink-subtle)', padding: '2px 8px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
            }}
          >Remove</button>
        </div>
      ) : (
        <input
          type="file"
          accept="application/pdf"
          onChange={e => setPdf(e.target.files?.[0] ?? null)}
          style={{ fontSize: 11 }}
        />
      )}

      <div className={styles.stepBar}>
        <button className={styles.confirmBtn} onClick={handleConfirm} disabled={!ready || busy}>
          {busy ? 'Saving…' : '✓ Confirm label'}
        </button>
      </div>
      {error && <div style={{ color: 'var(--color-error)', fontSize: 11, marginTop: 6 }}>{error}</div>}
    </div>
  );
}
