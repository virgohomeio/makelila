import type { Order } from '../../lib/orders';
import { orderUrgency } from '../../lib/orders';
import { useQuotes } from '../../lib/freight';
import styles from './OrderReview.module.css';

export function OrderRow({
  order,
  isSelected,
  onClick,
}: {
  order: Order;
  isSelected: boolean;
  onClick: () => void;
}) {
  const cls = [
    styles.row,
    isSelected ? styles.selected : '',
    order.status === 'flagged' ? styles.flaggedRow : '',
  ].filter(Boolean).join(' ');

  const { quotes } = useQuotes(order.id);
  const selectedQuote = quotes.find(q => q.selected) ?? null;

  const countryTag = order.country === 'CA' ? styles.tagCa : styles.tagUs;
  const isRiskAddress = order.address_verdict === 'apt' || order.address_verdict === 'condo' || order.address_verdict === 'remote';

  return (
    <div className={cls} onClick={onClick} role="button" tabIndex={0}>
      <div className={styles.rowName}>{order.customer_name}</div>
      <div className={styles.rowMeta}>
        <span className={`${styles.tag} ${countryTag}`}>{order.country}</span>
        {isRiskAddress && (
          <span className={`${styles.tag} ${styles.tagWarn}`}>{order.address_verdict}</span>
        )}
        {order.order_ref}
        {order.kind === 'replacement' && (
          <span className="replBadge">Replacement</span>
        )}
        {' '}· {order.city}
        {(() => {
          const u = orderUrgency(order.placed_at);
          if (!u.label) return null;
          return <span className={`${styles.urgencyChip} ${styles[u.severity]}`}>{u.label}</span>;
        })()}
        {selectedQuote && (
          <span style={{
            fontSize: 10, padding: '2px 8px', borderRadius: 4,
            background: 'var(--color-surface)', border: '1px solid var(--color-border)',
            color: 'var(--color-ink-muted)',
          }}>
            {selectedQuote.provider} {selectedQuote.rate_cad != null
              ? `$${selectedQuote.rate_cad.toFixed(0)} CAD`
              : selectedQuote.rate_usd != null
                ? `$${selectedQuote.rate_usd.toFixed(0)} USD`
                : ''}
            {selectedQuote.transit_days != null && ` · ${selectedQuote.transit_days}d`}
          </span>
        )}
      </div>
    </div>
  );
}
