import { useMemo, useState } from 'react';
import {
  reassignTicketOwner, priorityMeta, topicLabel,
  type ServiceTicket, type TicketPriority,
} from '../../lib/service';
import styles from './Service.module.css';

// A compact, owner-swimlane board that sits under the KPI strip. Columns are
// the owners who currently hold ≥1 active (non-closed) ticket, plus an
// "Unassigned" pool. Drag a card between columns to reassign — which reuses
// reassignTicketOwner, so the same email-on-assignment rule applies. The board
// is read-through otherwise: clicking a card opens the ticket detail panel.

const UNASSIGNED = '__unassigned__';

const PRIORITY_RANK: Record<TicketPriority, number> = {
  urgent: 0, high: 1, normal: 2, low: 3,
};

/** owner local-part for a compact column header / chip ('reina@…' → 'reina'). */
function ownerShort(email: string): string {
  return email.split('@')[0] || email;
}

type Column = { key: string; label: string; owner: string | null; tickets: ServiceTicket[] };

function buildColumns(tickets: ServiceTicket[]): Column[] {
  const active = tickets.filter(t => t.status !== 'closed');
  const groups = new Map<string, ServiceTicket[]>();
  for (const t of active) {
    const key = t.owner_email ?? UNASSIGNED;
    const arr = groups.get(key);
    if (arr) arr.push(t); else groups.set(key, [t]);
  }
  const sortTickets = (a: ServiceTicket, b: ServiceTicket) => {
    const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (pr !== 0) return pr;
    // Older first (longest-waiting bubbles up).
    const at = a.last_message_at ?? a.created_at;
    const bt = b.last_message_at ?? b.created_at;
    return new Date(at).getTime() - new Date(bt).getTime();
  };

  const ownerKeys = [...groups.keys()].filter(k => k !== UNASSIGNED).sort();
  const cols: Column[] = ownerKeys.map(owner => ({
    key: owner,
    label: ownerShort(owner),
    owner,
    tickets: (groups.get(owner) ?? []).slice().sort(sortTickets),
  }));
  // Unassigned pool leads the board — it's the backlog operators pull from.
  if (groups.has(UNASSIGNED)) {
    cols.unshift({
      key: UNASSIGNED,
      label: 'Unassigned',
      owner: null,
      tickets: (groups.get(UNASSIGNED) ?? []).slice().sort(sortTickets),
    });
  }
  return cols;
}

type Props = {
  tickets: ServiceTicket[];
  currentUserEmail: string | null | undefined;
  onSelectTicket: (t: ServiceTicket) => void;
};

export function OwnerKanban({ tickets, currentUserEmail, onSelectTicket }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const columns = useMemo(() => buildColumns(tickets), [tickets]);
  const activeCount = useMemo(() => tickets.filter(t => t.status !== 'closed').length, [tickets]);

  async function handleDrop(col: Column) {
    const id = dragId;
    setDragId(null);
    setOverCol(null);
    if (!id) return;
    const ticket = tickets.find(t => t.id === id);
    if (!ticket) return;
    if ((ticket.owner_email ?? null) === col.owner) return; // dropped in place
    setError(null);
    try {
      await reassignTicketOwner(ticket, col.owner, currentUserEmail);
      // Realtime subscription on the ticket list re-renders the board.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reassignment failed');
    }
  }

  return (
    <div className={styles.kanbanWrap}>
      <div className={styles.kanbanHead}>
        <button
          className={styles.kanbanToggle}
          onClick={() => setCollapsed(c => !c)}
          aria-expanded={!collapsed}
        >
          {collapsed ? '▸' : '▾'} Board by owner
          <span className={styles.kanbanCount}>{activeCount} active</span>
        </button>
        {!collapsed && (
          <span className={styles.kanbanHint}>Drag a card to reassign — the new owner gets an email</span>
        )}
      </div>

      {error && <div className={styles.kanbanError}>{error}</div>}

      {!collapsed && (
        columns.length === 0 ? (
          <div className={styles.kanbanEmpty}>No active tickets to place on the board.</div>
        ) : (
          <div className={styles.kanbanBoard}>
            {columns.map(col => (
              <div
                key={col.key}
                className={`${styles.kanbanCol} ${overCol === col.key ? styles.kanbanColOver : ''}`}
                onDragOver={e => { e.preventDefault(); setOverCol(col.key); }}
                onDragLeave={() => setOverCol(c => (c === col.key ? null : c))}
                onDrop={() => void handleDrop(col)}
              >
                <div className={styles.kanbanColHead}>
                  <span className={col.owner ? styles.kanbanColOwner : styles.kanbanColUnassigned}>
                    {col.label}
                  </span>
                  <span className={styles.kanbanColCount}>{col.tickets.length}</span>
                </div>
                <div className={styles.kanbanColBody}>
                  {col.tickets.map(t => (
                    <KanbanCard
                      key={t.id}
                      ticket={t}
                      dragging={dragId === t.id}
                      onDragStart={() => setDragId(t.id)}
                      onDragEnd={() => { setDragId(null); setOverCol(null); }}
                      onClick={() => onSelectTicket(t)}
                    />
                  ))}
                  {col.tickets.length === 0 && (
                    <div className={styles.kanbanColPlaceholder}>Drop here</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

function KanbanCard({
  ticket, dragging, onDragStart, onDragEnd, onClick,
}: {
  ticket: ServiceTicket;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onClick: () => void;
}) {
  const p = priorityMeta(ticket.priority);
  return (
    <div
      className={`${styles.kanbanCard} ${dragging ? styles.kanbanCardDragging : ''}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      title={ticket.subject}
    >
      <div className={styles.kanbanCardTop}>
        <span className={styles.kanbanCardNum}>{ticket.ticket_number}</span>
        <span className={styles.kanbanCardDot} style={{ background: p.color }} title={p.label} />
      </div>
      <div className={styles.kanbanCardSubject}>{ticket.subject}</div>
      <div className={styles.kanbanCardMeta}>
        {ticket.customer_name ?? ticket.customer_email ?? 'No customer'}
        {ticket.topic && <span className={styles.kanbanCardTopic}> · {topicLabel(ticket.topic)}</span>}
      </div>
    </div>
  );
}
