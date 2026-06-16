import type { Order } from '../../../lib/orders';
import cardStyles from '../OrderReview.module.css';

const STATUS_LABEL: Record<string, string> = {
  paid:             'Paid',
  partially_paid:   'Partially paid',
  pending:          'Pending',
  refunded:         'Refunded',
  voided:           'Voided',
};

const STATUS_BADGE_STYLE: Record<string, React.CSSProperties> = {
  paid:           { background: '#f0fff4', color: '#276749', border: '1px solid #9ae6b4' },
  partially_paid: { background: '#fffaf0', color: '#c05621', border: '1px solid #fbd38d' },
  pending:        { background: '#f7fafc', color: '#4a5568', border: '1px solid #cbd5e0' },
  refunded:       { background: '#ebf8ff', color: '#2c5282', border: '1px solid #90cdf4' },
  voided:         { background: '#f7fafc', color: '#718096', border: '1px solid #cbd5e0' },
};

function fmt(amount: number | null | undefined, currency: string): string {
  if (amount == null) return '—';
  const formatted = new Intl.NumberFormat('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return `$${formatted} ${currency}`;
}

export function PaymentCard({ order }: { order: Order }) {
  const f = (n: number | null | undefined) => fmt(n, order.currency);

  const hasBreakdown = order.subtotal_usd != null || order.tax_usd != null;
  const showDiscount = (order.discount_total_usd ?? 0) > 0;
  const showTax = (order.tax_usd ?? 0) > 0;
  const shipping = order.customer_paid_shipping_usd ?? 0;
  const showShipping = hasBreakdown && shipping > 0;

  const codes = order.discount_codes?.filter(Boolean) ?? [];
  const methods = order.payment_methods?.filter(Boolean) ?? [];
  const status = order.financial_status;
  const statusLabel = status ? (STATUS_LABEL[status] ?? status.replace(/_/g, ' ')) : null;
  const badgeStyle = status ? (STATUS_BADGE_STYLE[status] ?? {}) : {};

  return (
    <div className={cardStyles.card}>
      <div className={cardStyles.cardHead}>Payment Summary</div>
      <div className={cardStyles.cardBody}>

        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>
            {f(order.total_usd)}
          </span>
          <span style={{ fontSize: 11, color: 'var(--color-ink-subtle)' }}>
            {order.currency}
          </span>
        </div>

        {hasBreakdown && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 16px', fontSize: 12, marginBottom: 12 }}>
            {order.subtotal_usd != null && (
              <>
                <span style={{ color: 'var(--color-ink-subtle)' }}>Subtotal</span>
                <span style={{ textAlign: 'right' }}>{f(order.subtotal_usd)}</span>
              </>
            )}
            {showDiscount && (
              <>
                <span style={{ color: 'var(--color-ink-subtle)' }}>
                  Discount{codes.length > 0 && <> ({codes.join(', ')})</>}
                </span>
                <span style={{ textAlign: 'right', color: '#2a8c4a' }}>
                  −{f(order.discount_total_usd)}
                </span>
              </>
            )}
            {showTax && (
              <>
                <span style={{ color: 'var(--color-ink-subtle)' }}>Tax</span>
                <span style={{ textAlign: 'right' }}>{f(order.tax_usd)}</span>
              </>
            )}
            {showShipping && (
              <>
                <span style={{ color: 'var(--color-ink-subtle)' }}>Shipping paid</span>
                <span style={{ textAlign: 'right' }}>{f(shipping)}</span>
              </>
            )}
          </div>
        )}

        {(methods.length > 0 || statusLabel) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {methods.map(m => (
              <span key={m} style={{
                fontSize: 10, padding: '2px 8px', borderRadius: 4,
                background: 'var(--color-surface)', border: '1px solid var(--color-border)',
                color: 'var(--color-ink-muted)', fontFamily: 'var(--font-mono, monospace)',
              }}>
                {m.replace(/_/g, ' ')}
              </span>
            ))}
            {statusLabel && (
              <span style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '0.4px',
                textTransform: 'uppercase', padding: '2px 8px', borderRadius: 4,
                ...badgeStyle,
              }}>
                {statusLabel}
              </span>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
