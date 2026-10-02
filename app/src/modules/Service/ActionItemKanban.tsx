import { useMemo, useState } from 'react';
import {
  useOpenActionItems, setTicketActionItemDueDate, priorityMeta,
  type ServiceTicket, type TicketActionItem,
} from '../../lib/service';
import {
  toDateKey, weekStartKey, weekDayKeys, weekRangeLabel,
  buildActionItemBoard, dropTarget, type ActionItemColumn,
} from './actionItemWeek';
import styles from './Service.module.css';
import { TicketPartyLabel } from './TicketPartyLabel';
import type { PartyResolver } from '../../lib/customers';

// A week-view board of every OPEN action item across all support tickets,
// sitting under the owner board. Columns are Overdue · Mon…Sun · No due date;
// dragging a card reschedules it, mirroring OwnerKanban's drag-to-reassign.
// Clicking a card opens the ticket the item belongs to.

type Props = {
  tickets: ServiceTicket[];
  onSelectTicket: (t: ServiceTicket) => void;
  /** FR-6 resolver, supplied by the Support tab so the board names the same
   *  person the queue does. Omitted in bare renders — cards then fall back to
   *  the ticket's own customer_name snapshot. */
  partiesFor?: PartyResolver;
};

export function ActionItemKanban({ tickets, onSelectTicket, partiesFor }: Props) {
  const [collapsed, setCollapsed] = useState(true);
  const [weekOffset, setWeekOffset] = useState(0);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Resolve "today" once on mount rather than on every render — keeps the
  // component pure and the board stable while the operator works.
  const [today] = useState(() => new Date());

  const { items, loading } = useOpenActionItems();

  const ticketById = useMemo(
    () => new Map(tickets.map(t => [t.id, t])),
    [tickets],
  );

  // Only items belonging to a ticket that is loaded AND still open. A closed
  // ticket's leftovers are noise on a planning board, and an item whose ticket
  // isn't in this tab's pool has no card to render.
  const boardItems = useMemo(
    () => items.filter(i => {
      const t = ticketById.get(i.ticket_id);
      return t !== undefined && t.status !== 'closed';
    }),
    [items, ticketById],
  );

  const todayKey = useMemo(() => toDateKey(today), [today]);
  const dayKeys = useMemo(
    () => weekDayKeys(weekStartKey(today, weekOffset)),
    [today, weekOffset],
  );
  const { columns, beyondWeekCount } = useMemo(
    () => buildActionItemBoard(boardItems, dayKeys, todayKey),
    [boardItems, dayKeys, todayKey],
  );

  const openCount = boardItems.length;

  async function handleDrop(col: ActionItemColumn) {
    const id = dragId;
    setDragId(null);
    setOverCol(null);
    if (!id) return;
    const target = dropTarget(col);
    if (target === 'reject') {
      setError("Can't schedule an action item into the past — drop it on a day.");
      return;
    }
    const item = boardItems.find(i => i.id === id);
    if (!item) return;
    if ((item.due_date ?? null) === target.due) return;   // dropped in place
    setError(null);
    try {
      await setTicketActionItemDueDate(id, target.due);
      // The realtime subscription re-buckets the board.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reschedule failed');
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
          {collapsed ? '▸' : '▾'} Action items by week
          <span className={styles.kanbanCount}>{openCount} open</span>
        </button>
        {!collapsed && (
          <>
            <span className={styles.weekNav}>
              <button
                className={styles.weekNavBtn}
                onClick={() => setWeekOffset(w => w - 1)}
                title="Previous week"
                aria-label="Previous week"
              >‹</button>
              <span className={styles.weekNavLabel}>{weekRangeLabel(dayKeys)}</span>
              <button
                className={styles.weekNavBtn}
                onClick={() => setWeekOffset(w => w + 1)}
                title="Next week"
                aria-label="Next week"
              >›</button>
              {weekOffset !== 0 && (
                <button
                  className={styles.weekNavToday}
                  onClick={() => setWeekOffset(0)}
                >This week</button>
              )}
            </span>
            <span className={styles.kanbanHint}>
              Drag a card to reschedule
              {beyondWeekCount > 0 && ` · ${beyondWeekCount} scheduled beyond this week`}
            </span>
          </>
        )}
      </div>

      {error && <div className={styles.kanbanError}>{error}</div>}

      {!collapsed && (
        loading ? (
          <div className={styles.kanbanEmpty}>Loading action items…</div>
        ) : openCount === 0 ? (
          <div className={styles.kanbanEmpty}>No open action items on any ticket.</div>
        ) : (
          <div className={styles.kanbanBoard}>
            {columns.map(col => (
              <div
                key={col.key}
                className={[
                  styles.kanbanCol,
                  overCol === col.key ? styles.kanbanColOver : '',
                  col.isToday ? styles.kanbanColToday : '',
                ].filter(Boolean).join(' ')}
                onDragOver={e => { e.preventDefault(); setOverCol(col.key); }}
                onDragLeave={() => setOverCol(c => (c === col.key ? null : c))}
                onDrop={() => void handleDrop(col)}
              >
                <div className={styles.kanbanColHead}>
                  <span className={
                    col.kind === 'overdue' ? styles.weekColOverdue
                      : col.kind === 'nodate' ? styles.kanbanColUnassigned
                        : styles.kanbanColOwner
                  }>
                    {col.label}{col.isToday ? ' · today' : ''}
                  </span>
                  <span className={styles.kanbanColCount}>{col.items.length}</span>
                </div>
                <div className={styles.kanbanColBody}>
                  {col.items.map(it => (
                    <ActionItemCard
                      partiesFor={partiesFor}
                      key={it.id}
                      item={it}
                      ticket={ticketById.get(it.ticket_id)}
                      overdue={col.kind === 'overdue'}
                      dragging={dragId === it.id}
                      onDragStart={() => setDragId(it.id)}
                      onDragEnd={() => { setDragId(null); setOverCol(null); }}
                      onClick={() => {
                        const t = ticketById.get(it.ticket_id);
                        if (t) onSelectTicket(t);
                      }}
                    />
                  ))}
                  {col.items.length === 0 && (
                    <div className={styles.kanbanColPlaceholder}>
                      {col.kind === 'overdue' ? 'Nothing overdue' : 'Drop here'}
                    </div>
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

function ActionItemCard({
  item, ticket, partiesFor, overdue, dragging, onDragStart, onDragEnd, onClick,
}: {
  item: TicketActionItem;
  ticket: ServiceTicket | undefined;
  partiesFor?: PartyResolver;
  overdue: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onClick: () => void;
}) {
  const p = ticket ? priorityMeta(ticket.priority) : null;
  return (
    <div
      className={[
        styles.kanbanCard,
        dragging ? styles.kanbanCardDragging : '',
        overdue ? styles.kanbanCardOverdue : '',
      ].filter(Boolean).join(' ')}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      title={ticket ? `${ticket.ticket_number} — ${ticket.subject}` : item.body}
    >
      <div className={styles.kanbanCardTop}>
        <span className={styles.kanbanCardNum}>{ticket?.ticket_number ?? '—'}</span>
        {p && <span className={styles.kanbanCardDot} style={{ background: p.color }} title={p.label} />}
      </div>
      <div className={styles.kanbanCardSubject}>{item.body}</div>
      <div className={styles.kanbanCardMeta}>
        <TicketPartyLabel ticket={ticket} partiesFor={partiesFor} />
        {item.author_email && (
          <span className={styles.kanbanCardTopic}> · {item.author_email.split('@')[0]}</span>
        )}
      </div>
    </div>
  );
}
