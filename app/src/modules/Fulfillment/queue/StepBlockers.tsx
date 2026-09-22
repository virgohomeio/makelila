import styles from '../Fulfillment.module.css';

/** "a, b and c" — the blockers read as a sentence, not a bullet list. */
export function listPhrase(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Sits beside a disabled step button and names what it is still waiting for.
 *
 *  Every step in the queue gates its Confirm on some combination of fields,
 *  and a bare greyed-out button leaves the operator guessing which one — the
 *  Amazon starter-kit number on a US order was the worst of these, invisible
 *  under a Freightcom card that already looked complete. Renders nothing once
 *  there is nothing left to name. */
export function StepBlockers({ blockers }: { blockers: string[] }) {
  if (blockers.length === 0) return null;
  return (
    <span className={styles.labelBlockers} data-testid="step-blockers">
      Still needs {listPhrase(blockers)}.
    </span>
  );
}
