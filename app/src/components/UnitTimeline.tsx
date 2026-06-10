import { useMemo } from 'react';
import { useUnitTimeline, type TimelineEvent } from '../lib/stock';
import styles from './UnitTimeline.module.css';

const COMPACT_LIMIT = 10;

// ── Relative time helper ───────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (isNaN(diffMs)) return iso;

  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60)   return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60)   return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24)    return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30)   return `${diffDay}d ago`;
  const diffMon = Math.floor(diffDay / 30);
  if (diffMon < 12)   return `${diffMon}mo ago`;
  return `${Math.floor(diffMon / 12)}y ago`;
}

// ── Dot class per event kind ──────────────────────────────────────────────────

function dotClass(kind: TimelineEvent['kind']): string {
  switch (kind) {
    case 'built':            return styles.dotBuilt;
    case 'qc_passed':        return styles.dotQcPassed;
    case 'qc_failed':        return styles.dotQcFailed;
    case 'shipped':          return styles.dotShipped;
    case 'returned':         return styles.dotReturned;
    case 'quarantined':      return styles.dotQuarantined;
    case 'ticket_opened':    return styles.dotTicketOpened;
    case 'ticket_resolved':  return styles.dotTicketResolved;
    case 'telemetry_event':  return styles.dotTelemetry;
    case 'activity':         return styles.dotActivity;
  }
}

// ── Dot symbol per event kind ─────────────────────────────────────────────────

function dotSymbol(kind: TimelineEvent['kind']): string {
  switch (kind) {
    case 'built':            return '●';
    case 'qc_passed':        return '✓';
    case 'qc_failed':        return '✗';
    case 'shipped':          return '→';
    case 'returned':         return '↩';
    case 'quarantined':      return '!';
    case 'ticket_opened':    return 'T';
    case 'ticket_resolved':  return '✓';
    case 'telemetry_event':  return '~';
    case 'activity':         return '·';
  }
}

// ── EventRow ──────────────────────────────────────────────────────────────────

function EventRow({ event }: { event: TimelineEvent }) {
  return (
    <div className={styles.event}>
      <span className={`${styles.dot} ${dotClass(event.kind)}`}>
        {dotSymbol(event.kind)}
      </span>
      <div className={styles.body}>
        <div className={styles.label}>{event.label}</div>
        {event.detail && <div className={styles.detail}>{event.detail}</div>}
      </div>
      <div className={styles.time}>{relativeTime(event.ts)}</div>
    </div>
  );
}

// ── UnitTimeline ──────────────────────────────────────────────────────────────

interface Props {
  unitSerial: string;
  density?: 'compact' | 'full';
}

export function UnitTimeline({ unitSerial, density = 'compact' }: Props) {
  const { events, loading } = useUnitTimeline(unitSerial);

  const visible = useMemo(
    () => density === 'compact' ? events.slice(0, COMPACT_LIMIT) : events,
    [events, density],
  );

  const hidden = density === 'compact' ? events.length - visible.length : 0;

  if (loading) {
    return <div className={styles.loading}>Loading history…</div>;
  }

  if (events.length === 0) {
    return <div className={styles.empty}>No history found for this unit.</div>;
  }

  return (
    <div className={styles.timeline}>
      {visible.map(e => <EventRow key={e.id} event={e} />)}
      {hidden > 0 && (
        <button className={styles.showMore} disabled>
          +{hidden} more events (open full view)
        </button>
      )}
    </div>
  );
}
