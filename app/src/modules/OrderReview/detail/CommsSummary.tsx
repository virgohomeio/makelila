import { useState } from 'react';
import {
  CONCERN_LABELS, VERDICT_LABEL, channelFootnote, commDetail, commTone, shortDate,
} from '../../../lib/commAssessment';
import { requestCommAssessment, type OrderCommAssessment } from '../../../lib/orderComms';
import styles from '../OrderReview.module.css';

const TONE_CLASS = {
  good:    styles.commGood,
  warn:    styles.commWarn,
  unknown: styles.commUnknown,
} as const;

const TONE_ICON = { good: '✓', warn: '⚠', unknown: '·' } as const;

/** What the customer has said to support lately, and whether any of it is a
 *  reason not to ship.
 *
 *  Sits in the Customer card because that is where an operator is already
 *  looking when they decide to confirm an order — the alternative, a separate
 *  card further down, is a card they have to remember to scroll to.
 *
 *  The channel footnote is not decoration. Support email has never been
 *  connected in production (the Gmail sync is cron'd but its service-account
 *  secrets are unset), so a clearance here can be built on SMS alone. The box
 *  says which channels it actually read so "clear to ship" is never mistaken
 *  for a stronger claim than it is. */
export function CommsSummary({
  orderId,
  assessment,
  loading,
}: {
  orderId: string;
  assessment: OrderCommAssessment | null;
  loading: boolean;
}) {
  const [rechecking, setRechecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recheck = async () => {
    setRechecking(true);
    setError(null);
    try {
      await requestCommAssessment(orderId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRechecking(false);
    }
  };

  if (loading) {
    return (
      <div className={`${styles.commBox} ${styles.commUnknown}`}>
        <div className={styles.commHeadline}>Checking recent customer communication…</div>
      </div>
    );
  }

  const tone = commTone(assessment?.verdict);
  // The verdict reads identically on every order; the model's own sentence
  // follows it as the detail. Scanning a queue is the first job, knowing why
  // is the second.
  const label = assessment
    ? VERDICT_LABEL[assessment.verdict]
    : 'Recent communication not yet checked for this order';
  const detail = commDetail(assessment?.verdict, assessment?.headline);

  return (
    <div className={`${styles.commBox} ${TONE_CLASS[tone]}`}>
      <div className={styles.commHeadline}>
        <span aria-hidden="true" className={styles.commIcon}>{TONE_ICON[tone]}</span>
        {label}
      </div>
      {detail && <div className={styles.commDetail}>{detail}</div>}

      {!!assessment?.concerns?.length && (
        <div className={styles.commConcerns}>
          {assessment.concerns.map(c => (
            <span key={c} className={styles.commConcern}>{CONCERN_LABELS[c]}</span>
          ))}
        </div>
      )}

      {/* At most two quotes. The point is to show the operator enough to
          recognise the conversation, not to reproduce it — the full thread is
          one click away in Quo. */}
      {assessment?.evidence?.slice(0, 2).map((ev, i) => (
        <blockquote key={i} className={styles.commQuote}>
          “{ev.excerpt}”
          <cite>
            {ev.channel === 'quo' ? 'SMS' : 'Email'}
            {' · '}
            {ev.direction === 'inbound' ? 'customer' : 'support'}
            {shortDate(ev.sent_at) ? ` · ${shortDate(ev.sent_at)}` : ''}
          </cite>
        </blockquote>
      ))}

      <div className={styles.commFoot}>
        <span>{channelFootnote(assessment?.channels_scanned ?? null)}</span>
        <button
          type="button"
          className={styles.commRecheck}
          onClick={recheck}
          disabled={rechecking}
        >
          {rechecking ? 'Checking…' : 'Re-check'}
        </button>
      </div>

      {/* A failed read is stated, never swallowed: a card that silently keeps
          showing yesterday's clearance is worse than one that admits it is
          stale. */}
      {(error || assessment?.error) && (
        <div className={styles.commError}>
          Last check failed: {error ?? assessment?.error}
        </div>
      )}
    </div>
  );
}
