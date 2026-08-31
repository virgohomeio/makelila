import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  useServiceTickets, useTicketsClosedSince, createTicket, syncGmailTickets,
  STATUS_META, TICKET_STATUSES, TOPIC_LABEL,
  statusMeta, priorityMeta, sourceLabel, topicLabel, slaChip,
  ISSUE_AREAS, ISSUE_AREA_LABEL, ticketStatusSet,
  type TicketStatus, type TicketPriority, type TicketTopic, type ServiceTicket,
  type IssueArea,
} from '../../lib/service';
import {
  daysIdle, dwellTier, dwellPercent, dwellLabel, DWELL_TICKS, STALE_DAYS,
} from './dwell';
import { useCustomers, syncCustomersFromHubspot, type Customer } from '../../lib/customers';
import { useUnits } from '../../lib/stock';
import { useReplacementOrders } from '../../lib/orders';
import { queuedForReplacementLabel } from '../../lib/replacementTags';
import { replacementQueueKindsByTicket, groupQueueKinds } from './replacementQueue';
import { TicketDetailPanel } from './TicketDetailPanel';
import { CustomerProfilePanel } from './CustomerProfilePanel';
import { OwnerKanban } from './OwnerKanban';
import { ActionItemKanban } from './ActionItemKanban';
import { groupTicketsByCustomer, type CustomerGroup } from './ticketGrouping';
import { useAuth } from '../../lib/auth';
import styles from './Service.module.css';

const SOURCE_FILTERS: { key: SourceFilter; label: string }[] = [
  { key: 'all',            label: 'Any source' },
  { key: 'gmail',          label: 'Gmail' },
  { key: 'customer_form',  label: 'Form' },
  { key: 'hubspot',        label: 'HubSpot' },
  { key: 'quo',            label: 'Quo' },
  { key: 'telemetry_auto', label: 'Telemetry auto' },
];

type SourceFilter = 'all' | 'customer_form' | 'hubspot' | 'gmail' | 'quo' | 'telemetry_auto';
type OwnerFilter = 'all' | 'none' | string;
/** Saved views answer the three questions the queue's shape says matter, none
 *  of which was reachable before: who owns nothing, what has gone stale, and
 *  who is waiting on a unit. */
type SavedView = null | 'unowned' | 'idle' | 'replacement';
type ViewMode = 'list' | 'owners' | 'actions';

export function SupportTab() {
  const { tickets, loading } = useServiceTickets('support');
  const { closedIds: closedSinceIds } = useTicketsClosedSince(7);
  const { customers } = useCustomers();
  const { orders: replacementOrders } = useReplacementOrders();
  const { user } = useAuth();
  const [statusFilter, setStatusFilter] = useState<TicketStatus | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [topicFilter, setTopicFilter] = useState<TicketTopic | 'all'>('all');
  const [areaFilter, setAreaFilter] = useState<IssueArea | 'all' | 'none'>('all');
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>('all');
  const [savedView, setSavedView] = useState<SavedView>(null);
  const [view, setView] = useState<ViewMode>('list');
  // The device-context chip links here as ?unit_serial=<serial>. Seed the
  // search box from it rather than filtering invisibly, so the operator can
  // see why the queue is short — and consume the param so clearing the search
  // doesn't re-apply it on the next render.
  const [searchParams, setSearchParams] = useSearchParams();
  const unitParam = searchParams.get('unit_serial');
  const [q, setQ] = useState(unitParam ?? '');
  // Resolved once per render pass so every row on screen measures dwell
  // against the same instant.
  const now = Date.now();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newPreset, setNewPreset] = useState<Customer | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!unitParam) return;
    setQ(unitParam);
    setSearchParams(prev => { prev.delete('unit_serial'); return prev; }, { replace: true });
  }, [unitParam, setSearchParams]);

  const filtered = useMemo(() => {
    return tickets.filter(t => {
      // Match the workflow status OR any of the ticket's status tags, so
      // filtering a tag surfaces every customer whose ticket carries it.
      if (statusFilter !== 'all' && t.status !== statusFilter && !(t.tags ?? []).includes(statusFilter)) return false;
      if (sourceFilter !== 'all' && t.source !== sourceFilter) return false;
      if (topicFilter !== 'all' && t.topic !== topicFilter) return false;
      if (areaFilter === 'none' && t.issue_area !== null) return false;
      if (areaFilter !== 'all' && areaFilter !== 'none' && t.issue_area !== areaFilter) return false;
      if (ownerFilter === 'none' && t.owner_email) return false;
      if (ownerFilter !== 'all' && ownerFilter !== 'none' && t.owner_email !== ownerFilter) return false;
      if (savedView === 'unowned' && (t.owner_email || t.status === 'closed')) return false;
      if (savedView === 'idle'
        && (t.status === 'closed'
            || daysIdle(t.last_message_at ?? t.created_at, now) <= STALE_DAYS)) return false;
      if (savedView === 'replacement' && !ticketStatusSet(t).includes('queued_for_replacement')) return false;
      if (q) {
        const needle = q.toLowerCase();
        return (
          t.subject.toLowerCase().includes(needle) ||
          (t.customer_name ?? '').toLowerCase().includes(needle) ||
          (t.customer_email ?? '').toLowerCase().includes(needle) ||
          (t.summary ?? '').toLowerCase().includes(needle) ||
          (t.unit_serial ?? '').toLowerCase().includes(needle) ||
          t.ticket_number.toLowerCase().includes(needle)
        );
      }
      return true;
    });
  }, [tickets, statusFilter, sourceFilter, topicFilter, areaFilter, ownerFilter, savedView, q, now]);

  // One row per customer (a "ticket profile"); customer-less tickets fall into
  // the Unassigned group. Filters above narrow the ticket pool first, so a
  // profile appears when *any* of its tickets match.
  const grouped = useMemo(() => groupTicketsByCustomer(filtered), [filtered]);

  // What each queued customer is actually waiting on — the batch code of the
  // replacement unit ("P100X") or "PARTS" — read off the linked replacement
  // order, so the row says "Queued for P100X Replacement" instead of just
  // "Queued for Replacement".
  const queueKindsByTicket = useMemo(
    () => replacementQueueKindsByTicket(tickets, replacementOrders),
    [tickets, replacementOrders],
  );

  // Volume per issue area, computed over the *unfiltered* support-ticket
  // pool so the chip counts don't shift when other filters narrow the view.
  const areaCounts = useMemo(() => {
    const counts: Partial<Record<IssueArea, number>> = {};
    let untagged = 0;
    for (const t of tickets) {
      if (t.issue_area && ISSUE_AREAS.includes(t.issue_area)) {
        counts[t.issue_area] = (counts[t.issue_area] ?? 0) + 1;
      } else {
        untagged++;
      }
    }
    return { counts, untagged };
  }, [tickets]);

  // Volume per STATUS, computed over the unfiltered pool so the bar and its
  // legend don't move when other filters narrow the view. Counted over
  // `status` UNION `tags`, because statuses are multi-select — a ticket
  // carrying "Queued for Replacement" as an extra tag is queued, and counting
  // only the `status` column under-reports it.
  const statusCounts = useMemo(() => {
    const counts = Object.fromEntries(TICKET_STATUSES.map(s => [s, 0])) as Record<TicketStatus, number>;
    for (const t of tickets) for (const s of ticketStatusSet(t)) {
      if (s in counts) counts[s as TicketStatus]++;
    }
    return counts;
  }, [tickets]);

  // Owners holding at least one ticket, for the Owner menu.
  const ownerCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tickets) {
      if (t.status === 'closed' || !t.owner_email) continue;
      m.set(t.owner_email, (m.get(t.owner_email) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [tickets]);

  const topicCounts = useMemo(() => {
    const counts: Partial<Record<TicketTopic, number>> = {};
    for (const t of tickets) if (t.topic) counts[t.topic] = (counts[t.topic] ?? 0) + 1;
    return counts;
  }, [tickets]);
  const topicCoverage = useMemo(() => tickets.filter(t => t.topic).length, [tickets]);

  const savedCounts = useMemo(() => {
    let unowned = 0, idle = 0, replacement = 0;
    for (const t of tickets) {
      const open = t.status !== 'closed';
      if (open && !t.owner_email) unowned++;
      if (open && daysIdle(t.last_message_at ?? t.created_at, now) > STALE_DAYS) idle++;
      if (ticketStatusSet(t).includes('queued_for_replacement')) replacement++;
    }
    return { unowned, idle, replacement };
  }, [tickets, now]);

  const onSyncNow = async () => {
    setSyncing(true); setSyncMessage(null);
    try {
      const r = await syncGmailTickets() as { ok?: boolean; skipped?: boolean; results?: { mailbox: string; threads_processed: number }[] };
      if (r?.skipped) {
        setSyncMessage('Gmail sync not yet configured.');
      } else if (r?.results) {
        const total = r.results.reduce((n, x) => n + (x.threads_processed ?? 0), 0);
        setSyncMessage(`Synced ${total} thread${total === 1 ? '' : 's'} across ${r.results.length} mailbox${r.results.length === 1 ? '' : 'es'}.`);
      } else {
        setSyncMessage('Synced.');
      }
    } catch (e) {
      setSyncMessage(`Error: ${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  };

  const selected = filtered.find(t => t.id === selectedId) ?? tickets.find(t => t.id === selectedId) ?? null;

  // Header figures. In Progress / Waiting-on-us used to be their own KPI tiles;
  // the queue bar reports both (and every other status) with the added truth
  // that the tiles hid — their share of the queue.
  //
  // Intake and throughput share the same 7-day window so they read as a pair:
  // "N in, M out" over the same period. The old "New (24h)" tile read 0 on most
  // days, which is a measurement artefact of the window, not a quiet week.
  const weekAgo = now - 7 * 86400_000;
  // Open = anything not yet closed (the only terminal status).
  const openCount = tickets.filter(t => t.status !== 'closed').length;
  const newWeekCount = tickets.filter(t => new Date(t.created_at).getTime() > weekAgo).length;
  // Closed (7d) = throughput: support tickets closed at least once in the window,
  // counting reopened ones too. A ticket qualifies if it has a close event in the
  // activity log within 7d, OR its current closed_at falls in the window (covers
  // closes made outside the app, e.g. synced from HubSpot).
  const closedWeekCount = tickets.filter(t =>
    closedSinceIds.has(t.id) ||
    (t.closed_at != null && new Date(t.closed_at).getTime() > weekAgo)
  ).length;

  if (loading) return <div className={styles.loading}>Loading…</div>;

  return (
    <>
      <div className={styles.pageHead}>
        <div>
          <h2 className={styles.pageTitle}>Support Tickets</h2>
          <p className={styles.pageSub}>
            <b>{openCount}</b> open across <b>{grouped.groups.length}</b> customers
            {' · '}<b>{newWeekCount}</b> new this week
            {' · '}<b>{closedWeekCount}</b> closed this week
          </p>
        </div>
        <div className={styles.pageActions}>
          <button
            className={styles.addBtn}
            onClick={() => void onSyncNow()}
            disabled={syncing}
            title="Manually trigger the Gmail sync edge function"
          >{syncing ? 'Syncing…' : 'Sync now'}</button>
          <button className={styles.addBtnPrimary} onClick={() => { setNewPreset(null); setShowNew(true); }}>
            + Add ticket
          </button>
        </div>
      </div>

      <QueueBar
        counts={statusCounts}
        openTotal={openCount}
        active={statusFilter}
        onPick={s => { setStatusFilter(s); setSavedView(null); }}
      />

      <div className={styles.savedViews}>
        <SavedViewChip
          label="Unowned" count={savedCounts.unowned} tone="unowned"
          active={savedView === 'unowned'}
          onClick={() => { setSavedView(v => v === 'unowned' ? null : 'unowned'); setStatusFilter('all'); }}
        />
        <SavedViewChip
          label={`Idle ${STALE_DAYS} days+`} count={savedCounts.idle} tone="idle"
          active={savedView === 'idle'}
          onClick={() => { setSavedView(v => v === 'idle' ? null : 'idle'); setStatusFilter('all'); }}
        />
        <SavedViewChip
          label="Replacement queue" count={savedCounts.replacement} tone="replacement"
          active={savedView === 'replacement'}
          onClick={() => { setSavedView(v => v === 'replacement' ? null : 'replacement'); setStatusFilter('all'); }}
        />
      </div>

      <div className={styles.toolbar}>
        <input
          className={styles.search}
          placeholder="Search ticket #, subject, customer, summary…"
          aria-label="Search tickets"
          value={q}
          onChange={e => setQ(e.target.value)}
        />

        <Dropdown
          label={ownerFilter === 'all' ? 'Owner' : ownerFilter === 'none' ? 'Unowned' : ownerFilter.split('@')[0]}
          active={ownerFilter !== 'all'}
        >
          {close => (
            <>
              <div className={styles.menuLabel}>Owner</div>
              <MenuItem checked={ownerFilter === 'all'} label="Anyone"
                onClick={() => { setOwnerFilter('all'); close(); }} />
              <MenuItem checked={ownerFilter === 'none'} label="Unowned" count={savedCounts.unowned}
                onClick={() => { setOwnerFilter('none'); close(); }} />
              {ownerCounts.map(([email, n]) => (
                <MenuItem key={email} checked={ownerFilter === email}
                  label={email.split('@')[0]} count={n}
                  onClick={() => { setOwnerFilter(email); close(); }} />
              ))}
            </>
          )}
        </Dropdown>

        <Dropdown
          label={sourceFilter === 'all' ? 'Source' : sourceLabel(sourceFilter)}
          active={sourceFilter !== 'all'}
        >
          {close => (
            <>
              <div className={styles.menuLabel}>Source</div>
              {SOURCE_FILTERS.map(f => (
                <MenuItem key={f.key} checked={sourceFilter === f.key} label={f.label}
                  onClick={() => { setSourceFilter(f.key); close(); }} />
              ))}
            </>
          )}
        </Dropdown>

        {/* Topic and issue area live behind a disclosure rather than costing two
            permanent rows: both columns are empty on ~95% of tickets, so the
            chips filter on data that mostly isn't there. Nothing is removed —
            every chip and count is still here, and the coverage is stated so a
            sparse list reads as sparse data rather than a broken filter. */}
        <Dropdown
          label="More filters"
          active={topicFilter !== 'all' || areaFilter !== 'all'}
          badge={(topicFilter !== 'all' ? 1 : 0) + (areaFilter !== 'all' ? 1 : 0)}
          wide
        >
          {() => (
            <>
              <div className={styles.menuLabel}>Topic</div>
              <div className={styles.menuGrid}>
                <MenuItem checked={topicFilter === 'all'} label="Any topic"
                  onClick={() => setTopicFilter('all')} />
                {(Object.keys(TOPIC_LABEL) as TicketTopic[]).map(k => (
                  <MenuItem key={k} checked={topicFilter === k} label={TOPIC_LABEL[k]}
                    count={topicCounts[k] ?? 0}
                    onClick={() => setTopicFilter(topicFilter === k ? 'all' : k)} />
                ))}
              </div>
              <p className={styles.menuNote}>
                {topicCoverage} of {tickets.length} support tickets carry a topic. Auto-classified on sync.
              </p>

              <div className={styles.menuLabel}>Issue area</div>
              <div className={styles.menuGrid}>
                <MenuItem checked={areaFilter === 'all'} label="Any area"
                  onClick={() => setAreaFilter('all')} />
                {ISSUE_AREAS.map(a => (
                  <MenuItem key={a} checked={areaFilter === a} label={ISSUE_AREA_LABEL[a]}
                    count={areaCounts.counts[a] ?? 0}
                    onClick={() => setAreaFilter(areaFilter === a ? 'all' : a)} />
                ))}
                <MenuItem checked={areaFilter === 'none'} label="Uncategorized"
                  count={areaCounts.untagged}
                  onClick={() => setAreaFilter(areaFilter === 'none' ? 'all' : 'none')} />
              </div>
              <p className={styles.menuNote}>
                Operator-set, for volume reporting. {tickets.length - areaCounts.untagged} of {tickets.length} categorised.
              </p>
            </>
          )}
        </Dropdown>

        {(statusFilter !== 'all' || sourceFilter !== 'all' || topicFilter !== 'all'
          || areaFilter !== 'all' || ownerFilter !== 'all' || savedView || q) && (
          <button
            className={styles.clearBtn}
            onClick={() => {
              setStatusFilter('all'); setSourceFilter('all'); setTopicFilter('all');
              setAreaFilter('all'); setOwnerFilter('all'); setSavedView(null); setQ('');
            }}
          >Clear filters</button>
        )}

        <span className={styles.toolbarSpacer} />

        {/* The two boards were permanently stacked above the table, which put
            the first ticket row below the fold. Same components, same drag
            behaviour — they are views now, so the page has one scrolling
            region instead of three. */}
        <div className={styles.viewSwitch} role="group" aria-label="View">
          <button
            className={view === 'list' ? styles.viewSegOn : styles.viewSeg}
            aria-pressed={view === 'list'}
            onClick={() => setView('list')}
          >List</button>
          <button
            className={view === 'owners' ? styles.viewSegOn : styles.viewSeg}
            aria-pressed={view === 'owners'}
            onClick={() => setView('owners')}
          >By owner</button>
          <button
            className={view === 'actions' ? styles.viewSegOn : styles.viewSeg}
            aria-pressed={view === 'actions'}
            onClick={() => setView('actions')}
          >Action items</button>
        </div>
      </div>

      {syncMessage && <div className={styles.syncMessage}>{syncMessage}</div>}

      {view === 'owners' && (
        <OwnerKanban
          tickets={tickets}
          currentUserEmail={user?.email}
          onSelectTicket={(t) => setSelectedId(t.id)}
        />
      )}

      {view === 'actions' && (
        <ActionItemKanban
          tickets={tickets}
          onSelectTicket={(t) => setSelectedId(t.id)}
        />
      )}

      {view === 'list' && (
       grouped.groups.length === 0 && grouped.unassigned.length === 0 ? (
        <div className={styles.empty}>No tickets match these filters.</div>
      ) : (
        <>
          {grouped.groups.length > 0 && (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Tickets</th>
                  <th>Open</th>
                  <th>Status</th>
                  <th>Owner</th>
                  <th className={styles.dwellHead}><DwellAxis /></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {grouped.groups.map(g => (
                  <CustomerGroupRow key={g.customerId} g={g}
                    queueKindsByTicket={queueKindsByTicket}
                    now={now}
                    selected={selectedCustomerId === g.customerId}
                    onClick={() => setSelectedCustomerId(g.customerId)} />
                ))}
              </tbody>
            </table>
          )}

          {grouped.unassigned.length > 0 && (
            <>
              <div className={styles.unassignedHead}>
                Unassigned ({grouped.unassigned.length}) — no customer linked
              </div>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th className={styles.dwellHead}><DwellAxis /></th>
                    <th>Created</th>
                    <th>Customer</th>
                    <th>Subject</th>
                    <th>Topic</th>
                    <th>Source</th>
                    <th>Priority</th>
                    <th>SLA</th>
                    <th>Status</th>
                    <th>Owner</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {grouped.unassigned.map(t => (
                    <TicketRow key={t.id} t={t}
                      queueKinds={queueKindsByTicket.get(t.id) ?? []}
                      now={now}
                      selected={selectedId === t.id}
                      onClick={() => setSelectedId(t.id)} />
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      ))}

      {selectedCustomerId && (() => {
        const g = grouped.groups.find(x => x.customerId === selectedCustomerId);
        if (!g) return null;
        const cust = customers.find(c => c.id === selectedCustomerId);
        return (
          <CustomerProfilePanel
            group={g}
            customer={cust}
            onClose={() => setSelectedCustomerId(null)}
            onOpenTicket={(t) => setSelectedId(t.id)}
            onAddTicket={() => { setNewPreset(cust ?? null); setShowNew(true); }}
          />
        );
      })()}

      {selected && (
        <TicketDetailPanel
          ticket={selected}
          onClose={() => setSelectedId(null)}
          showDeviceContext={false}
        />
      )}

      {showNew && (
        <NewTicketModal
          customers={customers}
          presetCustomer={newPreset}
          onClose={() => { setShowNew(false); setNewPreset(null); }}
          onCreated={(t) => { setShowNew(false); setNewPreset(null); setSelectedId(t.id); }}
        />
      )}
    </>
  );
}

/** Status pill(s) for one status value. "Queued for Replacement" expands into
 *  one pill per replacement kind — "Queued for P100X Replacement", "Queued for
 *  PARTS Replacement" — so the row says what the customer is actually waiting
 *  on. Falls back to the plain status label when the linked replacement order
 *  can't be resolved.
 *
 *  Statuses are multi-select, so a row renders several of these; they all share
 *  one pill style (there is no separate "tag" styling — a status is a status). */
function StatusPills({ value, queueKinds }: { value: string; queueKinds: string[] }) {
  const m = statusMeta(value);
  const labels = value === 'queued_for_replacement' && queueKinds.length > 0
    ? queueKinds.map(queuedForReplacementLabel)
    : [m.label];
  return (
    <>
      {labels.map(label => (
        <span
          key={label}
          className={styles.pill}
          style={{ background: m.bg, color: m.color }}
        >{label}</span>
      ))}
    </>
  );
}

function CustomerGroupRow({ g, queueKindsByTicket, now, selected, onClick }: {
  g: CustomerGroup;
  queueKindsByTicket: Map<string, string[]>;
  now: number;
  selected: boolean;
  onClick: () => void;
}) {
  const idle = daysIdle(g.lastActivity, now);
  // Surface every status held across EVERY open ticket, not just the newest
  // one. Statuses are multi-select, so one ticket can contribute several (e.g.
  // In Progress + Queued for Replacement); ticketStatusSet unions the `status`
  // column with `tags` per ticket. When all tickets are closed there are no
  // open ones, so fall back to the rollup status — which reads "Complete".
  const openTickets = g.tickets.filter(t => t.status !== 'closed');
  const statuses = openTickets.length > 0
    ? [...new Set(openTickets.flatMap(t => ticketStatusSet(t)))]
    : [g.rollupStatus];
  // Distinct owners across this customer's open tickets — a profile can hold
  // several tickets split across people, so show each as a chip.
  const owners = [...new Set(
    openTickets.map(t => t.owner_email).filter((e): e is string => !!e),
  )].sort();
  // What this customer is queued for across their open tickets — "P100X",
  // "LILA-Mini", "PARTS" … Empty when nothing is queued (or the replacement
  // order is missing), in which case the pill keeps its generic label.
  const queueKinds = groupQueueKinds(openTickets, queueKindsByTicket);
  return (
    <tr className={`${styles.row} ${selected ? styles.rowSelected : ''}`} onClick={onClick}>
      <td>
        <div>{g.customerName}</div>
        {g.customerEmail && <div className={styles.rowSummary}>{g.customerEmail}</div>}
      </td>
      <td>{g.total}</td>
      <td>{g.openCount > 0 ? <strong>{g.openCount}</strong> : '—'}</td>
      <td>
        {statuses.map(v => <StatusPills key={v} value={v} queueKinds={queueKinds} />)}
      </td>
      <td>
        {owners.length > 0 ? (
          <div className={styles.ownerChips}>
            {owners.map(o => (
              <span key={o} className={styles.ownerChip} title={o}>{o.split('@')[0]}</span>
            ))}
          </div>
        ) : <span className={styles.unowned}>Unowned</span>}
      </td>
      <td><DwellRail days={idle} /></td>
      <td className={styles.chevron}>›</td>
    </tr>
  );
}

function NewTicketModal({
  customers, presetCustomer, onClose, onCreated,
}: {
  customers: Customer[];
  presetCustomer?: Customer | null;
  onClose: () => void;
  onCreated: (t: ServiceTicket) => void;
}) {
  const { units } = useUnits();
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [customerSearch, setCustomerSearch] = useState('');
  // Pre-seed the customer when opened from a profile's "+ Add ticket".
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(presetCustomer ?? null);
  const [resyncing, setResyncing] = useState(false);
  const [resyncMsg, setResyncMsg] = useState<string | null>(null);

  // Walkthrough #34: when no candidates match the search, operators
  // suspected the HubSpot sync was stale. Inline this re-sync so they
  // can recover mid-call instead of switching tabs.
  async function handleResync() {
    setResyncing(true); setResyncMsg(null);
    try {
      const r = await syncCustomersFromHubspot();
      setResyncMsg(`Synced ${r.upserted} new customer${r.upserted === 1 ? '' : 's'} from HubSpot. Try the search again.`);
    } catch (e) {
      setResyncMsg(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setResyncing(false);
    }
  }
  const [unitSerial, setUnitSerial] = useState('');
  const [serialAutoFilled, setSerialAutoFilled] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-populate the unit serial when a customer is picked (walkthrough #36).
  // Match on lowercased customer_name; if the customer has multiple shipped
  // units we pick the most-recent and tag the field with a hint. We only
  // overwrite the serial when (a) the field is empty, or (b) it was
  // previously auto-filled — never when the operator has typed manually.
  useEffect(() => {
    if (!selectedCustomer) return;
    if (unitSerial && !serialAutoFilled) return;
    const lcName = selectedCustomer.full_name.toLowerCase();
    const matches = units
      .filter(u => u.customer_name?.toLowerCase() === lcName)
      .sort((a, b) => (b.shipped_at ?? '').localeCompare(a.shipped_at ?? ''));
    if (matches.length === 0) return;
    setUnitSerial(matches[0].serial);
    setSerialAutoFilled(true);
  }, [selectedCustomer, units, unitSerial, serialAutoFilled]);

  const matchedUnitCount = useMemo(() => {
    if (!selectedCustomer) return 0;
    const lcName = selectedCustomer.full_name.toLowerCase();
    return units.filter(u => u.customer_name?.toLowerCase() === lcName).length;
  }, [selectedCustomer, units]);

  const candidates = useMemo(() => {
    const needle = customerSearch.trim().toLowerCase();
    if (!needle) return [];
    return customers.filter(c =>
      c.full_name.toLowerCase().includes(needle) ||
      (c.email ?? '').toLowerCase().includes(needle) ||
      (c.phone ?? '').toLowerCase().includes(needle),
    ).slice(0, 8);
  }, [customers, customerSearch]);

  const canSubmit = subject.trim().length > 0 && selectedCustomer !== null && !submitting;

  const submit = async () => {
    if (!selectedCustomer) return;
    setSubmitting(true);
    setError(null);
    try {
      const row = await createTicket({
        category: 'support',
        subject: subject.trim(),
        description: description.trim() || null,
        priority,
        customer_id: selectedCustomer.id,
        customer_name: selectedCustomer.full_name,
        customer_email: selectedCustomer.email,
        customer_phone: selectedCustomer.phone,
        unit_serial: unitSerial.trim() || null,
      });
      onCreated(row);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create ticket');
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <strong>New support ticket</strong>
          <button onClick={onClose} className={styles.modalClose}>✕</button>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.modalRow}>
            <label>Subject *</label>
            <input
              type="text"
              className={styles.modalInput}
              value={subject}
              onChange={e => setSubject(e.target.value)}
              placeholder="Short summary of the issue"
              autoFocus
            />
          </div>
          <div className={styles.modalRow}>
            <label>Customer *</label>
            {selectedCustomer ? (
              <div className={styles.modalSelected}>
                <strong>{selectedCustomer.full_name}</strong>
                <span className={styles.muted}>
                  {[selectedCustomer.email, selectedCustomer.phone, selectedCustomer.city]
                    .filter(Boolean).join(' · ') || '—'}
                </span>
                <button
                  className={styles.modalLinkBtn}
                  onClick={() => { setSelectedCustomer(null); setCustomerSearch(''); }}
                >change</button>
              </div>
            ) : (
              <div className={styles.modalPicker}>
                <input
                  type="text"
                  className={styles.modalInput}
                  value={customerSearch}
                  onChange={e => setCustomerSearch(e.target.value)}
                  placeholder="Type a name, email, or phone…"
                />
                {candidates.length > 0 && (
                  <div className={styles.modalDropdown}>
                    {candidates.map(c => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setSelectedCustomer(c)}
                        className={styles.modalDropItem}
                      >
                        <strong>{c.full_name}</strong>
                        <span className={styles.muted}>
                          {[c.email, c.phone].filter(Boolean).join(' · ') || '—'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {customerSearch.trim() && candidates.length === 0 && (
                  <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span className={styles.muted} style={{ fontSize: 11 }}>
                      No matching customer. If you just received their message, the HubSpot sync may be a few minutes behind.
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleResync()}
                      disabled={resyncing}
                      className={styles.modalSecondary}
                      style={{ alignSelf: 'flex-start' }}
                    >{resyncing ? 'Re-syncing…' : 'Re-sync from HubSpot'}</button>
                    {resyncMsg && (
                      <span className={styles.muted} style={{ fontSize: 11 }}>{resyncMsg}</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className={styles.modalRow}>
            <label>Description</label>
            <textarea
              className={styles.modalTextarea}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What happened? Steps the customer took, error messages, etc."
              rows={3}
            />
          </div>
          <div className={styles.modalGrid}>
            <div className={styles.modalRow}>
              <label>Priority</label>
              <select
                className={styles.modalSelect}
                value={priority}
                onChange={e => setPriority(e.target.value as TicketPriority)}
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div className={styles.modalRow}>
              <label>Unit serial</label>
              <input
                type="text"
                className={styles.modalInput}
                value={unitSerial}
                onChange={e => { setUnitSerial(e.target.value); setSerialAutoFilled(false); }}
                placeholder="LL01-… (optional)"
              />
              {serialAutoFilled && matchedUnitCount > 0 && (
                <span className={styles.muted} style={{ fontSize: 10, marginTop: 2 }}>
                  Auto-filled from {selectedCustomer?.full_name}'s {matchedUnitCount === 1 ? 'shipped unit' : `most recent of ${matchedUnitCount} shipped units`} — edit to override.
                </span>
              )}
            </div>
          </div>
          {error && <div className={styles.modalError}>{error}</div>}
        </div>
        <div className={styles.modalFoot}>
          <button onClick={onClose} className={styles.modalSecondary}>Cancel</button>
          <button
            onClick={() => void submit()}
            className={styles.modalPrimary}
            disabled={!canSubmit}
          >
            {submitting ? 'Creating…' : 'Create ticket'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The open queue as one segmented bar, where each segment is also the filter.
 *
 *  This replaces a five-tile KPI strip AND a ten-chip status row. It carries
 *  more than either did: sized to the real distribution, it shows that Action
 *  Needed is roughly three quarters of everything open — which five equal-width
 *  tiles actively hid.
 *
 *  The legend below it lists every status, including ones nothing currently
 *  holds. A status an operator can set has to be a status they can find. */
function QueueBar({ counts, openTotal, active, onPick }: {
  counts: Record<TicketStatus, number>;
  openTotal: number;
  active: TicketStatus | 'all';
  onPick: (s: TicketStatus | 'all') => void;
}) {
  // 'closed' is not part of the open queue, so it gets no segment — but it
  // keeps its place in the legend as a filter.
  const openStatuses = TICKET_STATUSES.filter(s => s !== 'closed' && counts[s] > 0);
  return (
    <div className={styles.queueBar}>
      <div className={styles.queueTrack} role="group" aria-label="Open tickets by status">
        {openStatuses.map(s => {
          const m = STATUS_META[s];
          const pct = openTotal > 0 ? (counts[s] / openTotal) * 100 : 0;
          return (
            <button
              key={s}
              className={styles.queueSeg}
              style={{ flexBasis: `${pct}%`, background: m.color }}
              aria-pressed={active === s}
              title={`${m.label} — ${counts[s]} open`}
              onClick={() => onPick(active === s ? 'all' : s)}
            >
              {pct > 7 && <span className={styles.queueSegN}>{counts[s]}</span>}
            </button>
          );
        })}
      </div>

      <div className={styles.queueLegend}>
        {TICKET_STATUSES.map(s => {
          const m = STATUS_META[s];
          const n = counts[s];
          return (
            <button
              key={s}
              className={[
                styles.legendItem,
                n === 0 ? styles.legendZero : '',
                active === s ? styles.legendOn : '',
                s === 'closed' ? styles.legendSep : '',
              ].filter(Boolean).join(' ')}
              aria-pressed={active === s}
              title={n === 0 ? 'No tickets currently hold this status' : undefined}
              onClick={() => onPick(active === s ? 'all' : s)}
            >
              <span className={styles.legendDot} style={{ background: m.color }} />
              {m.label} <b>{n}</b>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SavedViewChip({ label, count, tone, active, onClick }: {
  label: string; count: number; tone: 'unowned' | 'idle' | 'replacement';
  active: boolean; onClick: () => void;
}) {
  return (
    <button
      className={active ? styles.savedChipOn : styles.savedChip}
      aria-pressed={active}
      onClick={onClick}
    >
      <span className={`${styles.savedDot} ${styles[`savedDot_${tone}`]}`} />
      {label}
      <span className={styles.savedCount}>{count}</span>
    </button>
  );
}

/** Popover filter. Closes on outside click and on Escape. */
function Dropdown({ label, active, badge, wide, children }: {
  label: string;
  active: boolean;
  badge?: number;
  wide?: boolean;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={styles.dropdown} ref={ref}>
      <button
        className={active ? styles.filterChipOn : styles.filterChip}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        {label}
        {badge ? <span className={styles.filterBadge}>{badge}</span> : null}
        <span className={styles.caret} aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className={wide ? styles.menuWide : styles.menu} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({ checked, label, count, onClick }: {
  checked: boolean; label: string; count?: number; onClick: () => void;
}) {
  return (
    <button
      className={styles.menuItem}
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onClick}
    >
      <span className={styles.menuCheck} aria-hidden="true">{checked ? '✓' : ''}</span>
      <span className={styles.menuItemLabel}>{label}</span>
      {count !== undefined && <span className={styles.menuCount}>{count}</span>}
    </button>
  );
}

/** The shared age axis, drawn once in the column header. Every rail below it
 *  is plotted against these ticks — that is what turns a column of unrelated
 *  numbers into a readable shape. */
function DwellAxis() {
  return (
    <>
      <span className={styles.dwellAxis} aria-hidden="true">
        {DWELL_TICKS.map(t => (
          <span key={t.label} className={styles.dwellTick} style={{ left: `${t.pct}%` }}>
            {t.label}
          </span>
        ))}
      </span>
      Untouched for
    </>
  );
}

/** One row's position on the shared axis. */
function DwellRail({ days }: { days: number }) {
  const pct = dwellPercent(days);
  const tier = dwellTier(days);
  const at = `calc((100% - var(--dwell-gutter)) * ${pct / 100})`;
  return (
    <span
      className={`${styles.rail} ${styles[`rail_${tier}`]}`}
      title={`${days} day${days === 1 ? '' : 's'} since last activity`}
    >
      <span className={styles.railTrack} />
      {/* The stale threshold — the line most of this queue has crossed. */}
      <span className={styles.railThreshold} style={{ left: `calc((100% - var(--dwell-gutter)) * ${dwellPercent(STALE_DAYS) / 100})` }} />
      <span className={styles.railFill} style={{ width: at }} />
      <span className={styles.railMark} style={{ left: at }} />
      <span className={styles.railLabel}>{dwellLabel(days)}</span>
    </span>
  );
}

function TicketRow({ t, queueKinds, now, selected, onClick }: {
  t: ServiceTicket;
  queueKinds: string[];
  now: number;
  selected: boolean;
  onClick: () => void;
}) {
  const p = priorityMeta(t.priority);
  const sla = slaChip(t);
  // Age: prefer last_message_at (gmail-aware) then created_at.
  const lastTs = t.last_message_at ?? t.created_at;
  const ageHours = (now - new Date(lastTs).getTime()) / 3_600_000;
  const idle = daysIdle(lastTs, now);
  // Priority-scoped staleness is a different signal from dwell: an urgent
  // ticket is stale after a day, and the rail's 30-day scale can't show that.
  const stale =
    (t.priority === 'urgent' && ageHours > 24) ||
    (t.priority === 'high'   && ageHours > 48);
  const gmailLink = t.gmail_thread_id
    ? `https://mail.google.com/mail/u/0/?authuser=${encodeURIComponent(t.gmail_account ?? '')}#all/${t.gmail_thread_id}`
    : null;
  return (
    <tr
      className={`${styles.row} ${selected ? styles.rowSelected : ''}`}
      onClick={onClick}
      title={t.suggested_next_action ?? undefined}
    >
      <td style={{ fontFamily: 'ui-monospace, monospace' }}>{t.ticket_number}</td>
      <td>
        {stale && <span className={styles.stalePip} aria-label="stale" title="Past SLA for its priority">⚠</span>}
        <DwellRail days={idle} />
      </td>
      <td title={new Date(t.created_at).toLocaleString()}>{new Date(t.created_at).toLocaleDateString()}</td>
      <td>{t.customer_name ?? t.customer_email ?? '—'}</td>
      <td>
        <div>{t.subject}</div>
        {t.summary && <div className={styles.rowSummary}>{t.summary}</div>}
        {t.engineering_resolved_at && !t.closed_at && (
          <div
            title={`Engineering resolved ${new Date(t.engineering_resolved_at).toLocaleString()}`}
            className={styles.engFixed}
          >
            Engineering fixed — follow up
          </div>
        )}
      </td>
      <td>{t.topic ? <span className={styles.topicPill}>{topicLabel(t.topic)}</span> : '—'}</td>
      <td>
        {t.source === 'telemetry_auto'
          ? <span className={styles.telemetryAutoBadge}>Telemetry auto</span>
          : sourceLabel(t.source)
        }
      </td>
      <td><span className={styles.pill} style={{ background: 'var(--color-surface)', color: p.color }}>{p.label}</span></td>
      <td><SlaChipPill label={sla.label} color={sla.color} /></td>
      <td>
        {ticketStatusSet(t).map(s => (
          <StatusPills key={s} value={s} queueKinds={queueKinds} />
        ))}
        {t.status === 'closed' && t.closed_at && (
          <div className={styles.closedDate} title={`Closed ${new Date(t.closed_at).toLocaleString()}`}>
            Closed {new Date(t.closed_at).toLocaleDateString()}
          </div>
        )}
      </td>
      <td>{t.owner_email ? t.owner_email.split('@')[0] : '—'}</td>
      <td onClick={e => e.stopPropagation()}>
        {gmailLink && (
          <a className={styles.gmailLink} href={gmailLink} target="_blank" rel="noreferrer" title="Open in Gmail">↗</a>
        )}
      </td>
    </tr>
  );
}

// Same warm ramp and AA floor as STATUS_META; 'red' is the AA-legible error
// token value, not the old #c53030 the spec measured against Ladybug Red.
const SLA_CHIP_STYLE: Record<string, { background: string; color: string }> = {
  green: { background: '#EBF2EA', color: '#3E6B45' },
  amber: { background: '#FAF4E2', color: '#7D6114' },
  red:   { background: '#FDECEC', color: '#A61B1B' },
  grey:  { background: '#F0EDE7', color: '#6E6862' },
};

function SlaChipPill({ label, color }: { label: string; color: 'green' | 'amber' | 'red' | 'grey' }) {
  const style = SLA_CHIP_STYLE[color];
  return <span className={styles.pill} style={style}>{label}</span>;
}


