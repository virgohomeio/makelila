import { useState, useMemo } from 'react';
import type { Order } from '../../../lib/orders';
import { updateFreightEstimate, isReplacementLine } from '../../../lib/orders';
import { formatMoney } from '../../../lib/money';
import { useQuotes, selectQuote } from '../../../lib/freight';
import styles from '../OrderReview.module.css';

function SourceTag({ source }: { source: string }) {
  // Backlog #17 — surface where the freight number came from. Color hints:
  // shopify = neutral, manual = blue (operator quote), future clickship /
  // freightcom = green (live carrier API).
  const label =
    source === 'shopify'    ? 'Shopify'
  : source === 'manual'     ? 'operator edit'
  : source === 'clickship'  ? 'ClickShip'
  : source === 'freightcom' ? 'Freightcom'
  : source;
  return <span className={`${styles.freightSourceTag} ${styles[`freightSourceTag_${source}`] ?? ''}`}>{label}</span>;
}

function EditFreight({ order }: { order: Order }) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(String(order.freight_estimate_usd ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n < 0) { setError('Amount must be a non-negative number'); return; }
    setBusy(true); setError(null);
    try {
      await updateFreightEstimate(order.id, n);
      setEditing(false);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  if (!editing) {
    return (
      <div className={styles.freightHint}>
        <button
          onClick={() => { setEditing(true); setAmount(String(order.freight_estimate_usd ?? '')); }}
          style={{
            background: 'transparent', border: 'none', color: 'var(--color-info)',
            textDecoration: 'underline', cursor: 'pointer', padding: 0, fontSize: 10,
          }}
        >Edit freight (paste ClickShip quote)</button>
      </div>
    );
  }
  return (
    <div>
      <div className={styles.freightEdit}>
        <input
          type="number" step="0.01" min="0"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          // Freight is always quoted in CAD (ClickShip/Freightcom), so the
          // placeholder is CAD regardless of the order's own currency.
          placeholder={FREIGHT_CURRENCY}
        />
        <button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button className={styles.cancelBtn} onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
      </div>
      {error && <div style={{ color: 'var(--color-error)', fontSize: 10, marginTop: 4 }}>{error}</div>}
      <div className={styles.freightHint}>
        Get quote on <a href="https://app.clickship.com/clickship/app-frame/my-orders?tabKey=nav-unfulfilledunfulfilled-tab&amp;status=Unfulfilled" target="_blank" rel="noopener noreferrer">ClickShip — Unfulfilled Orders</a> and paste the total.
      </div>
    </div>
  );
}

// Freight is always quoted in Canadian dollars — ClickShip/Freightcom price in
// CAD regardless of whether the customer's order is US or CA. So the estimate
// and its threshold are displayed in CAD, never the order's own currency.
const FREIGHT_CURRENCY = 'CAD';

export function FreightCard({ order }: { order: Order }) {
  const { quotes } = useQuotes(order.id);

  // Backlog #15 — total unit count across all line items, so the operator
  // knows what they're quoting freight for (a 2-unit order's freight should
  // be ~2x a single-unit quote).
  const unitCount = useMemo(() => {
    let n = 0;
    for (const li of order.line_items) {
      if ('kind' in li && (li.kind === 'part' || li.kind === 'unit')) {
        n += (li as Extract<typeof li, { qty: number }>).qty ?? 1;
      } else {
        n += (li as { qty?: number }).qty ?? 1;
      }
    }
    return n;
  }, [order.line_items]);
  // Backlog #14 + NaN guard — avoid division-by-zero on the threshold.
  const threshold = order.freight_threshold_usd > 0 ? order.freight_threshold_usd : 200;
  const scale = threshold * 1.25;
  const pct = Math.min(100, Math.max(0, (order.freight_estimate_usd / scale) * 100)) || 0;
  const thresholdPct = (threshold / scale) * 100;
  const over = order.freight_estimate_usd > threshold;
  // Backlog #16 — when freight is zero (Shopify free-shipping, e.g. CAD orders
  // under the $100 credit), call it out so the operator doesn't read $0.00 as
  // "we have a quote of zero" and forget to check ClickShip.
  const noQuote = order.freight_estimate_usd === 0;
  // Use isReplacementLine for the part of the loop where TS narrows; here it's
  // used as a side-effect of the import so eslint doesn't drop it on tree shake.
  void isReplacementLine;

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        Freight Estimate
        <SourceTag source={order.freight_estimate_source} />
      </div>
      <div className={styles.cardBody}>
        <div>
          <strong>{formatMoney(order.freight_estimate_usd, FREIGHT_CURRENCY)}</strong>
          <span className={styles.muted}>
            &nbsp;· threshold {formatMoney(threshold, FREIGHT_CURRENCY)}
            {over && <strong style={{ color: 'var(--color-error)' }}> · OVER</strong>}
            {unitCount > 1 && <> · for {unitCount} units</>}
          </span>
        </div>
        {noQuote && (
          <div className={styles.freightNoQuote}>
            No freight quote on file. {order.country === 'CA'
              ? 'Canadian customers under $100 CAD are covered by the free-shipping credit; quote the actual carrier cost below for cost tracking.'
              : 'Get a quote from ClickShip and paste it below.'}
          </div>
        )}
        {!noQuote && (
          <div className={styles.costBarWrap}>
            <div
              className={`${styles.costBarFill} ${over ? styles.costBarOver : styles.costBarUnder}`}
              style={{ width: `${pct}%` }}
            />
            <div className={styles.costThreshold} style={{ left: `${thresholdPct}%` }} />
          </div>
        )}
        <EditFreight order={order} />
        {quotes.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-ink-muted)', marginBottom: 6 }}>
              Quote history
            </div>
            <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--color-ink-subtle)' }}>
                  <th style={{ textAlign: 'left', paddingBottom: 4 }}>Provider</th>
                  <th style={{ textAlign: 'left' }}>Service</th>
                  <th style={{ textAlign: 'right' }}>Rate (CAD)</th>
                  <th style={{ textAlign: 'right' }}>Transit</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {quotes.map(q => (
                  <tr
                    key={q.id}
                    style={{
                      background: q.selected ? 'var(--color-surface)' : 'transparent',
                      fontWeight: q.selected ? 600 : 400,
                    }}
                  >
                    <td style={{ padding: '3px 0' }}>{q.provider}</td>
                    <td>{q.service_level}</td>
                    <td style={{ textAlign: 'right' }}>
                      {q.rate_cad != null ? `$${q.rate_cad.toFixed(2)}` : q.rate_usd != null ? `$${q.rate_usd.toFixed(2)} USD` : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>{q.transit_days != null ? `${q.transit_days}d` : '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {!q.selected && (
                        <button
                          onClick={() => void selectQuote(order.id, q.id)}
                          style={{
                            fontSize: 10, padding: '2px 8px', cursor: 'pointer',
                            background: 'none', border: '1px solid var(--color-border)',
                            borderRadius: 4, color: 'var(--color-ink-muted)',
                          }}
                        >
                          Select
                        </button>
                      )}
                      {q.selected && (
                        <span style={{ fontSize: 10, color: '#276749', fontWeight: 700 }}>
                          ✓ Selected
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
