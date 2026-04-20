import { useState } from 'react';
import { confirmLabel, type FulfillmentQueueRow } from '../../../lib/fulfillment';
import styles from '../Fulfillment.module.css';

const CARRIERS = ['UPS', 'FedEx', 'Purolator', 'Canada Post'] as const;

const FREIGHTCOM_URL = 'https://live.freightcom.com/c/mNyRdnwfdBn2raBkyImG9lemXej03RJB/ship/new';
const AMAZON_URL     = 'https://www.amazon.com/gp/your-account/order-history';

export function StepLabel({
  row,
  country,
}: {
  row: FulfillmentQueueRow;
  country: 'US' | 'CA';
}) {
  const [carrier, setCarrier] = useState<string>('');
  const [tracking, setTracking] = useState<string>('');
  const [starterTracking, setStarterTracking] = useState<string>('');
  const [pdf, setPdf] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lilaReady = !!carrier && !!tracking.trim();
  const starterReady = country === 'CA' || !!starterTracking.trim();
  const ready = lilaReady && starterReady;

  const handleConfirm = async () => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      await confirmLabel(row.id, {
        carrier,
        tracking_num: tracking.trim(),
        ...(pdf ? { label_pdf: pdf } : {}),
        ...(country === 'US' ? { starter_tracking_num: starterTracking.trim() } : {}),
      });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Attach the shipping label details</h3>

      <div style={{
        background: 'var(--color-info-bg)',
        border: '1px solid var(--color-info-border)',
        borderRadius: 'var(--radius-sm)',
        padding: '8px 12px',
        marginBottom: 14,
        fontSize: 11,
        color: 'var(--color-info)',
        display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center',
      }}>
        <a
          href={FREIGHTCOM_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.extLinkBtn}
        >Freightcom — New Shipment ↗</a>
        {country === 'US' && (
          <a
            href={AMAZON_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.extLinkBtn}
          >Amazon — Orders ↗</a>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--color-info)' }}>
          {country === 'US'
            ? 'LILA ships via Freightcom · compost starter ships via Amazon'
            : 'LILA ships via Freightcom'}
        </span>
      </div>

      {/* LILA shipment section */}
      <div className={styles.labelSection}>
        <div className={styles.labelSectionHead}>LILA shipment (Freightcom)</div>

        <label style={{ display: 'block', fontSize: 11, color: 'var(--color-ink-subtle)', marginTop: 4 }}>
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
      </div>

      {/* US-only starter kit section */}
      {country === 'US' && (
        <div className={styles.labelSection}>
          <div className={styles.labelSectionHead}>Compost starter kit (Amazon)</div>
          <label style={{ display: 'block', fontSize: 11, color: 'var(--color-ink-subtle)', marginTop: 4 }}>
            Tracking number:
          </label>
          <input
            type="text"
            value={starterTracking}
            onChange={e => setStarterTracking(e.target.value)}
            placeholder="Paste from Amazon order details"
            style={{
              width: '100%', maxWidth: 340, padding: '6px 10px', fontSize: 11,
              border: '1px solid var(--color-border)', borderRadius: 4, fontFamily: 'ui-monospace, monospace',
            }}
          />
        </div>
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
