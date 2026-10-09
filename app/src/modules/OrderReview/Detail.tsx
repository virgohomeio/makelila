import { useCallback, useState } from 'react';
import type { Order } from '../../lib/orders';
import {
  disposition, needInfo, addOrderNote, orderUrgency, orderDue, cancelOrder, uncancelOrder,
  queueReplacementForFulfillment,
} from '../../lib/orders';
import { releaseHold } from '../../lib/fulfillment';
import { useAuth } from '../../lib/auth';
import { CustomerCard } from './detail/CustomerCard';
import { AddressCard }  from './detail/AddressCard';
import { FreightCard }  from './detail/FreightCard';
import { LineItemsCard } from './detail/LineItemsCard';
import { NotesCard }    from './detail/NotesCard';
import { PaymentCard } from './detail/PaymentCard';
import { InvoicesCard } from './detail/InvoicesCard';
import { ActionBar }    from './detail/ActionBar';
import { ConfirmBanner } from './detail/ConfirmBanner';
import { PreConfirmChecks } from './detail/PreConfirmChecks';
import { ReadinessChecklist, canConfirm } from './detail/ReadinessChecklist';
import styles from './OrderReview.module.css';

type Banner = { variant: 'success' | 'error'; message: string } | null;

/** Returned by a wrap()ped action that finished without dispositioning the
 *  order — no banner, and the panel keeps its place. The action has put its own
 *  question on screen instead and is waiting for an answer. Only the
 *  short-stock override uses it. */
const HALT = Symbol('halt');

export function Detail({
  order,
  onAfterDisposition,
}: {
  order: Order;
  onAfterDisposition: () => void;
}) {
  const [banner, setBanner] = useState<Banner>(null);
  const dismissBanner = useCallback(() => setBanner(null), []);
  // Set when a re-queue came back short: the parts it is short of, which the
  // action bar turns into the override question. Null the rest of the time.
  const [shortStock, setShortStock] = useState<string | null>(null);
  const { profile, user } = useAuth();
  const authorName = profile?.display_name ?? user?.email ?? 'Unknown';

  const wrap = async (
    label: string,
    /** A string return is appended to the success banner — for actions whose
     *  outcome is only known once they have run (see onReleaseHold). */
    fn: () => Promise<void | string | typeof HALT>,
    noteLabel?: string,
    reason?: string,
    /** Dispositioning moves on to the next order in the queue, which is the
     *  right behaviour for a work queue. Un-cancelling is not queue work: the
     *  operator is fixing THIS order and needs to see it land in Pending, so it
     *  stays put. */
    opts?: { stay?: boolean },
  ) => {
    try {
      const detail = await fn();
      if (detail === HALT) return;
      const trimmed = reason?.trim();
      if (noteLabel && trimmed) {
        await addOrderNote(order.id, authorName, `${noteLabel}: ${trimmed}`);
      }
      setBanner({
        variant: 'success',
        message: `${label}${detail ? ` — ${detail}` : ''} · ${order.customer_name}`,
      });
      if (!opts?.stay) onAfterDisposition();
    } catch (err) {
      setBanner({
        variant: 'error',
        message: `Failed: ${(err as Error).message ?? 'unknown error'}`,
      });
    }
  };

  /** Clear a flagged replacement's flag by sending it back through the
   *  replacement re-queue path. Unforced, a short stock count comes back as a
   *  question in the action bar instead of a failure; forced, it queues anyway
   *  and queueReplacementForFulfillment records the override in the log. */
  const clearReplacementFlag = (force: boolean) => wrap(
    'Flag cleared',
    async () => {
      const short = shortStock;
      const r = await queueReplacementForFulfillment(order.id, { force });
      if (!r.queued) {
        setShortStock(r.blocked);
        return HALT;
      }
      setShortStock(null);
      return force && short
        ? `queued anyway with stock short (${short}) — in Fulfillment › Queue`
        : 'stock re-checked, back in Fulfillment › Queue';
    },
  );

  const confirmReady = canConfirm(order);
  const isCancelled = order.status === 'cancelled';

  // The confirm SLA is stated once per surface, in one vocabulary. It used to
  // appear three times — a chip on the row, a banner in the body, and a "Due:"
  // pill in the action bar — each phrased differently. The rail chip and the
  // header below now render the identical label from orderUrgency().
  const basis = order.placed_at ?? order.created_at;
  const urgency = orderUrgency(basis);
  const due = orderDue(basis);
  const showSla = order.kind === 'sale' && !isCancelled && !!urgency.label;

  return (
    <section className={styles.detail}>
      {/* Identity is pinned above the actions, so you always know which order
          you are acting on — including while a reason drawer is open. */}
      <div className={styles.detailHead}>
        <div className={styles.detailId}>
          <span className={styles.detailRef}>{order.order_ref}</span>
          <span className={styles.detailName}>{order.customer_name}</span>
          <span className={styles.detailWhere}>
            {order.city}
            {order.region_state ? `, ${order.region_state}` : ''} {order.country}
          </span>
          {showSla && (
            <span
              className={`${styles.slaBig} ${styles[urgency.severity]}`}
              title="Order-confirmation SLA: placed date + 2 days"
            >
              Due {due.dueLabel} · {urgency.label}
            </span>
          )}
        </div>
        <ActionBar
          order={order}
          confirmReady={confirmReady}
          onApprove={() => wrap('Approved', () => disposition(order, 'approved'))}
          onFlag={(reason) => wrap('Flagged', () => disposition(order, 'flagged', reason), 'Flagged', reason)}
          onHold={(reason) => wrap('Held',    () => disposition(order, 'held',    reason), 'Held', reason)}
          onNeedInfo={(note) => wrap('Need-info logged', () => needInfo(order, note), 'Need info', note)}
          onCancelOrder={(reason) => wrap('Cancelled', () => cancelOrder(order.id, reason), 'Cancelled', reason)}
          // The only action a flagged replacement gets here. It goes back
          // through the replacement pipeline's own door rather than through
          // Confirm, so the stock it needs is re-derived now instead of being
          // read off a replacement_state stamped months ago.
          //
          // A short count asks rather than refuses, exactly as the same button
          // on Fulfillment › Replacements does. It used to send the operator to
          // that other screen to click the identical override, which left a
          // flagged replacement with no way out of Sales at all whenever the
          // parts table disagreed — and it disagrees routinely, because half
          // these rows came off the Excel import as free text it can't match.
          // The person holding the box is the one who knows; both screens now
          // let them say so, through the same vetted `force` path that logs the
          // override on the order.
          onClearReplacementFlag={order.kind === 'replacement'
            ? () => clearReplacementFlag(false)
            : undefined}
          clearFlagBlockedBy={shortStock}
          onForceClearReplacementFlag={() => clearReplacementFlag(true)}
          onDismissClearFlagBlock={() => setShortStock(null)}
          // Like un-cancelling, this is a repair rather than queue work: the
          // operator is fixing THIS order and needs to watch it land in
          // Pending, so the panel stays put instead of advancing.
          onReleaseHold={order.status === 'held' ? () => wrap(
            'Hold released',
            async () => {
              const r = await releaseHold(order.id);
              const where = `back to ${r.landing.label}`;
              if (!r.queueRowRemoved) return where;
              const unit = r.releasedSerials.length > 0
                ? `, unit${r.releasedSerials.length === 1 ? '' : 's'} ${r.releasedSerials.join(', ')} back to stock`
                : '';
              return `${where}; its open fulfillment row was pulled${unit}`;
            },
            'Hold released',
            'moved back to Pending for review',
            { stay: true },
          ) : undefined}
          onUncancel={isCancelled ? () => wrap(
            'Moved back to Pending',
            () => uncancelOrder(order.id),
            // The note quotes the reason it is undoing, so the order's own log
            // reads as a pair rather than as two unrelated status flips.
            'Moved back to Pending',
            order.cancelled_reason
              ? `reversing the cancellation "${order.cancelled_reason}"`
              : 'cancelled in error',
            { stay: true },
          ) : undefined}
        />
      </div>

      <ConfirmBanner banner={banner} onDismiss={dismissBanner} />

      {/* Directly under the button it gates. */}
      {!isCancelled && <ReadinessChecklist order={order} />}

      <div className={styles.detailBody}>
        {/* The pre-ship checks lead the scrollable body rather than sitting in
            the pinned header with the action bar and the blocker strip. Pinned,
            they were `flex: none` in a `flex-direction: column` pane that
            `overflow: hidden`s — so once the summary filled in, the panel and
            the two strips above it could between them claim the whole pane
            height, squeeze .detailBody to nothing, and clip every card below
            out of reach with no way to scroll to them.
            First in the body still puts them under Confirm order, and now the
            whole card scrolls as one column. */}
        {!isCancelled && order.kind === 'sale' && <PreConfirmChecks order={order} />}

        {/* Eight equal cards in one flat column meant scrolling to find
            anything. They now group by the question they answer. */}
        <div className={styles.group}>
          <div className={styles.groupLabel}>Review</div>
          <div className={styles.cards}>
            <CustomerCard order={order} />
            <AddressCard order={order} />
          </div>
        </div>

        <div className={styles.group}>
          <div className={styles.groupLabel}>Fulfilment</div>
          <div className={styles.cards}>
            {order.kind === 'sale' && <FreightCard order={order} />}
            <LineItemsCard order={order} />
          </div>
        </div>

        {order.kind === 'sale' && (
          <div className={styles.group}>
            <div className={styles.groupLabel}>Money</div>
            <div className={styles.cards}>
              <PaymentCard order={order} />
              <InvoicesCard order={order} />
            </div>
          </div>
        )}

        <div className={styles.group}>
          <div className={styles.groupLabel}>Log</div>
          <div className={`${styles.cards} ${styles.cardsWide}`}>
            <NotesCard order={order} />
          </div>
        </div>
      </div>
    </section>
  );
}
