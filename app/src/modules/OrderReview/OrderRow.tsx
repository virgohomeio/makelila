import type { CSSProperties } from 'react';
import type { Order } from '../../lib/orders';
import { orderUrgency, AREA_TYPE_TAG } from '../../lib/orders';
import { refundFlagLabel, refundFlagTitle, type RefundFlag } from '../../lib/refundedOrders';
import { useQuotes } from '../../lib/freight';
import { canConfirm } from './detail/ReadinessChecklist';
import styles from './OrderReview.module.css';

const AREA_TAG_CLASS: Record<NonNullable<Order['area_type']>, string> = {
  urban:    styles.tagUrban,
  suburban: styles.tagSuburban,
  rural:    styles.tagRural,
};

/** One row in the order rail.
 *
 *  A 2×2 grid, not a flowing meta line. Identity (name, ref, city) sits left;
 *  state (blocker dot, SLA, country/area/risk tags) sits in a right-aligned
 *  column so it forms real columns down the list. Comparing two orders used to
 *  mean reading two wrapped sentences. */
export function OrderRow({
  order,
  isSelected,
  onClick,
  revealIndex = 0,
  refundFlag = null,
}: {
  order: Order;
  isSelected: boolean;
  onClick: () => void;
  /** Position in the load stagger. See --i in OrderReview.module.css. */
  revealIndex?: number;
  /** Set when this order — or another order of this customer — has been
   *  refunded. Confirming a refunded order queues a machine for someone we
   *  have already paid back, and until this badge existed the row gave the
   *  operator no way to know. */
  refundFlag?: RefundFlag | null;
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
  const isCancelled = order.status === 'cancelled';
  // A dot rather than a chip: it says "this one isn't confirmable yet" without
  // spending the width the SLA needs. Meaningless on terminal/decided rows.
  const showBlockDot = !isCancelled && order.status !== 'approved' && !canConfirm(order);
  const urgency = orderUrgency(order.placed_at);

  const quoteLabel = selectedQuote
    ? [
        selectedQuote.provider,
        selectedQuote.rate_cad != null
          ? `$${selectedQuote.rate_cad.toFixed(0)} CAD`
          : selectedQuote.rate_usd != null
            ? `$${selectedQuote.rate_usd.toFixed(0)} USD`
            : null,
        selectedQuote.transit_days != null ? `${selectedQuote.transit_days}d` : null,
      ].filter(Boolean).join(' ')
    : null;

  // Read in order, the row's own text announces as one run-on string
  // ("Alice Ames125d OVERDUE#p1· PortlandUS"). Spell it out instead.
  const label = [
    order.customer_name,
    `order ${order.order_ref}`,
    order.city,
    isCancelled ? 'cancelled' : urgency.label || null,
    showBlockDot ? 'not yet confirmable' : null,
    refundFlag ? refundFlagLabel(refundFlag).toLowerCase() : null,
  ].filter(Boolean).join(', ');

  return (
    <button
      type="button"
      className={cls}
      onClick={onClick}
      aria-label={label}
      style={{ '--i': revealIndex } as CSSProperties}
    >
      <span className={styles.rowName}>{order.customer_name}</span>

      <span className={styles.rowState}>
        {showBlockDot && (
          <span
            className={styles.blockDot}
            title="Not yet confirmable — open it to see what's missing"
          />
        )}
        {isCancelled ? (
          // An SLA countdown on a dead order is noise — say what happened.
          <span className={styles.cancelledChip} title={order.cancelled_reason ?? undefined}>
            Cancelled
          </span>
        ) : urgency.label ? (
          <span className={`${styles.urgencyChip} ${styles[urgency.severity]}`}>{urgency.label}</span>
        ) : null}
      </span>

      <span className={styles.rowMeta}>
        <span className={styles.rowRef}>{order.order_ref}</span>
        <span>· {order.city}</span>
        {quoteLabel && <span className={styles.rowFreight}>· {quoteLabel}</span>}
      </span>

      <span className={styles.rowTags}>
        {refundFlag && (
          <span
            className={`${styles.tag} ${refundFlag.level === 'order' ? styles.tagRefunded : styles.tagRefundedCustomer}`}
            title={refundFlagTitle(refundFlag)}
          >
            {refundFlagLabel(refundFlag)}
          </span>
        )}
        {order.kind === 'replacement' && (
          <span className={`${styles.tag} ${styles.tagCa}`}>Repl</span>
        )}
        {isRiskAddress && (
          <span className={`${styles.tag} ${styles.tagWarn}`}>{order.address_verdict}</span>
        )}
        {order.area_type && (
          <span className={`${styles.tag} ${AREA_TAG_CLASS[order.area_type]}`}>{AREA_TYPE_TAG[order.area_type]}</span>
        )}
        <span className={`${styles.tag} ${countryTag}`}>{order.country}</span>
      </span>
    </button>
  );
}
