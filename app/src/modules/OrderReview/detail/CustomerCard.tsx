import type { Order } from '../../../lib/orders';
import { CUSTOMER_CARD_ID } from './anchors';
import styles from '../OrderReview.module.css';

/** Missing contact data carries its own repair action. It used to be inert
 *  text reading "Missing — complete via QUO" while the QUO link sat at the
 *  bottom of the card. */
function MissingField({ quoUrl }: { quoUrl: string | null }) {
  return (
    <span className={styles.missing}>
      Not on file
      {quoUrl && (
        <a
          className={styles.missingFix}
          href={quoUrl}
          target="_blank"
          rel="noopener noreferrer"
        >Get via QUO ↗</a>
      )}
    </span>
  );
}

export function CustomerCard({ order }: { order: Order }) {
  const quoUrl = order.quo_thread_url;

  return (
    <div className={styles.card} id={CUSTOMER_CARD_ID}>
      <div className={styles.cardHead}>Customer</div>
      <div className={styles.cardBody}>
        <div style={{ fontWeight: 700 }}>{order.customer_name}</div>

        <div className={styles.contactLine}>
          <span className={styles.contactLabel}>Email</span>
          {order.customer_email
            ? <span>{order.customer_email}</span>
            : <MissingField quoUrl={quoUrl} />}
        </div>

        <div className={styles.contactLine}>
          <span className={styles.contactLabel}>Phone</span>
          {order.customer_phone
            ? <span>{order.customer_phone}</span>
            : <MissingField quoUrl={quoUrl} />}
        </div>

        {quoUrl && (
          <a
            className={styles.quoLink}
            href={quoUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ marginTop: 10 }}
          >
            Open QUO ↗
          </a>
        )}
      </div>
    </div>
  );
}
