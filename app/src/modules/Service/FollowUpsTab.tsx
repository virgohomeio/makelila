import { useMemo, useState } from 'react';
import {
  useCustomers, computeFuState, FU1_DAYS, FU2_DAYS,
  type Customer, type FuState,
} from '../../lib/customers';
import { useServiceTickets } from '../../lib/service';
import { useFollowUpDirectory, type TicketFollowup } from '../../lib/followupStatus';
import { TicketDetailPanel } from './TicketDetailPanel';
import { FollowUpDirectory } from './FollowUpDirectory';
import { FollowUpDetailPanel } from './FollowUpDetailPanel';
import { OverdueFollowupPanel } from './OverdueFollowupPanel';
import { useIsMobile } from '../../lib/useMediaQuery';
import styles from './FollowUps.module.css';

const WEEK_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Two event kinds share the calendar: scheduled follow-ups (FU1/FU2, derived
// per-customer from onboard_date) and onboarding calls (from onboarding tickets
// with a booked Calendly time). Clicking a call opens its ticket.
type FuEvent = { type: 'fu'; customer: Customer; kind: 'fu1' | 'fu2'; dueDate: Date; state: FuState };
type CallEvent = { type: 'call'; callKind: 'onboarding' | 'diagnosis' | 'diag_followup' | 'ticket_followup'; label: string; time: string; ticketId: string };
type CalEvent = FuEvent | CallEvent;

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function FollowUpCalendar({
  month, today, customers, tickets, ticketFollowups, blockedCustomerIds, onPrev, onNext, onToday, onCustomerClick, onCallClick,
}: {
  month: Date;
  today: Date;
  customers: Customer[];
  tickets: { id: string; category: string; calendly_event_start: string | null; customer_name: string | null; subject: string; diagnosis_followup_done_at: string | null }[];
  ticketFollowups: TicketFollowup[];
  blockedCustomerIds: Set<string>;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onCustomerClick: (id: string, kind: 'fu1' | 'fu2') => void;
  onCallClick: (ticketId: string) => void;
}) {
  const monthStart = new Date(month);
  const gridStart = new Date(monthStart);
  gridStart.setDate(1 - monthStart.getDay());
  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridStart.getDate() + 42);

  const eventsByDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    const add = (k: string, ev: CalEvent) => {
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(ev);
    };
    // Onboarding calls — from onboarding tickets with a booked time.
    for (const t of tickets) {
      if (t.category === 'onboarding' && t.calendly_event_start) {
        add(t.calendly_event_start.slice(0, 10), {
          type: 'call', callKind: 'onboarding',
          label: t.customer_name ?? t.subject,
          time: t.calendly_event_start,
          ticketId: t.id,
        });
      }
    }
    // Diagnosis calls — from diagnosis_call tickets with a booked time.
    for (const t of tickets) {
      if (t.category === 'diagnosis_call' && t.calendly_event_start) {
        add(t.calendly_event_start.slice(0, 10), {
          type: 'call', callKind: 'diagnosis',
          label: t.customer_name ?? t.subject, time: t.calendly_event_start, ticketId: t.id,
        });
      }
    }
    // Diagnosis follow-ups — 14 days after a diagnosis call, until marked done.
    for (const t of tickets) {
      if (t.category === 'diagnosis_call' && t.calendly_event_start && !t.diagnosis_followup_done_at) {
        const due = new Date(t.calendly_event_start);
        due.setDate(due.getDate() + 14);
        add(dayKey(due), {
          type: 'call', callKind: 'diag_followup',
          label: t.customer_name ?? t.subject, time: due.toISOString(), ticketId: t.id,
        });
      }
    }
    // Ticket follow-ups — 14 days after a ticket closed (all tickets closed),
    // until marked done. Clicking opens the closed ticket.
    for (const tf of ticketFollowups) {
      add(tf.dueDate.slice(0, 10), {
        type: 'call', callKind: 'ticket_followup',
        label: tf.customerName, time: tf.dueDate, ticketId: tf.ticketId,
      });
    }
    // Follow-ups — FU1 = onboard_date + FU1_DAYS, FU2 = +FU2_DAYS, per customer
    // that hasn't had that follow-up done yet.
    for (const c of customers) {
      if (!c.onboard_date) continue;
      if (blockedCustomerIds.has(c.id)) continue; // follow-up on hold — skip FU markers
      const onboard = new Date(c.onboard_date + 'T00:00:00');
      const fu1 = new Date(onboard); fu1.setDate(fu1.getDate() + FU1_DAYS);
      const fu2 = new Date(onboard); fu2.setDate(fu2.getDate() + FU2_DAYS);
      const state = computeFuState(c, today);
      for (const [kind, dueDate] of [['fu1', fu1], ['fu2', fu2]] as const) {
        if (dueDate < gridStart || dueDate >= gridEnd) continue;
        if (kind === 'fu1' && c.fu1_status) continue;
        if (kind === 'fu2' && !c.fu1_status) continue;
        if (kind === 'fu2' && c.fu2_status) continue;
        add(dayKey(dueDate), { type: 'fu', customer: c, kind, dueDate, state });
      }
    }
    return m;
  }, [customers, tickets, ticketFollowups, blockedCustomerIds, today, gridStart, gridEnd]);

  const todayKey = dayKey(today);

  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    days.push(d);
  }

  return (
    <div className={styles.calWrap}>
      <div className={styles.calHeader}>
        <button className={styles.calNavBtn} onClick={onPrev} aria-label="Previous month">‹</button>
        <h3 className={styles.calMonth}>
          {month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
        </h3>
        <button className={styles.calNavBtn} onClick={onNext} aria-label="Next month">›</button>
        <button className={styles.calTodayBtn} onClick={onToday}>Today</button>
      </div>
      <div className={styles.calLegend}>
        <span className={styles.calLegendItem}>
          <span className={`${styles.calDot} ${styles.calDotCall}`} /> Onboarding call
        </span>
        <span className={styles.calLegendItem}>
          <span className={`${styles.calDot} ${styles.calDotDiagnosis}`} /> Diagnosis call
        </span>
        <span className={styles.calLegendItem}>
          <span className={`${styles.calDot} ${styles.calDotDiagFollowup}`} /> Diagnosis follow-up
        </span>
        <span className={styles.calLegendItem}>
          <span className={`${styles.calDot} ${styles.calDotFu1}`} /> FU1 — 2-week check-in
        </span>
        <span className={styles.calLegendItem}>
          <span className={`${styles.calDot} ${styles.calDotFu2}`} /> FU2 — 4-week check-in
        </span>
        <span className={styles.calLegendItem}>
          <span className={`${styles.calDot} ${styles.calDotOverdue}`} /> Overdue
        </span>
      </div>
      <div className={styles.calGrid}>
        {WEEK_DAYS.map(d => (
          <div key={d} className={styles.calDayHeader}>{d}</div>
        ))}
        {days.map(d => {
          const k = dayKey(d);
          const events = eventsByDay.get(k) ?? [];
          const isOtherMonth = d.getMonth() !== month.getMonth();
          const isToday = k === todayKey;
          const isPast = d < today && k !== todayKey;
          return (
            <div
              key={k}
              className={[
                styles.calDay,
                isOtherMonth ? styles.calDayOther : '',
                isToday ? styles.calDayToday : '',
              ].join(' ')}
            >
              <div className={styles.calDayNum}>{d.getDate()}</div>
              {events.map((ev, i) => {
                if (ev.type === 'call') {
                  const meta = {
                    onboarding:      { icon: '🚀', name: 'Onboarding call',     cls: styles.calEventCall },
                    diagnosis:       { icon: '🩺', name: 'Diagnosis call',      cls: styles.calEventDiagnosis },
                    diag_followup:   { icon: '🔁', name: 'Diagnosis follow-up', cls: styles.calEventDiagFollowup },
                    ticket_followup: { icon: '🎫', name: 'Ticket follow-up',    cls: styles.calEventDiagFollowup },
                  }[ev.callKind];
                  return (
                    <button key={`c${i}`} onClick={() => onCallClick(ev.ticketId)}
                      className={`${styles.calEvent} ${meta.cls}`}
                      title={`${meta.name} — ${ev.label}`}>
                      {meta.icon} {ev.label}
                    </button>
                  );
                }
                const overdue = isPast && !(ev.kind === 'fu1' ? ev.customer.fu1_status : ev.customer.fu2_status);
                return (
                  <button
                    key={`f${i}`}
                    onClick={() => onCustomerClick(ev.customer.id, ev.kind)}
                    className={[
                      styles.calEvent,
                      overdue
                        ? styles.calEventOverdue
                        : ev.kind === 'fu1' ? styles.calEventFu1 : styles.calEventFu2,
                    ].join(' ')}
                    title={`${ev.customer.full_name} — ${ev.kind.toUpperCase()} ${overdue ? 'overdue' : 'due'}`}
                  >
                    {ev.kind.toUpperCase()}: {ev.customer.full_name}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function FollowUpsTab() {
  const { customers, refresh } = useCustomers();
  const { tickets } = useServiceTickets();
  const today = useMemo(() => new Date(), []);
  const { rows, counts, overdueCount, excludedCustomerIds, ticketFollowups } = useFollowUpDirectory(today);

  // Overdue draft+send queue: customers needing action (overdue or due today),
  // most-overdue first (oldest onboard date). Mirrors the set the panel was
  // fed from the Customers tab.
  const overdueCustomerIds = useMemo(
    () => rows
      .filter(r => r.statuses.has('overdue') || r.statuses.has('due_today'))
      .sort((a, b) =>
        Number(b.statuses.has('overdue')) - Number(a.statuses.has('overdue'))
        || (a.customer.onboard_date ?? '').localeCompare(b.customer.onboard_date ?? ''))
      .map(r => r.customer.id),
    [rows],
  );

  // Customers whose follow-up is on hold (queued replacement / open ticket) —
  // their FU markers are suppressed on the calendar.
  const blockedCustomerIds = useMemo(
    () => new Set(rows.filter(r => r.statuses.has('fu_on_hold')).map(r => r.customer.id)),
    [rows],
  );

  const isMobile = useIsMobile();
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => {
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d;
  });
  const [selected, setSelected] = useState<{ customerId: string; kind: 'fu1' | 'fu2' } | null>(null);
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);

  const scheduledCustomers = useMemo(
    () => customers.filter(c => !!c.onboard_date && !excludedCustomerIds.has(c.id)),
    [customers, excludedCustomerIds],
  );

  const selectedCustomer = useMemo(
    () => customers.find(c => c.id === selected?.customerId) ?? null,
    [customers, selected],
  );

  // The selected customer's open (non-closed) tickets + whether their
  // follow-ups are on hold (open ticket / queued replacement / returned).
  const selectedOpenTickets = useMemo(() => {
    if (!selectedCustomer) return [];
    const lc = (selectedCustomer.email ?? '').toLowerCase();
    return tickets.filter(t => t.status !== 'closed'
      && (t.customer_id === selectedCustomer.id
          || (!!t.customer_email && t.customer_email.toLowerCase() === lc)));
  }, [tickets, selectedCustomer]);

  const selectedPaused = useMemo(() => {
    if (!selectedCustomer) return false;
    const row = rows.find(r => r.customer.id === selectedCustomer.id);
    return selectedOpenTickets.length > 0 || (row?.statuses.has('fu_on_hold') ?? false);
  }, [rows, selectedCustomer, selectedOpenTickets]);

  const openTicket = openTicketId ? tickets.find(t => t.id === openTicketId) ?? null : null;

  return (
    <div className={styles.wrap}>
      <OverdueFollowupPanel
        overdueCount={overdueCustomerIds.length}
        overdueCustomerIds={overdueCustomerIds}
      />
      <div className={isMobile ? styles.layoutStack : styles.layoutSplit}>
        <div className={styles.calCol}>
          <FollowUpCalendar
            month={calendarMonth}
            today={today}
            customers={scheduledCustomers}
            tickets={tickets}
            ticketFollowups={ticketFollowups}
            blockedCustomerIds={blockedCustomerIds}
            onPrev={() => setCalendarMonth(d => { const n = new Date(d); n.setMonth(n.getMonth() - 1); return n; })}
            onNext={() => setCalendarMonth(d => { const n = new Date(d); n.setMonth(n.getMonth() + 1); return n; })}
            onToday={() => setCalendarMonth(() => { const n = new Date(); n.setDate(1); n.setHours(0, 0, 0, 0); return n; })}
            onCustomerClick={(id, kind) => setSelected({ customerId: id, kind })}
            onCallClick={(ticketId) => setOpenTicketId(ticketId)}
          />
        </div>
        <FollowUpDirectory
          rows={rows} counts={counts} overdueCount={overdueCount}
          onSelect={(id) => setSelected({ customerId: id, kind: 'fu1' })}
        />
      </div>
      {selectedCustomer && (
        <FollowUpDetailPanel
          customer={selectedCustomer}
          openTickets={selectedOpenTickets}
          isPaused={selectedPaused}
          ticketFollowup={ticketFollowups.find(tf => tf.customerId === selectedCustomer.id) ?? null}
          diagnosisTicketId={
            tickets.find(t => t.category === 'diagnosis_call' && !t.diagnosis_followup_done_at
              && t.calendly_event_start != null
              && (t.customer_id === selectedCustomer.id
                  || (!!t.customer_email && t.customer_email.toLowerCase() === (selectedCustomer.email ?? '').toLowerCase())))?.id ?? null
          }
          onClose={() => setSelected(null)}
          onChanged={() => void refresh()}
        />
      )}
      {openTicket && <TicketDetailPanel ticket={openTicket} onClose={() => setOpenTicketId(null)} />}
    </div>
  );
}
