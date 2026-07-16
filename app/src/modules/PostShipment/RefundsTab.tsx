import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useRefundApprovals, useReturns,
  submitRefundRequest, updateRefundAmount, managerApprove, financeApprove, executeRefund, denyRefund, closeRefund,
  setReturnDisposition, updateReturnStatus,
  useRefundNotes, addRefundNote, deleteRefundNote,
  REFUND_STATUS_META, REFUND_METHODS, REFUND_METHOD_META,
  UNIT_STATUS_LABEL, RETURN_DISPOSITION_META,
  type RefundApproval, type ReturnRow, type RefundMethod, type ReturnDisposition, type ReturnStatus, type ReturnCategory,
} from '../../lib/postShipment';

// Operator-facing unit-status stages, editable from the refund detail panel.
const UNIT_STAGES: { value: ReturnStatus; label: string }[] = [
  { value: 'created',          label: 'Return form submitted' },
  { value: 'pickup_scheduled', label: 'Pickup scheduled' },
  { value: 'received',         label: 'Unit returned' },
  { value: 'discarded',        label: 'Unit discarded by customer' },
];
import { useQueuedReplacements, holdReplacement, type Order } from '../../lib/orders';
import { useOnboardDates, useCustomerIdByEmail, refundUsageWindow, type RefundUsageWindow } from '../../lib/customers';
import { useInvoicesByCustomerEmail, getInvoiceSignedUrl, type CustomerInvoice } from '../../lib/invoices';
import {
  useServiceTickets, useTicketMessages, useTicketNotes, STATUS_META as TICKET_STATUS_META,
  sourceLabel, topicLabel, type ServiceTicket,
} from '../../lib/service';
import { useAuth } from '../../lib/auth';
import { canDo } from '../../lib/permissions';
import { supabase } from '../../lib/supabase';
import styles from './PostShipment.module.css';

const STAR = '★';

type ColKey = 'manager_review' | 'finance_review' | 'refund_queue' | 'refunded' | 'denied';

const COLUMNS: { key: ColKey; label: string; helper: string }[] = [
  { key: 'manager_review', label: 'Manager review',  helper: 'Awaiting George' },
  { key: 'finance_review', label: 'Finance review',  helper: 'Awaiting Julie / Huayi (amount)' },
  { key: 'refund_queue',   label: 'Refund Queue',    helper: 'Approved — execute the payout' },
  { key: 'refunded',       label: 'Refunded',        helper: 'Payment executed' },
  { key: 'denied',         label: 'Denied',          helper: 'Rejected — shows which stage' },
];

export function RefundsTab() {
  const { approvals, loading: aLoading } = useRefundApprovals();
  const { returns, loading: rLoading } = useReturns();
  const { replacements: queuedRepls } = useQueuedReplacements();
  const { byEmail: onboardByEmail } = useOnboardDates();
  const { byEmail: invoicesByEmail } = useInvoicesByCustomerEmail();
  const { byEmail: customerIdByEmail } = useCustomerIdByEmail();
  const { tickets: allTickets } = useServiceTickets();
  const { user, role } = useAuth();
  const userEmail = user?.email;

  const [showRequestModal, setShowRequestModal] = useState(false);
  const [requestReturnId, setRequestReturnId] = useState<string | null>(null);
  const [viewReturnId, setViewReturnId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [financeModalId, setFinanceModalId] = useState<string | null>(null);
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Ticket opened from a refund card's history — resolved from the live list
  // so realtime edits keep it fresh.
  const openTicket = openTicketId ? allTickets.find(t => t.id === openTicketId) ?? null : null;

  const isManager = canDo(role, 'approve_refund_manager');
  const isFinance = canDo(role, 'approve_refund_finance');

  const returnsById = useMemo(() => {
    const m = new Map<string, ReturnRow>();
    for (const r of returns) m.set(r.id, r);
    return m;
  }, [returns]);

  const replsByEmail = useMemo(() => {
    const m = new Map<string, Order[]>();
    for (const r of queuedRepls) {
      const key = (r.customer_email ?? '').toLowerCase().trim();
      if (!key) continue;
      const prev = m.get(key) ?? [];
      m.set(key, [...prev, r]);
    }
    return m;
  }, [queuedRepls]);

  // 30-day usage window per refund, anchored on the customer's onboarding date.
  // Prefer the refund's own email, fall back to the linked return's email.
  const usageFor = (refund: RefundApproval, linkedReturn: ReturnRow | null): RefundUsageWindow => {
    const email = (refund.customer_email ?? linkedReturn?.customer_email ?? '').toLowerCase().trim();
    return refundUsageWindow(email ? onboardByEmail.get(email) : null);
  };

  // The customer's sales invoice(s) — resolved by email, the same way the
  // customer directory surfaces them (both key off the customer record).
  const invoicesFor = (refund: RefundApproval, linkedReturn: ReturnRow | null): CustomerInvoice[] => {
    const email = (refund.customer_email ?? linkedReturn?.customer_email ?? '').toLowerCase().trim();
    return email ? invoicesByEmail.get(email) ?? [] : [];
  };

  // Ticket indexes for matching a refund to its customer's tickets. We match by
  // customer_id — not just email — so a household whose tickets span two emails
  // (e.g. a couple under one customer record) shows ALL their tickets. Falls
  // back to email for tickets that have no customer_id.
  const ticketIndex = useMemo(() => {
    const byEmail = new Map<string, ServiceTicket[]>();
    const byCustomerId = new Map<string, ServiceTicket[]>();
    const emailToCustomerId = new Map<string, string>();
    for (const t of allTickets) {
      const email = (t.customer_email ?? '').toLowerCase().trim();
      if (email) {
        (byEmail.get(email) ?? byEmail.set(email, []).get(email)!).push(t);
        if (t.customer_id) emailToCustomerId.set(email, t.customer_id);
      }
      if (t.customer_id) {
        (byCustomerId.get(t.customer_id) ?? byCustomerId.set(t.customer_id, []).get(t.customer_id)!).push(t);
      }
    }
    return { byEmail, byCustomerId, emailToCustomerId };
  }, [allTickets]);

  const ticketsFor = (refund: RefundApproval, linkedReturn: ReturnRow | null): ServiceTicket[] => {
    const emails = [refund.customer_email, linkedReturn?.customer_email]
      .map(e => (e ?? '').toLowerCase().trim())
      .filter(Boolean);
    if (emails.length === 0) return [];

    // Resolve the customer id(s) these emails belong to — from the customer
    // master (authoritative) and from the tickets themselves (covers a customer
    // with no master row). Then union tickets by customer id + by direct email.
    const custIds = new Set<string>();
    for (const email of emails) {
      const fromMaster = customerIdByEmail.get(email);
      if (fromMaster) custIds.add(fromMaster);
      const fromTicket = ticketIndex.emailToCustomerId.get(email);
      if (fromTicket) custIds.add(fromTicket);
    }

    const out = new Map<string, ServiceTicket>();
    for (const cid of custIds) {
      for (const t of ticketIndex.byCustomerId.get(cid) ?? []) out.set(t.id, t);
    }
    for (const email of emails) {
      for (const t of ticketIndex.byEmail.get(email) ?? []) out.set(t.id, t);
    }
    return [...out.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  };

  const selectedRefund = useMemo(
    () => approvals.find(a => a.id === selectedId) ?? null,
    [approvals, selectedId],
  );
  const selectedReturn = selectedRefund?.return_id
    ? returnsById.get(selectedRefund.return_id) ?? null
    : null;

  const byColumn = useMemo(() => {
    const m = new Map<ColKey, RefundApproval[]>();
    for (const col of COLUMNS) m.set(col.key, []);
    for (const a of approvals) {
      // Map status to column. 'submitted' rolls into manager_review since
      // submission immediately puts it in front of the manager.
      const k: ColKey | null =
        a.status === 'submitted' || a.status === 'manager_review' ? 'manager_review' :
        a.status === 'finance_review' ? 'finance_review' :
        a.status === 'refund_queue' ? 'refund_queue' :
        a.status === 'refunded' ? 'refunded' :
        a.status === 'denied' ? 'denied' :
        null;
      if (k) m.get(k)!.push(a);
    }
    return m;
  }, [approvals]);

  // Pre-George stage (CEO 2026-07): before a refund even reaches manager review,
  // the unit has to be returned and inspected, then compiled. Surface returns
  // that are physically back ('received') and don't yet have a refund request as
  // the first column of the queue, so the inspection step is visible.
  const inspectionReturns = useMemo(() => {
    const withApproval = new Set(approvals.map(a => a.return_id).filter(Boolean) as string[]);
    // Every return still in the return/inspection phase — from a freshly
    // submitted form ('created') through 'received'/'inspected' — that doesn't
    // yet have a refund request. New return-form submissions land here first.
    const TERMINAL = ['refunded', 'denied', 'closed', 'discarded'];
    return returns
      .filter(r => !TERMINAL.includes(r.status) && !withApproval.has(r.id))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [returns, approvals]);

  const stats = useMemo(() => {
    let totalRefunded = 0;
    let totalPending = 0;
    let oldestPendingDays: number | null = null;
    const now = Date.now();
    for (const a of approvals) {
      if (a.status === 'refunded') totalRefunded += Number(a.refund_amount_usd);
      if (a.status === 'manager_review' || a.status === 'finance_review' || a.status === 'submitted') {
        totalPending += Number(a.refund_amount_usd);
        const t = new Date(a.submitted_at).getTime();
        const days = Math.floor((now - t) / 86_400_000);
        if (oldestPendingDays === null || days > oldestPendingDays) oldestPendingDays = days;
      }
    }
    return {
      totalRefunded: Math.round(totalRefunded),
      totalPending: Math.round(totalPending),
      pendingCount: (byColumn.get('manager_review')?.length ?? 0) + (byColumn.get('finance_review')?.length ?? 0),
      oldestPendingDays,
    };
  }, [approvals, byColumn]);

  // Synced top scrollbar: the kanban is one horizontal row (no wrapping), so a
  // proxy scrollbar above mirrors the native one below and lets the operator
  // scroll the columns from either end.
  const kanbanRef = useRef<HTMLDivElement>(null);
  const topScrollRef = useRef<HTMLDivElement>(null);
  const [scrollW, setScrollW] = useState(0);
  useEffect(() => {
    const el = kanbanRef.current;
    if (!el) return;
    const update = () => setScrollW(el.scrollWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [approvals, inspectionReturns]);
  const syncFromTop = () => {
    if (kanbanRef.current && topScrollRef.current) kanbanRef.current.scrollLeft = topScrollRef.current.scrollLeft;
  };
  const syncFromKanban = () => {
    if (kanbanRef.current && topScrollRef.current) topScrollRef.current.scrollLeft = kanbanRef.current.scrollLeft;
  };

  if (aLoading || rLoading) return <div className={styles.loading}>Loading refunds…</div>;

  return (
    <div className={styles.tabContent}>
      <div className={styles.kpiRow}>
        <KPI label="Pending approval" value={stats.pendingCount} tone={stats.pendingCount > 0 ? 'warn' : undefined}
             sub={stats.totalPending > 0 ? `$${stats.totalPending.toLocaleString('en-US')} at stake` : 'queue empty'} />
        <KPI label="Oldest waiting" value={stats.oldestPendingDays !== null ? `${stats.oldestPendingDays}d` : '—'}
             tone={stats.oldestPendingDays !== null && stats.oldestPendingDays > 7 ? 'warn' : undefined} />
        <KPI label="Refunded total" value={`$${stats.totalRefunded.toLocaleString('en-US')}`}
             sub={`${byColumn.get('refunded')?.length ?? 0} payments`} />
        <KPI label="Your role"
             value={isManager && isFinance ? 'Mgr + Finance' : isManager ? 'Manager' : isFinance ? 'Finance' : 'View only'}
             sub={userEmail ?? ''} />
      </div>

      <div className={styles.refundsBar}>
        <button className={styles.requestRefundBtn} onClick={() => setShowRequestModal(true)}>
          + Request refund
        </button>
        {error && <span className={styles.refundsError}>{error}</span>}
      </div>

      <div ref={topScrollRef} className={styles.kanbanScrollTop} onScroll={syncFromTop}>
        <div style={{ width: scrollW }} />
      </div>
      <div ref={kanbanRef} className={styles.kanban} onScroll={syncFromKanban}>
        {/* Pre-George: unit returned & being inspected, before it's compiled
            and sent to manager review. */}
        <div className={styles.kanbanCol}>
          <div className={styles.kanbanColHead}>
            <span className={styles.kanbanColLabel}>Return &amp; inspection</span>
            <span className={styles.kanbanColCount}>{inspectionReturns.length}</span>
          </div>
          <div className={styles.kanbanColSub}>Unit returned &amp; inspected — before George</div>
          <div className={styles.kanbanList}>
            {inspectionReturns.length === 0 ? (
              <div className={styles.kanbanEmpty}>—</div>
            ) : inspectionReturns.map(r => (
              <div
                key={r.id}
                className={styles.refundCard}
                style={{ borderLeftColor: '#805ad5', cursor: 'pointer' }}
                role="button"
                tabIndex={0}
                onClick={() => setViewReturnId(r.id)}
                title="Click to view the full return form"
              >
                <div className={styles.refundCardHead}>
                  {/* When the filer isn't the buyer, show the purchaser as the customer. */}
                  <strong>{r.purchaser_name?.trim() || r.customer_name}</strong>
                  {r.refund_amount_usd != null && (
                    <span className={styles.refundAmount}>${Number(r.refund_amount_usd).toLocaleString('en-US')}</span>
                  )}
                </div>
                {(r.original_order_ref || r.unit_serial) && (
                  <div className={styles.refundMeta}>
                    {[r.original_order_ref, r.unit_serial].filter(Boolean).join(' · ')}
                  </div>
                )}
                {r.reason && <div className={styles.refundReason}>{r.reason}</div>}
                <div className={styles.refundMeta}>Unit returned — inspect, then compile for George</div>
                <div className={styles.refundActions} onClick={e => e.stopPropagation()}>
                  <button className={styles.refundApproveBtn} onClick={() => { setRequestReturnId(r.id); setShowRequestModal(true); }}>
                    Compile → George
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
        {COLUMNS.map(col => {
          const rows = byColumn.get(col.key) ?? [];
          return (
            <div key={col.key} className={styles.kanbanCol}>
              <div className={styles.kanbanColHead}>
                <span className={styles.kanbanColLabel}>{col.label}</span>
                <span className={styles.kanbanColCount}>{rows.length}</span>
              </div>
              <div className={styles.kanbanColSub}>{col.helper}</div>
              <div className={styles.kanbanList}>
                {rows.length === 0 ? (
                  <div className={styles.kanbanEmpty}>—</div>
                ) : rows.map(r => (
                  <RefundCard
                    key={r.id}
                    refund={r}
                    linkedReturn={r.return_id ? returnsById.get(r.return_id) ?? null : null}
                    usage={usageFor(r, r.return_id ? returnsById.get(r.return_id) ?? null : null)}
                    invoices={invoicesFor(r, r.return_id ? returnsById.get(r.return_id) ?? null : null)}
                    tickets={ticketsFor(r, r.return_id ? returnsById.get(r.return_id) ?? null : null)}
                    onOpenTicket={setOpenTicketId}
                    canManager={isManager}
                    canFinance={isFinance}
                    selected={selectedId === r.id}
                    onSelect={() => setSelectedId(prev => prev === r.id ? null : r.id)}
                    onError={setError}
                    onOpenFinanceModal={setFinanceModalId}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {selectedRefund && (
        <RefundDetailPanel
          refund={selectedRefund}
          linkedReturn={selectedReturn}
          usage={usageFor(selectedRefund, selectedReturn)}
          invoices={invoicesFor(selectedRefund, selectedReturn)}
          tickets={ticketsFor(selectedRefund, selectedReturn)}
          onOpenTicket={setOpenTicketId}
          queuedReplacements={replsByEmail.get((selectedRefund.customer_email ?? '').toLowerCase().trim()) ?? []}
          canManager={isManager}
          canFinance={isFinance}
          onClose={() => setSelectedId(null)}
          onError={setError}
          onOpenFinanceModal={setFinanceModalId}
        />
      )}

      {showRequestModal && (
        <RequestRefundModal
          returns={returns}
          initialReturnId={requestReturnId}
          onClose={() => { setShowRequestModal(false); setRequestReturnId(null); }}
          onError={setError}
        />
      )}

      {viewReturnId && (() => {
        const r = returnsById.get(viewReturnId);
        if (!r) return null;
        return <ReturnDetailModal r={r} onClose={() => setViewReturnId(null)} />;
      })()}

      {financeModalId && (() => {
        const refund = approvals.find(a => a.id === financeModalId);
        if (!refund) return null;
        const linked = refund.return_id ? returnsById.get(refund.return_id) ?? null : null;
        return (
          <FinanceApproveModal
            refund={refund}
            linkedReturn={linked}
            onClose={() => setFinanceModalId(null)}
            onError={setError}
          />
        );
      })()}

      {openTicket && (
        <TicketQuickView ticket={openTicket} onClose={() => setOpenTicketId(null)} />
      )}
    </div>
  );
}

// ============================================================================
// 30-day usage window badge — shows whether the customer has had the unit for
// 30+ days (case-by-case refund) or under 30 days, anchored on onboarding date.
// ============================================================================
function UsageWindowBadge({ usage }: { usage: RefundUsageWindow }) {
  if (usage.over30 === null) {
    return (
      <div className={styles.usageBadgeUnknown} title="No onboarding date on file for this customer">
        ⏱ Usage window unknown — no onboarding date
      </div>
    );
  }
  const dayLabel = usage.days === 1 ? '1 day' : `${usage.days} days`;
  return usage.over30 ? (
    <div className={styles.usageBadgeOver} title="30+ days of use — refund is not automatic; evaluate case-by-case">
      ⏱ {dayLabel} since onboarding · <strong>30+ days</strong> — review case-by-case
    </div>
  ) : (
    <div className={styles.usageBadgeUnder} title="Under 30 days of use">
      ⏱ {dayLabel} since onboarding · under 30 days
    </div>
  );
}

// ============================================================================
// Sales invoice + order number — the customer's original invoice(s) on file,
// surfaced the same way as the customer directory (invoice #, order #, date,
// amount, View link to the stored PDF).
// ============================================================================
function RefundInvoices({ invoices, fallbackOrderRef }: {
  invoices: CustomerInvoice[];
  fallbackOrderRef?: string | null;
}) {
  const view = async (path: string) => {
    try {
      const url = await getInvoiceSignedUrl(path);
      window.open(url, '_blank', 'noopener');
    } catch (e) { alert((e as Error).message); }
  };

  return (
    <div className={styles.invoiceBlock} onClick={e => e.stopPropagation()}>
      <div className={styles.invoiceBlockLabel}>Sales invoice &amp; order #</div>
      {invoices.length === 0 ? (
        <div className={styles.invoiceEmpty}>
          {fallbackOrderRef
            ? <>Order <span className={styles.invoiceOrder}>{fallbackOrderRef}</span> · no invoice on file</>
            : 'No sales invoice on file'}
        </div>
      ) : (
        invoices.map(inv => (
          <div key={inv.id} className={styles.invoiceRow}>
            <span className={styles.invoiceNum}>#{inv.invoice_number}</span>
            <span className={styles.invoiceType}>
              {inv.document_type === 'refund_receipt' ? 'Refund receipt' : 'Invoice'}
            </span>
            {inv.order_ref && <span className={styles.invoiceOrder}>{inv.order_ref}</span>}
            <span className={styles.invoiceDate}>
              {inv.invoice_date ? new Date(inv.invoice_date).toLocaleDateString('en-US') : '—'}
            </span>
            {inv.total_cad != null && (
              <span className={styles.invoiceAmount}>${Number(inv.total_cad).toFixed(2)} CAD</span>
            )}
            <button className={styles.invoiceView} onClick={() => void view(inv.storage_path)}>View</button>
          </div>
        ))
      )}
    </div>
  );
}

// ============================================================================
// Customer ticket history — collapsible list of the customer's service
// tickets (matched by email, same as the customer directory), with status
// badges. Click the header to open/close; click a row to open the ticket.
// ============================================================================
export function CustomerTicketHistory({ tickets, onOpenTicket, defaultOpen = false }: {
  tickets: ServiceTicket[];
  onOpenTicket: (ticketId: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const openCount = tickets.filter(t => t.status !== 'closed').length;

  return (
    <div className={styles.ticketBlock} onClick={e => e.stopPropagation()}>
      <button
        type="button"
        className={styles.ticketToggle}
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <span className={styles.ticketToggleChevron}>{open ? '▾' : '▸'}</span>
        Ticket history ({tickets.length})
        {openCount > 0 && <span className={styles.ticketOpenPill}>{openCount} open</span>}
      </button>
      {open && (
        tickets.length === 0 ? (
          <div className={styles.ticketEmpty}>No tickets on file for this customer.</div>
        ) : (
          <div className={styles.ticketList}>
            {tickets.map(t => {
              // Defensive: an unknown status (taxonomy drift) must not crash the
              // whole tab — fall back to a neutral badge. See memory note on the
              // 7-vs-10 state white-screen.
              const sm = TICKET_STATUS_META[t.status] ?? { label: t.status, color: '#4a5568', bg: '#edf2f7' };
              return (
                <button
                  key={t.id}
                  type="button"
                  className={styles.ticketRow}
                  onClick={() => onOpenTicket(t.id)}
                  title="Open ticket"
                >
                  <span className={styles.ticketNum}>{t.ticket_number}</span>
                  <span className={styles.ticketSubject} title={t.subject}>{t.subject}</span>
                  <span className={styles.ticketStatus} style={{ color: sm.color, background: sm.bg }}>
                    {sm.label}
                  </span>
                  <span className={styles.ticketDate}>
                    {new Date(t.created_at).toLocaleDateString('en-US')}
                  </span>
                </button>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}

// ============================================================================
// Ticket quick-view — read-only modal opened from a refund card's ticket
// history. Shows the ticket's key fields + message thread, using lib/service
// hooks (keeps the PostShipment module free of cross-module imports).
// ============================================================================
function TicketQuickView({ ticket, onClose }: { ticket: ServiceTicket; onClose: () => void }) {
  const { messages, loading } = useTicketMessages(ticket.id);
  const { notes, loading: notesLoading } = useTicketNotes(ticket.id);
  const sm = TICKET_STATUS_META[ticket.status];
  const body = ticket.summary ?? ticket.description;

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <div className={styles.ticketQvTitle}>
            <span className={styles.ticketNum}>{ticket.ticket_number}</span>
            <strong>{ticket.subject}</strong>
          </div>
          <button onClick={onClose} className={styles.modalClose}>✕</button>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.ticketQvMeta}>
            <span className={styles.ticketStatus} style={{ color: sm.color, background: sm.bg }}>{sm.label}</span>
            <span>{ticket.category}</span>
            <span>via {sourceLabel(ticket.source)}</span>
            {ticket.topic && <span>{topicLabel(ticket.topic)}</span>}
            <span>Opened {new Date(ticket.created_at).toLocaleDateString('en-US')}</span>
            <span>{ticket.message_count} msg{ticket.message_count === 1 ? '' : 's'}</span>
          </div>
          {body && <div className={styles.ticketQvDesc}>{body}</div>}

          <div className={styles.ticketQvThreadLabel}>
            Internal notes{!notesLoading && notes.length > 0 ? ` (${notes.length})` : ''}
          </div>
          {notesLoading ? (
            <div className={styles.ticketEmpty}>Loading notes…</div>
          ) : notes.length === 0 ? (
            <div className={styles.ticketEmpty}>No notes on this ticket.</div>
          ) : (
            <div className={styles.ticketQvNotes}>
              {notes.map(n => (
                <div key={n.id} className={styles.ticketNote}>
                  <div className={styles.ticketNoteBody}>{n.body}</div>
                  <div className={styles.ticketNoteMeta}>
                    <span>{n.author_email ?? 'Unknown'}</span>
                    <span>{new Date(n.created_at).toLocaleString('en-US')}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className={styles.ticketQvThreadLabel}>Conversation</div>
          {loading ? (
            <div className={styles.ticketEmpty}>Loading messages…</div>
          ) : messages.length === 0 ? (
            <div className={styles.ticketEmpty}>No messages on this ticket.</div>
          ) : (
            <div className={styles.ticketQvThread}>
              {messages.map(m => (
                <div key={m.id} className={m.direction === 'outbound' ? styles.ticketMsgOut : styles.ticketMsgIn}>
                  <div className={styles.ticketMsgHead}>
                    <span>{m.direction === 'outbound' ? '↩ ' : ''}{m.sender ?? (m.direction === 'outbound' ? 'Us' : 'Customer')}</span>
                    <span>{m.sent_at ? new Date(m.sent_at).toLocaleString('en-US') : ''}</span>
                  </div>
                  <div className={styles.ticketMsgBody}>{m.body_text ?? m.snippet ?? '—'}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Refund card
// ============================================================================
function RefundCard({
  refund, linkedReturn, usage, invoices, tickets, onOpenTicket, canManager, canFinance, selected, onSelect, onError, onOpenFinanceModal,
}: {
  refund: RefundApproval;
  linkedReturn: ReturnRow | null;
  usage: RefundUsageWindow;
  invoices: CustomerInvoice[];
  tickets: ServiceTicket[];
  onOpenTicket: (ticketId: string) => void;
  canManager: boolean;
  canFinance: boolean;
  selected: boolean;
  onSelect: () => void;
  onError: (msg: string | null) => void;
  onOpenFinanceModal: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [confirmMode, setConfirmMode] = useState<'approve' | 'deny' | null>(null);
  const [inputVal, setInputVal] = useState('');
  const meta = REFUND_STATUS_META[refund.status];

  // Approvers can correct the dollar amount inline at any stage.
  const canEditAmount = canManager || canFinance;
  const [editingAmount, setEditingAmount] = useState(false);
  const [amountDraft, setAmountDraft] = useState('');
  const startEditAmount = () => { setAmountDraft(String(refund.refund_amount_usd ?? '')); setEditingAmount(true); };
  const saveAmount = async () => {
    const next = Number(amountDraft);
    if (!Number.isFinite(next) || next < 0) { setEditingAmount(false); return; }
    if (next === Number(refund.refund_amount_usd)) { setEditingAmount(false); return; }
    setBusy(true); onError(null);
    try { await updateRefundAmount(refund.id, next); setEditingAmount(false); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  const runStatus = async (s: ReturnStatus) => {
    if (!linkedReturn || linkedReturn.status === s) return;
    setStatusBusy(true); onError(null);
    try { await updateReturnStatus(linkedReturn.id, s); }
    catch (e) { onError((e as Error).message); }
    finally { setStatusBusy(false); }
  };

  const openApprove = () => {
    if (refund.status === 'finance_review') { onOpenFinanceModal(refund.id); return; }
    setInputVal(''); setConfirmMode('approve');
  };
  const openDeny = () => { setInputVal(''); setConfirmMode('deny'); };
  const cancelConfirm = () => setConfirmMode(null);

  const runConfirm = async () => {
    if (confirmMode === 'deny' && !inputVal.trim()) return;
    setBusy(true); onError(null);
    try {
      if (confirmMode === 'approve') {
        await managerApprove(refund.id, inputVal.trim() || undefined);
      } else {
        const stage: 'manager_review' | 'finance_review' =
          refund.status === 'finance_review' ? 'finance_review' : 'manager_review';
        await denyRefund(refund.id, stage, inputVal.trim());
      }
      setConfirmMode(null);
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  const runClose = async () => {
    setBusy(true); onError(null);
    try { await closeRefund(refund.id); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  const runExecute = async () => {
    setBusy(true); onError(null);
    try { await executeRefund(refund.id); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  const canActManager = (refund.status === 'manager_review' || refund.status === 'submitted') && canManager;
  const canActFinance = refund.status === 'finance_review' && canFinance;
  // Refund Queue → execute the payout. Finance role (Julie / Huayi) does it.
  const canActExecute = refund.status === 'refund_queue' && canFinance;
  const canDeny = canActManager || canActFinance;

  return (
    <div
      className={`${styles.refundCard} ${selected ? styles.refundCardSelected : ''}`}
      style={{ borderLeftColor: meta.color }}
      onClick={onSelect}
      role="button"
      tabIndex={0}
    >
      <div className={styles.refundCardHead}>
        <strong>{refund.customer_name}</strong>
        {editingAmount ? (
          <span onClick={e => e.stopPropagation()} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <span style={{ fontWeight: 700 }}>$</span>
            <input
              autoFocus
              type="number" step="0.01" min="0"
              value={amountDraft}
              onChange={e => setAmountDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void saveAmount(); if (e.key === 'Escape') setEditingAmount(false); }}
              onBlur={() => void saveAmount()}
              disabled={busy}
              style={{ width: 90, fontSize: 13, fontWeight: 700, padding: '2px 4px',
                       border: '1px solid #2b6cb0', borderRadius: 4, textAlign: 'right' }}
            />
          </span>
        ) : (
          <span
            className={styles.refundAmount}
            onClick={canEditAmount ? (e) => { e.stopPropagation(); startEditAmount(); } : undefined}
            style={canEditAmount ? { cursor: 'pointer' } : undefined}
            title={canEditAmount ? 'Click to edit the refund amount' : undefined}
          >
            ${Number(refund.refund_amount_usd).toLocaleString('en-US')}{canEditAmount && ' ✎'}
          </span>
        )}
      </div>
      {refund.reason && <div className={styles.refundReason}>{refund.reason}</div>}
      {refund.payment_method && <div className={styles.refundMeta}>via {refund.payment_method}</div>}
      <UsageWindowBadge usage={usage} />
      <RefundInvoices invoices={invoices} fallbackOrderRef={linkedReturn?.original_order_ref} />
      <CustomerTicketHistory tickets={tickets} onOpenTicket={onOpenTicket} defaultOpen />
      {linkedReturn && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '6px 0', alignItems: 'center' }}
             onClick={e => e.stopPropagation()}>
          <select
            value={linkedReturn.status}
            onChange={e => void runStatus(e.target.value as ReturnStatus)}
            disabled={statusBusy}
            style={{ fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 4,
                     border: '1px solid #cbd5e0', background: '#edf2f7', color: '#2d3748',
                     cursor: 'pointer', maxWidth: 160 }}
          >
            {!UNIT_STAGES.some(st => st.value === linkedReturn.status) && (
              <option value={linkedReturn.status} disabled>
                📦 {UNIT_STATUS_LABEL[linkedReturn.status]}
              </option>
            )}
            {UNIT_STAGES.map(st => (
              <option key={st.value} value={st.value}>📦 {st.label}</option>
            ))}
          </select>
          {linkedReturn.disposition ? (
            <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
                           color: RETURN_DISPOSITION_META[linkedReturn.disposition].color,
                           background: RETURN_DISPOSITION_META[linkedReturn.disposition].bg }}>
              {RETURN_DISPOSITION_META[linkedReturn.disposition].label}
            </span>
          ) : (
            <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
                           color: '#975a16', background: '#fffbeb' }}>
              ⚠ Disposition not set
            </span>
          )}
        </div>
      )}
      <div className={styles.refundTimeline}>
        <RefundStep
          label="Submitted"
          ts={refund.submitted_at}
          active
        />
        {refund.manager_approved_at && (
          <RefundStep
            label="Manager ✓"
            ts={refund.manager_approved_at}
            note={refund.manager_decision_note}
            active
          />
        )}
        {refund.finance_approved_at && (
          <RefundStep
            label="Finance ✓ amount"
            ts={refund.finance_approved_at}
            note={refund.finance_decision_note}
            active
          />
        )}
        {refund.refunded_at && (
          <RefundStep
            label="Refunded ✓ paid"
            ts={refund.refunded_at}
            active
          />
        )}
        {refund.denied_at && (
          <RefundStep
            label={`Denied @ ${refund.denied_at_stage ? REFUND_STATUS_META[refund.denied_at_stage].label : 'review'}`}
            ts={refund.denied_at}
            note={refund.denied_reason}
            negative
            active
          />
        )}
      </div>
      <div className={styles.refundActions} onClick={e => e.stopPropagation()}>
        {confirmMode ? (
          <div className={styles.refundConfirmInline}>
            <input
              autoFocus
              type="text"
              placeholder={confirmMode === 'deny' ? 'Reason for denial (required)' : 'Note (optional)'}
              value={inputVal}
              onChange={e => setInputVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void runConfirm(); if (e.key === 'Escape') cancelConfirm(); }}
              className={styles.refundConfirmInput}
              disabled={busy}
            />
            <div className={styles.refundConfirmBtns}>
              <button
                onClick={() => void runConfirm()}
                disabled={busy || (confirmMode === 'deny' && !inputVal.trim())}
                className={confirmMode === 'approve' ? styles.refundApproveBtn : styles.refundDenyBtn}
              >{busy ? '…' : 'Confirm'}</button>
              <button onClick={cancelConfirm} disabled={busy} className={styles.refundCloseBtn}>✕</button>
            </div>
          </div>
        ) : (
          <>
            {(canActManager || canActFinance) && (
              <button onClick={openApprove} disabled={busy} className={styles.refundApproveBtn}>
                {canActManager ? 'Approve (manager)' : 'Approve amount → queue'}
              </button>
            )}
            {canActExecute && (
              <button onClick={() => void runExecute()} disabled={busy} className={styles.refundApproveBtn}>
                {busy ? '…' : '✓ Mark refunded (executed)'}
              </button>
            )}
            {canDeny && (
              <button onClick={openDeny} disabled={busy} className={styles.refundDenyBtn}>Deny</button>
            )}
            {refund.status === 'refunded' && (
              <button onClick={() => void runClose()} disabled={busy} className={styles.refundCloseBtn}>Close</button>
            )}
          </>
        )}
      </div>
      {!selected && (
        <div className={styles.refundCardHint}>Click to open the full case ↗</div>
      )}
    </div>
  );
}

// ============================================================================
// Detail panel — shown below the Kanban when a card is selected.
// Renders the linked return-form data + approve / deny actions.
// ============================================================================
function RefundDetailPanel({
  refund, linkedReturn, usage, invoices, tickets, onOpenTicket, queuedReplacements, canManager, canFinance, onClose, onError, onOpenFinanceModal,
}: {
  refund: RefundApproval;
  linkedReturn: ReturnRow | null;
  usage: RefundUsageWindow;
  invoices: CustomerInvoice[];
  tickets: ServiceTicket[];
  onOpenTicket: (ticketId: string) => void;
  queuedReplacements: Order[];
  canManager: boolean;
  canFinance: boolean;
  onClose: () => void;
  onError: (msg: string | null) => void;
  onOpenFinanceModal: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [holdBusy, setHoldBusy] = useState<string | null>(null);
  const { notes, refresh: refreshNotes } = useRefundNotes(refund.id);
  const [newNote, setNewNote] = useState('');
  const meta = REFUND_STATUS_META[refund.status];

  const canActManager = (refund.status === 'manager_review' || refund.status === 'submitted') && canManager;
  const canActFinance = refund.status === 'finance_review' && canFinance;
  const canActExecute = refund.status === 'refund_queue' && canFinance;
  const canAct = canActManager || canActFinance;

  const runExecute = async () => {
    setBusy(true); onError(null);
    try { await executeRefund(refund.id); onClose(); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  const runAddNote = async () => {
    if (!newNote.trim()) return;
    setBusy(true); onError(null);
    try { await addRefundNote(refund.id, newNote); setNewNote(''); refreshNotes(); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };
  const runDeleteNote = async (noteId: string) => {
    setBusy(true); onError(null);
    try { await deleteRefundNote(noteId, refund.id); refreshNotes(); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  const runDisposition = async (d: ReturnDisposition | null) => {
    if (!linkedReturn) return;
    setBusy(true); onError(null);
    try { await setReturnDisposition(linkedReturn.id, d); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  const runStatus = async (s: ReturnStatus) => {
    if (!linkedReturn || linkedReturn.status === s) return;
    setBusy(true); onError(null);
    try { await updateReturnStatus(linkedReturn.id, s); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  const [confirmMode, setConfirmMode] = useState<'approve' | 'deny' | null>(null);
  const [inputVal, setInputVal] = useState('');

  const openApprove = () => {
    if (canActFinance) { onOpenFinanceModal(refund.id); return; }
    setInputVal(''); setConfirmMode('approve');
  };
  const openDeny = () => { setInputVal(''); setConfirmMode('deny'); };
  const cancelConfirm = () => setConfirmMode(null);

  const runConfirm = async () => {
    if (confirmMode === 'deny' && !inputVal.trim()) return;
    setBusy(true); onError(null);
    try {
      if (confirmMode === 'approve') {
        await managerApprove(refund.id, inputVal.trim() || undefined);
        onClose();
      } else {
        const stage: 'manager_review' | 'finance_review' =
          refund.status === 'finance_review' ? 'finance_review' : 'manager_review';
        await denyRefund(refund.id, stage, inputVal.trim());
        onClose();
      }
      setConfirmMode(null);
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={`${styles.refundDetail} ${styles.refundDetailModal}`} onClick={e => e.stopPropagation()}>
      <div className={styles.refundDetailHead}>
        <div>
          <div className={styles.refundDetailTitleRow}>
            <h3 className={styles.refundDetailTitle}>{refund.customer_name}</h3>
            <span
              className={styles.refundDetailStatusPill}
              style={{ color: meta.color, background: meta.bg, borderColor: meta.border }}
            >{meta.label}</span>
          </div>
          <div className={styles.refundDetailSub}>
            {linkedReturn?.original_order_ref ?? '—'} ·
            {' '}{linkedReturn?.customer_email ?? refund.customer_email ?? '—'} ·
            {' '}{linkedReturn?.customer_phone ?? '—'}
          </div>
          <div style={{ marginTop: 6 }}>
            <UsageWindowBadge usage={usage} />
          </div>
          <div style={{ marginTop: 6, maxWidth: 520 }}>
            <RefundInvoices invoices={invoices} fallbackOrderRef={linkedReturn?.original_order_ref} />
          </div>
          <div style={{ marginTop: 6, maxWidth: 520 }}>
            <CustomerTicketHistory tickets={tickets} onOpenTicket={onOpenTicket} defaultOpen />
          </div>
        </div>
        <button onClick={onClose} className={styles.refundDetailClose} title="Close detail">✕</button>
      </div>

      {queuedReplacements.length > 0 && (
        <div className={styles.replWarnBanner}>
          <span className={styles.replWarnIcon}>⚠</span>
          <div className={styles.replWarnBody}>
            <strong>
              {queuedReplacements.length === 1
                ? 'This customer has a queued replacement'
                : `This customer has ${queuedReplacements.length} queued replacements`}
              — hold before refunding
            </strong>
            <div className={styles.replWarnRow}>
              {queuedReplacements.map(rpl => (
                <span key={rpl.id} className={styles.replWarnRef}>{rpl.order_ref} ({rpl.replacement_state})</span>
              ))}
              {queuedReplacements.filter(rpl => rpl.replacement_state !== 'held').map(rpl => (
                <button
                  key={rpl.id}
                  className={styles.replWarnHoldBtn}
                  disabled={holdBusy === rpl.id}
                  onClick={() => {
                    setHoldBusy(rpl.id);
                    void holdReplacement(
                      rpl.id,
                      `Held: refund in progress for ${refund.customer_name}`,
                    ).catch(e => onError((e as Error).message))
                      .finally(() => setHoldBusy(null));
                  }}
                >
                  {holdBusy === rpl.id ? '…' : `Hold ${rpl.order_ref}`}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {!linkedReturn ? (
        <div className={styles.refundDetailEmpty}>
          This refund isn't linked to a return record. No customer form data to display.
        </div>
      ) : (
        <>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', margin: '4px 0 8px' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#4a5568', marginRight: 2 }}>Unit status:</span>
          {UNIT_STAGES.map((st, i) => {
            const on = linkedReturn.status === st.value;
            return (
              <span key={st.value} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {i > 0 && <span style={{ color: '#cbd5e0' }}>→</span>}
                <button disabled={busy} onClick={() => void runStatus(st.value)}
                  style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
                           border: `1px solid ${on ? '#2b6cb0' : '#e2e8f0'}`,
                           color: on ? '#2b6cb0' : '#718096', background: on ? '#ebf8ff' : '#fff' }}>
                  {on ? '✓ ' : ''}{st.label}
                </button>
              </span>
            );
          })}
          {!UNIT_STAGES.some(st => st.value === linkedReturn.status) && (
            <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, color: '#2d3748', background: '#edf2f7' }}>
              {UNIT_STATUS_LABEL[linkedReturn.status]}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', margin: '0 0 12px' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#4a5568' }}>Instruction:</span>
          {(['ship_back', 'discard'] as ReturnDisposition[]).map(d => {
            const on = linkedReturn.disposition === d;
            const dm = RETURN_DISPOSITION_META[d];
            return (
              <button key={d} disabled={busy}
                onClick={() => void runDisposition(on ? null : d)}
                style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
                         border: `1px solid ${on ? dm.color : '#e2e8f0'}`,
                         color: on ? dm.color : '#718096', background: on ? dm.bg : '#fff' }}>
                {on ? '✓ ' : ''}{dm.label}
              </button>
            );
          })}
          {!linkedReturn.disposition && (
            <span style={{ fontSize: 11, color: '#975a16' }}>⚠ not set</span>
          )}
        </div>
        <ReturnFormAnswers r={linkedReturn} />
        </>
      )}

      {/* Notes for approvers (George/Julie) — collaborative, timestamped, attributed. */}
      <div style={{ margin: '12px 0', borderTop: '1px solid #edf2f7', paddingTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#4a5568', marginBottom: 6 }}>
          Notes for approvers ({notes.length})
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
          {notes.length === 0 && <div style={{ fontSize: 12, color: '#a0aec0' }}>No notes yet — add context for the approver here.</div>}
          {notes.map(n => (
            <div key={n.id} style={{ fontSize: 13, background: '#f7fafc', borderRadius: 6, padding: '6px 9px' }}>
              <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
              <div style={{ fontSize: 10, color: '#a0aec0', marginTop: 3, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>{n.author_name ?? 'Unknown'} · {new Date(n.created_at).toLocaleString()}</span>
                <button onClick={() => void runDeleteNote(n.id)} disabled={busy} title="Delete note"
                  style={{ border: 'none', background: 'none', color: '#cbd5e0', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>×</button>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <textarea value={newNote} onChange={e => setNewNote(e.target.value)} rows={2}
            placeholder="Add a note for approvers (extra details on the refund/return)…"
            style={{ flex: 1, fontSize: 13, padding: '6px 9px', border: '1px solid #e2e8f0', borderRadius: 6, resize: 'vertical' }} />
          <button onClick={() => void runAddNote()} disabled={busy || !newNote.trim()}
            style={{ fontSize: 12, fontWeight: 600, padding: '0 14px', borderRadius: 6, border: '1px solid #2b6cb0',
                     color: '#fff', background: '#2b6cb0', cursor: busy || !newNote.trim() ? 'default' : 'pointer', opacity: busy || !newNote.trim() ? 0.6 : 1 }}>
            Add note
          </button>
        </div>
      </div>

      <div className={styles.refundDetailActions}>
        <div className={styles.refundDetailRolePill}>
          {canActManager ? 'You can act as Manager for this case' :
           canActFinance ? 'You can act as Finance for this case' :
           canActExecute ? 'Approved — execute the payout, then mark refunded' :
           refund.status === 'refunded' ? 'Refunded — no action needed' :
           refund.status === 'denied'   ? 'Denied — no action needed' :
           refund.status === 'closed'   ? 'Closed — no action needed' :
                                          'Not your stage — view only'}
        </div>
        {confirmMode ? (
          <div className={styles.refundConfirmInline}>
            <textarea
              autoFocus
              rows={2}
              placeholder={confirmMode === 'deny' ? 'Reason for denial (required)' : 'Note (optional)'}
              value={inputVal}
              onChange={e => setInputVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') cancelConfirm(); }}
              className={styles.refundConfirmInput}
              disabled={busy}
            />
            <div className={styles.refundConfirmBtns}>
              <button
                onClick={() => void runConfirm()}
                disabled={busy || (confirmMode === 'deny' && !inputVal.trim())}
                className={confirmMode === 'approve' ? styles.refundDetailApproveBtn : styles.refundDetailDenyBtn}
              >{busy ? '…' : 'Confirm'}</button>
              <button onClick={cancelConfirm} disabled={busy} className={styles.refundCloseBtn}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className={styles.refundDetailButtons}>
            {canAct && (
              <button onClick={openApprove} disabled={busy} className={styles.refundDetailApproveBtn}>
                {canActManager ? '✓ Approve as Manager' : '✓ Approve amount → Refund Queue'}
              </button>
            )}
            {canActExecute && (
              <button onClick={() => void runExecute()} disabled={busy} className={styles.refundDetailApproveBtn}>
                {busy ? '…' : '✓ Mark refunded (executed)'}
              </button>
            )}
            {canAct && (
              <button onClick={openDeny} disabled={busy} className={styles.refundDetailDenyBtn}>
                ✕ Deny
              </button>
            )}
          </div>
        )}
      </div>
    </div>
    </div>
  );
}

// The full set of return-form answers, shared by the refund detail panel and
// the standalone read-only viewer (opened from the Return & inspection cards).
function ReturnFormAnswers({ r }: { r: ReturnRow }) {
  return (
    <div className={styles.refundDetailGrid}>
      <DetailField label="Order #" value={r.original_order_ref ?? '—'} mono />
      <DetailField label="Unit serial" value={r.unit_serial ?? '—'} mono />
      <DetailField label="Channel" value={r.channel ?? '—'} />
      <DetailField label="Source" value={r.source ?? '—'} />
      <DetailField label="Usage duration" value={r.usage_duration ?? '—'} />
      <DetailField label="Condition" value={r.condition ?? '—'} />
      <DetailField label="Packaging" value={r.packaging_status ?? '—'} />
      <DetailField label="Alternative composting" value={r.alternative_composting ?? '—'} />
      <DetailField label="Refund preference" value={r.refund_method_preference ?? '—'} />
      <DetailField label="Refund contact" value={r.refund_contact ?? '—'} mono />
      <DetailField label="Future LILA likelihood" value={r.future_likelihood ?? '—'} />
      <DetailField
        label="Experience rating"
        value={
          r.experience_rating
            ? `${STAR.repeat(r.experience_rating)}${'☆'.repeat(5 - r.experience_rating)} (${r.experience_rating}/5)`
            : '—'
        }
      />

      <DetailField label="Selected reasons" wide>
        {r.return_reasons && r.return_reasons.length > 0 ? (
          <div className={styles.reasonTags}>
            {r.return_reasons.map(x => (
              <span key={x} className={styles.reasonTag}>{x}</span>
            ))}
          </div>
        ) : '—'}
      </DetailField>

      {r.category_other && (
        <DetailField label="Primary reason (Other)" wide value={r.category_other} />
      )}

      {r.is_purchaser === false && (
        <DetailField label="Purchased by (not the filer)" wide>
          <div className={styles.detailQuote}>
            {r.purchaser_name ?? '—'}
            {r.purchaser_email ? ` · ${r.purchaser_email}` : ''}
            {r.purchaser_phone ? ` · ${r.purchaser_phone}` : ''}
          </div>
        </DetailField>
      )}

      <DetailField label="Support contacted" wide value={r.support_contacted ?? '—'} />

      <DetailField label="Issue description" wide>
        <div className={styles.detailQuote}>{r.description ?? '—'}</div>
      </DetailField>

      {r.would_change_decision && (
        <DetailField label="What would've changed their mind" wide>
          <div className={styles.detailQuote}>{r.would_change_decision}</div>
        </DetailField>
      )}

      {r.additional_comments && (
        <DetailField label="Additional comments" wide>
          <div className={styles.detailQuote}>{r.additional_comments}</div>
        </DetailField>
      )}
    </div>
  );
}

// Read-only viewer for a return's full submitted form — opened by clicking a
// card in the Return & inspection column (before a refund request exists).
function ReturnDetailModal({ r, onClose }: { r: ReturnRow; onClose: () => void }) {
  const displayName = r.purchaser_name?.trim() || r.customer_name;
  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={e => e.stopPropagation()} style={{ maxWidth: 720, maxHeight: '85vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <h3 className={styles.modalTitle} style={{ marginBottom: 2 }}>{displayName}</h3>
            <div style={{ fontSize: 12, color: '#718096' }}>
              Return form · {r.return_ref ?? r.original_order_ref ?? '—'}
              {r.is_purchaser === false && r.customer_name !== displayName && (
                <> · filed by {r.customer_name}</>
              )}
            </div>
            <div style={{ fontSize: 12, color: '#718096' }}>
              {[r.customer_email, r.customer_phone].filter(Boolean).join(' · ') || '—'}
            </div>
          </div>
          <button className={styles.btnSecondary} onClick={onClose}>Close</button>
        </div>
        <div style={{ marginTop: 12 }}>
          <ReturnFormAnswers r={r} />
        </div>
      </div>
    </div>
  );
}

function DetailField({
  label, value, children, mono, wide,
}: { label: string; value?: string; children?: React.ReactNode; mono?: boolean; wide?: boolean }) {
  return (
    <div className={`${styles.detailField} ${wide ? styles.detailFieldWide : ''}`}>
      <div className={styles.detailFieldLabel}>{label}</div>
      <div className={`${styles.detailFieldValue} ${mono ? styles.detailFieldMono : ''}`}>
        {children ?? value}
      </div>
    </div>
  );
}

function RefundStep({ label, ts, note, active, negative }: {
  label: string;
  ts: string;
  note?: string | null;
  active?: boolean;
  negative?: boolean;
}) {
  return (
    <div className={`${styles.refundStep} ${active ? styles.refundStepActive : ''} ${negative ? styles.refundStepNeg : ''}`}>
      <span className={styles.refundStepLabel}>{label}</span>
      <span className={styles.refundStepTs}>{new Date(ts).toLocaleString('en-US')}</span>
      {note && <div className={styles.refundStepNote}>{note}</div>}
    </div>
  );
}

// ============================================================================
// Request refund modal
// ============================================================================
function RequestRefundModal({
  returns, initialReturnId, onClose, onError,
}: {
  returns: ReturnRow[];
  initialReturnId?: string | null;
  onClose: () => void;
  onError: (msg: string | null) => void;
}) {
  const [returnId, setReturnId] = useState<string>('');
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('Stripe refund');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Surface returns still in the return/inspection phase (created → inspected)
  // that don't already have a refund_approval — the natural ones to request a
  // refund on. (We don't enforce this; CS can still type a freeform name.)
  const eligibleReturns = useMemo(
    () => returns.filter(r => ['created', 'received', 'inspected'].includes(r.status))
      .sort((a, b) => (b.created_at).localeCompare(a.created_at)),
    [returns],
  );

  const onReturnChange = (id: string) => {
    setReturnId(id);
    const r = returns.find(x => x.id === id);
    if (r) {
      // When the filer wasn't the buyer, the refund customer is the purchaser.
      setCustomerName(r.purchaser_name?.trim() || r.customer_name);
      setCustomerEmail((r.purchaser_email?.trim() || r.customer_email) ?? '');
      if (r.refund_amount_usd) setAmount(String(r.refund_amount_usd));
      if (r.reason) setReason(r.reason);
    }
  };

  // Pre-select the return when opened from a "Compile → George" button so the
  // purchaser (if any) pre-fills the customer name.
  useEffect(() => {
    if (initialReturnId) onReturnChange(initialReturnId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialReturnId]);

  const submit = async () => {
    if (!customerName.trim() || !amount.trim()) return;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) {
      onError('Amount must be a non-negative number');
      return;
    }
    setSubmitting(true); onError(null);
    try {
      await submitRefundRequest({
        return_id: returnId || undefined,
        customer_name: customerName.trim(),
        customer_email: customerEmail.trim() || undefined,
        refund_amount_usd: amt,
        payment_method: paymentMethod || undefined,
        reason: reason.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      onClose();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <strong>Request refund</strong>
          <button onClick={onClose} className={styles.modalClose}>✕</button>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.modalRow}>
            <label>Link to existing return (optional)</label>
            <select value={returnId} onChange={e => onReturnChange(e.target.value)} className={styles.modalInput}>
              <option value="">— freeform (no return) —</option>
              {eligibleReturns.map(r => (
                <option key={r.id} value={r.id}>
                  {r.return_ref ?? '(no ref)'} · {r.customer_name} · ${r.refund_amount_usd ?? 0}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.modalGrid}>
            <div className={styles.modalRow}>
              <label>Customer name</label>
              <input type="text" value={customerName} onChange={e => setCustomerName(e.target.value)}
                     className={styles.modalInput} required />
            </div>
            <div className={styles.modalRow}>
              <label>Customer email</label>
              <input type="email" value={customerEmail} onChange={e => setCustomerEmail(e.target.value)}
                     className={styles.modalInput} />
            </div>
            <div className={styles.modalRow}>
              <label>Refund amount (USD)</label>
              <input type="number" min="0" step="0.01" value={amount}
                     onChange={e => setAmount(e.target.value)} className={styles.modalInput} required />
            </div>
            <div className={styles.modalRow}>
              <label>Payment method</label>
              <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)} className={styles.modalInput}>
                <option>Stripe refund</option>
                <option>Shopify refund</option>
                <option>Cheque</option>
                <option>E-transfer</option>
                <option>Manual</option>
              </select>
            </div>
          </div>
          <div className={styles.modalRow}>
            <label>Reason (one-line summary)</label>
            <input type="text" value={reason} onChange={e => setReason(e.target.value)}
                   placeholder="e.g. Product defect, shipping damage…"
                   className={styles.modalInput} />
          </div>
          <div className={styles.modalRow}>
            <label>Notes</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)}
                      className={styles.modalTextarea} rows={2}
                      placeholder="Context for George / Julie" />
          </div>
        </div>
        <div className={styles.modalFoot}>
          <button onClick={onClose} className={styles.modalSecondary}>Cancel</button>
          <button onClick={() => void submit()} disabled={submitting || !customerName.trim() || !amount.trim()}
                  className={styles.modalPrimary}>
            {submitting ? 'Submitting…' : 'Submit for manager review'}
          </button>
        </div>
      </div>
    </div>
  );
}

function KPI({ label, value, tone, sub }: { label: string; value: number | string; tone?: 'warn'; sub?: string }) {
  return (
    <div className={styles.kpi}>
      <div className={styles.kpiLabel}>{label}</div>
      <div className={`${styles.kpiValue} ${tone === 'warn' ? styles.kpiWarn : ''}`}>{value}</div>
      {sub && <div className={styles.kpiSub}>{sub}</div>}
    </div>
  );
}

// ============================================================================
// Finance approve modal
// ============================================================================
function FinanceApproveModal({
  refund, linkedReturn, onClose, onError,
}: {
  refund: RefundApproval;
  linkedReturn: ReturnRow | null;
  onClose: () => void;
  onError: (m: string | null) => void;
}) {
  const [method, setMethod] = useState<RefundMethod>('shopify');
  const original = Number(refund.original_amount_usd ?? refund.refund_amount_usd);
  const [amountStr, setAmountStr] = useState(original.toFixed(2));
  const [note, setNote] = useState('');
  const [correctionNote, setCorrectionNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // Collaborative "Notes for approvers" — saved immediately, independent of the
  // Approve action. Fixes the case where the linked return isn't received yet
  // (Approve button disabled) but Julie/Huayi still need to record context.
  const { notes: approverNotes, refresh: refreshNotes } = useRefundNotes(refund.id);
  const [newNote, setNewNote] = useState('');
  const [noteBusy, setNoteBusy] = useState(false);
  const runAddNote = async () => {
    if (!newNote.trim()) return;
    setNoteBusy(true); setLocalError(null); onError(null);
    try { await addRefundNote(refund.id, newNote); setNewNote(''); refreshNotes(); }
    catch (e) { const m = (e as Error).message; setLocalError(m); onError(m); }
    finally { setNoteBusy(false); }
  };
  const runDeleteNote = async (noteId: string) => {
    setNoteBusy(true); setLocalError(null);
    try { await deleteRefundNote(noteId, refund.id); refreshNotes(); }
    catch (e) { const m = (e as Error).message; setLocalError(m); onError(m); }
    finally { setNoteBusy(false); }
  };

  const FINANCE_OK_STATUSES = ['received', 'inspected', 'refunded', 'closed'];
  const DEFECTIVE_CATEGORIES: ReturnCategory[] = ['product_defect', 'shipping_damage'];
  const isDefectiveDiscard =
    linkedReturn?.status === 'discarded' && (
      (linkedReturn.return_category != null && DEFECTIVE_CATEGORIES.includes(linkedReturn.return_category)) ||
      linkedReturn.return_reasons.some(r => /defect|crack|malfunction|hardware|broken|damag/i.test(r))
    );
  const returnNotReceived = linkedReturn != null && !FINANCE_OK_STATUSES.includes(linkedReturn.status) && !isDefectiveDiscard;

  const amount = Number(amountStr);
  const amountChanged = !Number.isNaN(amount) && Number(amount.toFixed(2)) !== Number(original.toFixed(2));

  const [shipping, setShipping] = useState<{ total: number; paidShipping: number } | null>(null);
  useEffect(() => {
    const ref = linkedReturn?.original_order_ref;
    if (!ref) { setShipping(null); return; }
    (async () => {
      const { data } = await supabase
        .from('orders')
        .select('total_usd, customer_paid_shipping_usd')
        .eq('order_ref', ref)
        .maybeSingle();
      if (data) {
        const d = data as { total_usd: number; customer_paid_shipping_usd: number | null };
        setShipping({
          total: Number(d.total_usd),
          paidShipping: Number(d.customer_paid_shipping_usd ?? 0),
        });
      }
    })();
  }, [linkedReturn?.original_order_ref]);

  const run = async () => {
    if (amountChanged && !correctionNote.trim()) {
      setLocalError('Correction note required when changing amount.');
      return;
    }
    setBusy(true); onError(null); setLocalError(null);
    try {
      await financeApprove(refund.id, {
        method,
        amount,
        correction_note: amountChanged ? correctionNote.trim() : undefined,
        note: note.trim() || undefined,
      });
      onClose();
    } catch (e) {
      const msg = (e as Error).message;
      setLocalError(msg);
      onError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={e => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>Approve refund amount</h3>

        {returnNotReceived && (
          <div className={styles.financeModalWarn}>
            ⚠ Linked return is in "<strong>{linkedReturn!.status}</strong>" status — refund can only
            be processed after the unit is received, or marked as discarded due to a confirmed defect or damage.
          </div>
        )}
        {localError && <div className={styles.financeModalError}>{localError}</div>}

        <div className={styles.modalField}>
          <label className={styles.modalLabel}>Method</label>
          <select
            value={method}
            onChange={e => setMethod(e.target.value as RefundMethod)}
            className={styles.modalInput}
          >
            {REFUND_METHODS.map(m => (
              <option key={m} value={m}>{REFUND_METHOD_META[m].label}</option>
            ))}
          </select>
          <div className={styles.modalHint}>{REFUND_METHOD_META[method].description}</div>
        </div>

        <div className={styles.modalField}>
          <label className={styles.modalLabel}>Amount (USD)</label>
          <input
            type="number" step="0.01" min="0"
            value={amountStr}
            onChange={e => setAmountStr(e.target.value)}
            className={styles.modalInput}
          />
          <div className={styles.modalHint}>
            Original request: ${original.toFixed(2)}
            {shipping && (
              <> · Order total: ${shipping.total.toFixed(2)} · Shipping (customer-paid, non-refundable): ${shipping.paidShipping.toFixed(2)} · Max refundable: ${(shipping.total - shipping.paidShipping).toFixed(2)}</>
            )}
          </div>
        </div>

        {amountChanged && (
          <div className={styles.modalField}>
            <label className={styles.modalLabel}>Correction note <span style={{color:'var(--color-error, #c53030)'}}>*</span></label>
            <textarea
              value={correctionNote}
              onChange={e => setCorrectionNote(e.target.value)}
              placeholder="Why is the amount different from the original request?"
              className={styles.modalInput}
              rows={3}
            />
          </div>
        )}

        <div className={styles.modalField}>
          <label className={styles.modalLabel}>Note (optional)</label>
          <input
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Stripe refund ID, etc."
            className={styles.modalInput}
          />
        </div>

        <div className={styles.modalField}>
          <label className={styles.modalLabel}>Notes for approvers ({approverNotes.length})</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
            {approverNotes.length === 0 && (
              <div style={{ fontSize: 12, color: '#a0aec0' }}>No notes yet — save context here without approving.</div>
            )}
            {approverNotes.map(n => (
              <div key={n.id} style={{ fontSize: 13, background: '#f7fafc', borderRadius: 6, padding: '6px 9px' }}>
                <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
                <div style={{ fontSize: 10, color: '#a0aec0', marginTop: 3, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span>{n.author_name ?? 'Unknown'} · {new Date(n.created_at).toLocaleString()}</span>
                  <button onClick={() => void runDeleteNote(n.id)} disabled={noteBusy} title="Delete note"
                    style={{ border: 'none', background: 'none', color: '#cbd5e0', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>×</button>
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <textarea
              value={newNote}
              onChange={e => setNewNote(e.target.value)}
              rows={2}
              placeholder="Add a note for approvers (saved immediately, no approval needed)…"
              className={styles.modalInput}
              style={{ resize: 'vertical' }}
            />
            <button onClick={() => void runAddNote()} disabled={noteBusy || !newNote.trim()}
              className={styles.btnPrimary} style={{ whiteSpace: 'nowrap' }}>
              {noteBusy ? 'Saving…' : 'Add note'}
            </button>
          </div>
        </div>

        <div className={styles.modalActions}>
          <button onClick={onClose} disabled={busy} className={styles.btnSecondary}>Cancel</button>
          <button
            onClick={() => void run()}
            disabled={busy || Number.isNaN(amount) || amount < 0 || returnNotReceived}
            className={styles.btnPrimary}
          >
            {busy ? 'Processing…' : `Approve $${Number.isNaN(amount) ? '?' : amount.toFixed(2)} → Refund Queue`}
          </button>
        </div>
      </div>
    </div>
  );
}
