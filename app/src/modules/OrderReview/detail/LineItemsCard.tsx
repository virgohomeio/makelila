import type { Order } from '../../../lib/orders';
import { formatMoney } from '../../../lib/money';
import styles from '../OrderReview.module.css';

export function LineItemsCard({ order }: { order: Order }) {
  const fmt = (n: number | null | undefined) => formatMoney(n, order.currency);
  // Show breakdown rows only when we have the data. Backfill arrives via the
  // next ⟲ Sync from Shopify click — older orders may have null fields.
  const hasBreakdown =
    order.subtotal_usd != null ||
    order.tax_usd != null ||
    order.discount_total_usd != null;
  const shipping = order.freight_estimate_usd;
  const showShipping = hasBreakdown && shipping > 0;
  const showDiscount =
    hasBreakdown && (order.discount_total_usd ?? 0) > 0;
  const showTax = hasBreakdown && (order.tax_usd ?? 0) > 0;

  const codes = order.discount_codes?.filter(Boolean) ?? [];
  const methods = order.payment_methods?.filter(Boolean) ?? [];
  const status = order.financial_status;

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>Line Items</div>
      <div className={styles.cardBody}>
        <table className={styles.liTable}>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Item</th>
              <th>Qty</th>
              <th style={{ textAlign: 'right' }}>Price</th>
            </tr>
          </thead>
          <tbody>
            {order.line_items.map((li, i) => (
              <tr key={`${li.sku}-${i}`}>
                <td>{li.sku}</td>
                <td>{li.name}</td>
                <td>{li.qty}</td>
                <td style={{ textAlign: 'right' }}>{fmt(li.qty * li.price_usd)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {hasBreakdown && (
              <>
                <tr style={{ fontWeight: 400 }}>
                  <td colSpan={3} style={{ color: 'var(--color-ink-subtle)' }}>Subtotal</td>
                  <td style={{ textAlign: 'right', fontWeight: 400 }}>{fmt(order.subtotal_usd)}</td>
                </tr>
                {showDiscount && (
                  <tr style={{ fontWeight: 400 }}>
                    <td colSpan={3} style={{ color: 'var(--color-ink-subtle)' }}>
                      Discount{codes.length > 0 && <> <span style={{ fontSize: 10 }}>({codes.join(', ')})</span></>}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 400, color: 'var(--color-success, #2a8c4a)' }}>
                      −{fmt(order.discount_total_usd)}
                    </td>
                  </tr>
                )}
                {showTax && (
                  <tr style={{ fontWeight: 400 }}>
                    <td colSpan={3} style={{ color: 'var(--color-ink-subtle)' }}>Tax</td>
                    <td style={{ textAlign: 'right', fontWeight: 400 }}>{fmt(order.tax_usd)}</td>
                  </tr>
                )}
                {showShipping && (
                  <tr style={{ fontWeight: 400 }}>
                    <td colSpan={3} style={{ color: 'var(--color-ink-subtle)' }}>Shipping</td>
                    <td style={{ textAlign: 'right', fontWeight: 400 }}>{fmt(shipping)}</td>
                  </tr>
                )}
              </>
            )}
            <tr>
              <td colSpan={3}>Total</td>
              <td style={{ textAlign: 'right' }}>{fmt(order.total_usd)}</td>
            </tr>
          </tfoot>
        </table>
        {(methods.length > 0 || status) && (
          <div style={{ marginTop: 10, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {methods.map(m => (
              <span
                key={m}
                style={{
                  fontSize: 10,
                  padding: '2px 8px',
                  background: 'var(--color-surface)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--color-ink-muted)',
                  fontFamily: 'var(--font-mono, monospace)',
                }}
              >
                {m}
              </span>
            ))}
            {status && (
              <span
                style={{
                  fontSize: 10,
                  padding: '2px 8px',
                  background: status === 'paid' ? 'var(--color-success-bg, #e8f5ec)' : 'var(--color-warning-bg)',
                  border: `1px solid ${status === 'paid' ? 'var(--color-success, #2a8c4a)' : 'var(--color-warning-border)'}`,
                  borderRadius: 'var(--radius-sm)',
                  color: status === 'paid' ? 'var(--color-success, #2a8c4a)' : 'var(--color-warning)',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                }}
              >
                {status.replace(/_/g, ' ')}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
