import type { CustomerParties } from '../lib/customers';
import styles from './CustomerPartyName.module.css';

// FR-6: the single place a service ticket draws the person it's about.
//
// A ticket is about whoever USES the machine, so the primary user gets the
// headline. But the purchaser can never simply vanish — they hold the warranty
// and any refund books against them — so a split household always prints both.
//
// When there is only one person (the overwhelming majority) this renders a
// plain name and nothing else: role labels on every row would be noise that
// trains operators to stop reading them.

type Props = {
  parties: CustomerParties;
  /** 'inline' keeps both names on one line for dense rows (kanban cards,
   *  table cells) that can't afford a second line. */
  variant?: 'full' | 'inline';
  className?: string;
};

export function CustomerPartyName({ parties, variant = 'full', className }: Props) {
  const { displayName, purchaserName, split, relationship } = parties;
  const name = displayName || purchaserName || '—';

  if (!split) {
    return <span className={className}>{name}</span>;
  }

  const userLabel = relationship ? `Primary user · ${relationship}` : 'Primary user';

  if (variant === 'inline') {
    return (
      <span className={className}>
        {name}
        <span
          className={styles.inlineFor}
          title={`${name} is the primary user; ${purchaserName} purchased the machine.`}
        >
          {' '}for {purchaserName}
        </span>
      </span>
    );
  }

  return (
    <span className={`${styles.party} ${className ?? ''}`}>
      <span className={styles.nameRow}>
        <span className={styles.name}>{name}</span>
        <span
          className={`${styles.pill} ${styles.pillUser}`}
          title="The primary user of the machine — may differ from who paid for it."
        >
          {userLabel}
        </span>
      </span>
      <span className={styles.purchaserRow}>
        <span className={styles.purchaserLabel}>Purchaser:</span>{' '}
        <span className={styles.purchaserName}>{purchaserName}</span>
      </span>
    </span>
  );
}
