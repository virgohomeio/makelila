import type { FulfillmentQueueRow } from '../../../lib/fulfillment';

export function StepFulfilled({
  row,
  order,
}: {
  row: FulfillmentQueueRow;
  order: { customer_name: string; customer_email: string | null; order_ref: string; country: 'US'|'CA' };
}) {
  const handoffRef = `${row.id.slice(0, 8)}-${Math.floor(Date.now() / 1000).toString(36)}`;
  const fulfilledOn = row.fulfilled_at
    ? new Date(row.fulfilled_at).toLocaleString()
    : '—';
  const serial = row.assigned_serial ?? '— not recorded —';
  const lilaShipment = [row.carrier, row.tracking_num].filter(Boolean).join(' · ') || '—';
  const starterKit = order.country === 'US'
    ? `Amazon · ${row.starter_tracking_num ?? '—'}`
    : 'Packed In';

  // Keep every row in the brand's Inter font (inherited). Use tabular-nums
  // so tracking numbers and serials align without switching font-family —
  // previously we mixed ui-monospace and Inter which looked inconsistent.
  const labelStyle = { color: 'var(--color-ink-subtle)' } as const;
  const valStyle = { fontVariantNumeric: 'tabular-nums' as const, color: 'var(--color-ink)' } as const;

  return (
    <div>
      <div style={{
        background: 'var(--color-success-bg)',
        border: '1.5px solid var(--color-success-border)',
        borderRadius: 6,
        padding: '10px 14px',
        marginBottom: 14,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <strong style={{ color: 'var(--color-success)', fontSize: 13, fontWeight: 700 }}>
          ✓ Fulfilled · {fulfilledOn}
        </strong>
        <span style={{ color: 'var(--color-success)', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
          Email sent · Unit {serial}
        </span>
      </div>

      <div style={{
        border: '1px solid var(--color-border)', borderRadius: 6, padding: 14, fontSize: 12,
        display: 'grid', gridTemplateColumns: '140px 1fr', rowGap: 8, columnGap: 14,
        background: '#fff',
      }}>
        <span style={labelStyle}>Customer</span>
        <span style={valStyle}>{order.customer_name}</span>
        <span style={labelStyle}>Order ref</span>
        <span style={valStyle}>{order.order_ref}</span>
        <span style={labelStyle}>Email</span>
        <span style={valStyle}>{order.customer_email ?? '—'}</span>
        <span style={labelStyle}>Serial shipped</span>
        <span style={valStyle}>{serial}</span>
        <span style={labelStyle}>LILA shipment</span>
        <span style={valStyle}>{lilaShipment}</span>
        <span style={labelStyle}>Starter kit</span>
        <span style={valStyle}>{starterKit}</span>
      </div>

      <div style={{ marginTop: 14, display: 'flex', gap: 10 }}>
        <button
          onClick={() => navigator.clipboard.writeText(handoffRef)}
          style={{
            background: '#fff', color: 'var(--color-ink-muted)',
            border: '1px solid var(--color-border)', padding: '6px 12px',
            borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: 'pointer',
          }}
        >Copy handoff ref ({handoffRef})</button>
        {order.customer_email && (
          <a
            href={`mailto:${order.customer_email}`}
            style={{
              background: '#fff', color: 'var(--color-crimson)',
              border: '1px solid var(--color-border)', padding: '6px 12px',
              borderRadius: 4, fontSize: 11, fontWeight: 600, textDecoration: 'none',
            }}
          >Open customer email thread</a>
        )}
      </div>
    </div>
  );
}
