import { useMemo, useState } from 'react';
import { useCustomers, FU1_DAYS, FU2_DAYS } from '../../lib/customers';
import { useServiceTickets } from '../../lib/service';
import { TicketDetailPanel } from './TicketDetailPanel';
import styles from './Service.module.css';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type CalEvent =
  | { kind: 'call'; label: string; time: string; ticketId: string }
  | { kind: 'fu1' | 'fu2'; label: string };

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 6-week (42-cell) grid starting on the Sunday on/before the 1st. */
function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

export function FollowUpsTab() {
  const { customers } = useCustomers();
  const { tickets } = useServiceTickets();
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
  // `new Date()` in a useState initializer runs once (not on every render), so
  // it doesn't trip react-hooks/purity. Anchors "today" + the initial month.
  const [now] = useState(() => new Date());
  const [cal, setCal] = useState(() => ({ year: now.getFullYear(), month: now.getMonth() }));
  const todayStr = ymd(now);

  // Map YYYY-MM-DD → events (onboarding calls + FU1/FU2 due dates).
  const eventsByDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    const add = (key: string, ev: CalEvent) => {
      const list = m.get(key) ?? [];
      list.push(ev);
      m.set(key, list);
    };
    // Onboarding calls — from onboarding tickets with a booked time.
    for (const t of tickets) {
      if (t.category === 'onboarding' && t.calendly_event_start) {
        add(t.calendly_event_start.slice(0, 10), {
          kind: 'call',
          label: t.customer_name ?? t.subject,
          time: t.calendly_event_start,
          ticketId: t.id,
        });
      }
    }
    // Follow-ups — FU1 = onboard_date + 14d, FU2 = +28d, per customer that
    // hasn't had that follow-up done yet. onboard_date = the call-complete date.
    for (const c of customers) {
      if (!c.onboard_date) continue;
      const base = new Date(c.onboard_date + 'T00:00:00');
      const name = c.full_name || c.email || '(unknown)';
      if (!c.fu1_status) {
        const d = new Date(base); d.setDate(d.getDate() + FU1_DAYS);
        add(ymd(d), { kind: 'fu1', label: name });
      }
      if (!c.fu2_status) {
        const d = new Date(base); d.setDate(d.getDate() + FU2_DAYS);
        add(ymd(d), { kind: 'fu2', label: name });
      }
    }
    return m;
  }, [tickets, customers]);

  const grid = useMemo(() => monthGrid(cal.year, cal.month), [cal]);
  const openTicket = openTicketId ? tickets.find(t => t.id === openTicketId) ?? null : null;

  const step = (delta: number) => setCal(c => {
    const d = new Date(c.year, c.month + delta, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  return (
    <>
      <div className={styles.calHeader}>
        <button className={styles.calNav} onClick={() => step(-1)} aria-label="Previous month">‹</button>
        <h3 className={styles.calTitle}>{MONTHS[cal.month]} {cal.year}</h3>
        <button className={styles.calNav} onClick={() => step(1)} aria-label="Next month">›</button>
        <button className={styles.calToday} onClick={() => setCal({ year: now.getFullYear(), month: now.getMonth() })}>Today</button>
        <span className={styles.calLegend}>
          <span className={styles.calLegCall}>● Onboarding call</span>
          <span className={styles.calLegFu1}>● FU1 (+2wk)</span>
          <span className={styles.calLegFu2}>● FU2 (+4wk)</span>
        </span>
      </div>

      <div className={styles.calGrid}>
        {DOW.map(d => <div key={d} className={styles.calDow}>{d}</div>)}
        {grid.map(d => {
          const key = ymd(d);
          const evs = eventsByDay.get(key) ?? [];
          const inMonth = d.getMonth() === cal.month;
          const isToday = key === todayStr;
          return (
            <div key={key} className={`${styles.calCell} ${inMonth ? '' : styles.calCellOut} ${isToday ? styles.calCellToday : ''}`}>
              <div className={styles.calDayNum}>{d.getDate()}</div>
              {evs.map((ev, i) => ev.kind === 'call' ? (
                <button
                  key={`c${i}`}
                  className={`${styles.calEvent} ${styles.calEventCall}`}
                  title={`Onboarding call — ${ev.label} · ${new Date(ev.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}
                  onClick={() => setOpenTicketId(ev.ticketId)}
                >🚀 {ev.label}</button>
              ) : (
                <div
                  key={`f${i}`}
                  className={`${styles.calEvent} ${ev.kind === 'fu1' ? styles.calEventFu1 : styles.calEventFu2}`}
                  title={`${ev.kind.toUpperCase()} follow-up — ${ev.label}`}
                >📞 {ev.kind === 'fu1' ? 'FU1' : 'FU2'}: {ev.label}</div>
              ))}
            </div>
          );
        })}
      </div>

      {openTicket && <TicketDetailPanel ticket={openTicket} onClose={() => setOpenTicketId(null)} />}
    </>
  );
}
