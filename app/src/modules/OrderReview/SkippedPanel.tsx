import {
  SHOPIFY_SKIP_LABEL,
  type ShopifySyncResult,
  type ShopifySkipReason,
} from '../../lib/orders';
import styles from './OrderReview.module.css';

// Failures first — a db_error is the only reason here an operator has to act
// on, and it must never be buried under 30 reservations.
const SKIP_ORDER: ShopifySkipReason[] =
  ['db_error', 'no_shipping_address', 'international', 'missing_city'];

function skipDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The orders Shopify handed back that never became rows.
 *
 *  This used to be a bare "31 skipped" next to the button, which is how 27 $1
 *  LILA Mini Reservations and a $1,418 subscription buyout stayed invisible for
 *  a month — indistinguishable from a write failure, and unactionable either
 *  way. Naming each one is what makes it a decision instead of an alarm. */
export function SkippedPanel({ result, onClose }: {
  result: ShopifySyncResult;
  onClose: () => void;
}) {
  const groups = SKIP_ORDER
    .map(reason => ({
      reason,
      rows: result.skippedDetails.filter(s => s.reason === reason),
    }))
    .filter(g => g.rows.length > 0);

  return (
    <div className={styles.skipPanel} role="dialog" aria-label="Orders not imported">
      <div className={styles.skipHead}>
        <span>{result.skipped} of {result.fetched} Shopify orders not imported</span>
        <button type="button" className={styles.skipClose} onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className={styles.skipBody}>
        {groups.map(({ reason, rows }) => (
          <div key={reason} className={styles.skipGroup}>
            <div className={styles.skipGroupHead}>
              {SHOPIFY_SKIP_LABEL[reason]} · {rows.length}
            </div>
            {rows.map(s => (
              <div key={s.order_ref} className={styles.skipRow}>
                <span className={styles.skipRef}>{s.order_ref}</span>
                <span className={styles.skipMeta}>
                  {[
                    skipDate(s.placed_at),
                    s.total ? `${s.total} ${s.currency ?? ''}`.trim() : '',
                    s.customer ?? '',
                    s.items.join(', '),
                    s.detail,
                  ].filter(Boolean).join(' · ')}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className={styles.skipFoot}>
        makeLILA only stores orders with a US or Canadian shipping address. A
        no-ship product (a reservation, a subscription buyout) has no address to
        fulfil against, so it stays in Shopify.
      </div>
    </div>
  );
}

