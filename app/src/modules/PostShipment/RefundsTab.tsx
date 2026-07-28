import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useRefundApprovals, useReturns,
  submitRefundRequest, compileReturnToRefund, updateRefundAmount, setRefundCurrency, type RefundCurrency, submitToManager, managerApprove, financeApprove, executeRefund, denyRefund, closeRefund,
  sendRefundBack, uncompileRefund, type RefundBackTarget,
  confirmPurchaserLinkage, hasValidPurchaserLinkage,
  computeRefundNet, defaultRefundFees,
  preRefundStage, customerWaitState,
  setReturnDisposition, updateReturnStatus,
  useReturnAttachments, uploadReturnAttachment, deleteReturnAttachment, returnAttachmentSignedUrl,
  RETURN_ATTACH_INPUT_ACCEPT, type ReturnAttachment,
  bookReturnLabel,
  useRefundNotes, addRefundNote, deleteRefundNote, updateRefundNote,
  useReturnNotes, addReturnNote, deleteReturnNote, updateReturnNote,
  REFUND_STATUS_META, REFUND_METHODS, REFUND_METHOD_META,
  UNIT_STATUS_LABEL, RETURN_DISPOSITION_META,
  type RefundApproval, type ReturnRow, type RefundMethod, type ReturnDisposition, type ReturnStatus, type ReturnCategory,
} from '../../lib/postShipment';

// Operator-facing unit-status stages, editable from the refund detail panel.
const UNIT_STAGES: { value: ReturnStatus; label: string }[] = [
  { value: 'created',          label: 'Return form submitted' },
  { value: 'pickup_scheduled', label: 'Pickup scheduled' },
  { value: 'picked_up',        label: 'Picked up' },
  { value: 'received',         label: 'Unit returned' },
  // BUG-5 (Lisa Clark gap): 'inspected' exists in ReturnStatus but was missing
  // from this dropdown, so operators could never record that the returned unit
  // was inspected — leaving the Manager unable to tell. FR-2's approval gate
  // treats 'received' and 'inspected' alike, but recording inspection is what
  // lets the Manager see the case is actually complete.
  { value: 'inspected',        label: 'Unit inspected' },
  { value: 'discarded',        label: 'Unit discarded by customer' },
];
import { useQueuedReplacements, holdReplacement, type Order } from '../../lib/orders';
import { useOnboardDates, useCustomerIdByEmail, useCustomers, refundUsageWindow, resolveRefundParties, type RefundParties, type RefundUsageWindow } from '../../lib/customers';
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

type ColKey = 'submitted' | 'manager_review' | 'finance_review' | 'refund_queue' | 'refunded' | 'denied';

const COLUMNS: { key: ColKey; label: string; helper: string }[] = [
  { key: 'submitted',      label: 'Completeness',   helper: 'Reina — submit when ready' },
  { key: 'manager_review', label: 'Manager review',  helper: 'George approves' },
  { key: 'finance_review', label: 'Finance review',  helper: 'Julie / Huayi approve (amount)' },
  { key: 'refund_queue',   label: 'Refund Queue',    helper: 'Pedrum executes the payout' },
  { key: 'refunded',       label: 'Refunded',        helper: 'Payment executed' },
  { key: 'denied',         label: 'Denied',          helper: 'Rejected — shows which stage' },
];

// Per-person column ownership: only a column's owner may approve/move its cards
// FORWARD to the next column. Denials and back-moves stay open to everyone.
// Column keys are the refund_approval statuses, plus the pre-refund stages
// 'intake' (Return Form Submitted) and 'inspection' (Return & Inspection).
// Keep in sync with the send-refund-reminders edge function recipients.
const REFUND_COLUMN_OWNERS: Record<string, string[]> = {
  intake:         ['reina@virgohome.io'],
  inspection:     ['reina@virgohome.io'],
  submitted:      ['reina@virgohome.io'],
  manager_review: ['george@virgohome.io'],
  finance_review: ['yueli@virgohome.io', 'huayi@virgohome.io'],
  refund_queue:   ['pedrum@virgohome.io'],
};
function ownsRefundColumn(email: string | null | undefined, column: string | null | undefined): boolean {
  const e = (email ?? '').toLowerCase().trim();
  return !!column && !!e && (REFUND_COLUMN_OWNERS[column] ?? []).includes(e);
}

export function RefundsTab() {
  const { approvals, loading: aLoading } = useRefundApprovals();
  const { returns, loading: rLoading } = useReturns();
  const { replacements: queuedRepls } = useQueuedReplacements();
  const { byEmail: onboardByEmail } = useOnboardDates();
  const { byEmail: invoicesByEmail } = useInvoicesByCustomerEmail();
  const { byEmail: customerIdByEmail } = useCustomerIdByEmail();
  const { customers } = useCustomers();
  const { tickets: allTickets } = useServiceTickets();
  const { user, profile, role } = useAuth();
  // Gate on the profile email (loaded from the DB, stable) — the auth session's
  // user.email is often transiently undefined after a token refresh, which would
  // silently blank out every column owner's forward/approve button.
  const userEmail = profile?.email ?? user?.email;

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
  // Everyone involved can move cards forward/back + edit amount/notes.
  const canFlow = canDo(role, 'move_refund_flow');

  const returnsById = useMemo(() => {
    const m = new Map<string, ReturnRow>();
    for (const r of returns) m.set(r.id, r);
    return m;
  }, [returns]);

  // FR-6: the customer directory drives purchaser vs user. Build email→row and
  // id→row maps so a card can resolve a filer to their linked purchaser.
  const customerByEmail = useMemo(() => {
    const m = new Map<string, { id: string; full_name: string; purchaser_id: string | null; primary_user_name: string | null }>();
    for (const c of customers) {
      if (c.email) m.set(c.email.toLowerCase().trim(), { id: c.id, full_name: c.full_name, purchaser_id: c.purchaser_id, primary_user_name: c.primary_user_name });
    }
    return m;
  }, [customers]);
  const customerById = useMemo(() => {
    const m = new Map<string, { full_name: string; primary_user_name: string | null }>();
    for (const c of customers) m.set(c.id, { full_name: c.full_name, primary_user_name: c.primary_user_name });
    return m;
  }, [customers]);

  // Resolve the purchaser + primary user for a card (FR-6). The customer
  // directory is authoritative; the return form's attestation is only a fallback
  // for filers not in the directory.
  const partiesFor = (opts: {
    filerEmail?: string | null; filerName: string;
    isPurchaser?: boolean | null; purchaserName?: string | null;
  }): Parties =>
    resolveRefundParties({
      filerEmail: opts.filerEmail, filerName: opts.filerName,
      byEmail: customerByEmail, byId: customerById,
      attestIsPurchaser: opts.isPurchaser ?? null, attestPurchaserName: opts.purchaserName ?? null,
    });
  const partiesForReturn = (r: ReturnRow): Parties =>
    partiesFor({ filerEmail: r.customer_email, filerName: r.customer_name, isPurchaser: r.is_purchaser, purchaserName: r.purchaser_name });
  const partiesForRefund = (refund: RefundApproval, ret: ReturnRow | null): Parties =>
    partiesFor({
      filerEmail: ret?.customer_email ?? refund.customer_email,
      filerName: refund.customer_name,
      isPurchaser: ret?.is_purchaser ?? null,
      purchaserName: ret?.purchaser_name ?? null,
    });

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
  const usageForEmail = (email?: string | null): RefundUsageWindow => {
    const e = (email ?? '').toLowerCase().trim();
    return refundUsageWindow(e ? onboardByEmail.get(e) : null);
  };
  const usageFor = (refund: RefundApproval, linkedReturn: ReturnRow | null): RefundUsageWindow =>
    usageForEmail(refund.customer_email ?? linkedReturn?.customer_email);

  // The customer's sales invoice(s) — resolved by email, the same way the
  // customer directory surfaces them (both key off the customer record).
  const invoicesForEmail = (email?: string | null): CustomerInvoice[] => {
    const e = (email ?? '').toLowerCase().trim();
    return e ? invoicesByEmail.get(e) ?? [] : [];
  };
  const invoicesFor = (refund: RefundApproval, linkedReturn: ReturnRow | null): CustomerInvoice[] =>
    invoicesForEmail(refund.customer_email ?? linkedReturn?.customer_email);

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

  const ticketsForEmails = (rawEmails: Array<string | null | undefined>): ServiceTicket[] => {
    const emails = rawEmails.map(e => (e ?? '').toLowerCase().trim()).filter(Boolean);
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
  const ticketsFor = (refund: RefundApproval, linkedReturn: ReturnRow | null): ServiceTicket[] =>
    ticketsForEmails([refund.customer_email, linkedReturn?.customer_email]);

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
      // Map status to column. FR-3: 'submitted' is the account manager's
      // Completeness/prep column, distinct from 'manager_review' (Awaiting
      // George) — the Submit action promotes one to the other.
      const k: ColKey | null =
        a.status === 'submitted' ? 'submitted' :
        a.status === 'manager_review' ? 'manager_review' :
        a.status === 'finance_review' ? 'finance_review' :
        a.status === 'refund_queue' ? 'refund_queue' :
        a.status === 'refunded' ? 'refunded' :
        a.status === 'denied' ? 'denied' :
        null;
      if (k) m.get(k)!.push(a);
    }
    return m;
  }, [approvals]);

  // FR-1 (PRD §4): the two Account-Manager-owned columns before Manager Review.
  // A return without a refund request yet is split by unit status into
  // "Return Form Submitted" (Intake / New — form in, unit not yet back) and
  // "Return & inspection" (unit physically back, being inspected). Reina owns
  // both. Terminal statuses (refunded/denied/closed/discarded) drop out.
  const preRefundReturns = useMemo(() => {
    const withApproval = new Set(approvals.map(a => a.return_id).filter(Boolean) as string[]);
    const eligible = returns
      .filter(r => preRefundStage(r.status) !== null && !withApproval.has(r.id))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return {
      intake: eligible.filter(r => preRefundStage(r.status) === 'intake'),
      inspection: eligible.filter(r => preRefundStage(r.status) === 'inspection'),
    };
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
      pendingCount: (byColumn.get('submitted')?.length ?? 0) + (byColumn.get('manager_review')?.length ?? 0) + (byColumn.get('finance_review')?.length ?? 0),
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
  }, [approvals, preRefundReturns]);
  const syncFromTop = () => {
    if (kanbanRef.current && topScrollRef.current) kanbanRef.current.scrollLeft = topScrollRef.current.scrollLeft;
  };
  const syncFromKanban = () => {
    if (kanbanRef.current && topScrollRef.current) topScrollRef.current.scrollLeft = kanbanRef.current.scrollLeft;
  };

  // Compile a return straight into Completeness — no amount/method prompt. The
  // amount + payment method are set by Finance (Julie) at Finance Review.
  const compileReturn = async (r: ReturnRow) => {
    setError(null);
    try { await compileReturnToRefund(r); }
    catch (e) { setError((e as Error).message); }
  };

  // FR-1: both pre-manager columns render the same InspectionCard; only the
  // heading, helper, and row set differ. Reina (Account Manager) owns both.
  const renderPreRefundColumn = (label: string, helper: string, rows: ReturnRow[]) => (
    <div className={styles.kanbanCol}>
      <div className={styles.kanbanColHead}>
        <span className={styles.kanbanColLabel}>{label}</span>
        <span className={styles.kanbanColCount}>{rows.length}</span>
      </div>
      <div className={styles.kanbanColSub}>{helper}</div>
      <div className={styles.kanbanList}>
        {rows.length === 0 ? (
          <div className={styles.kanbanEmpty}>—</div>
        ) : rows.map(r => {
          const email = r.purchaser_email?.trim() || r.customer_email;
          return (
            <InspectionCard
              key={r.id}
              r={r}
              canOwn={ownsRefundColumn(userEmail, preRefundStage(r.status))}
              parties={partiesForReturn(r)}
              usage={usageForEmail(email)}
              invoices={invoicesForEmail(email)}
              tickets={ticketsForEmails([r.purchaser_email, r.customer_email])}
              onOpenTicket={setOpenTicketId}
              onView={() => setViewReturnId(r.id)}
              onCompile={() => void compileReturn(r)}
              onError={setError}
            />
          );
        })}
      </div>
    </div>
  );

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
        {/* FR-1 (PRD §4) — Account-Manager (Reina) owned intake + inspection,
            before the card is compiled and sent to Manager Review. */}
        {renderPreRefundColumn(
          'Return Form Submitted',
          'Reina — new return forms · before the unit ships back',
          preRefundReturns.intake,
        )}
        {renderPreRefundColumn(
          'Return & inspection',
          'Reina — unit returned & inspected · before George',
          preRefundReturns.inspection,
        )}
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
                    parties={partiesForRefund(r, r.return_id ? returnsById.get(r.return_id) ?? null : null)}
                    canApproveHere={ownsRefundColumn(userEmail, r.status)}
                    usage={usageFor(r, r.return_id ? returnsById.get(r.return_id) ?? null : null)}
                    invoices={invoicesFor(r, r.return_id ? returnsById.get(r.return_id) ?? null : null)}
                    tickets={ticketsFor(r, r.return_id ? returnsById.get(r.return_id) ?? null : null)}
                    onOpenTicket={setOpenTicketId}
                    canFlow={canFlow}
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
          parties={partiesForRefund(selectedRefund, selectedReturn)}
          canApproveHere={ownsRefundColumn(userEmail, selectedRefund.status)}
          usage={usageFor(selectedRefund, selectedReturn)}
          invoices={invoicesFor(selectedRefund, selectedReturn)}
          tickets={ticketsFor(selectedRefund, selectedReturn)}
          onOpenTicket={setOpenTicketId}
          queuedReplacements={replsByEmail.get((selectedRefund.customer_email ?? '').toLowerCase().trim()) ?? []}
          canFlow={canFlow}
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
        const email = r.purchaser_email?.trim() || r.customer_email;
        return <ReturnDetailModal
          r={r}
          parties={partiesForReturn(r)}
          usage={usageForEmail(email)}
          invoices={invoicesForEmail(email)}
          tickets={ticketsForEmails([r.purchaser_email, r.customer_email])}
          onOpenTicket={setOpenTicketId}
          onError={setError}
          onClose={() => setViewReturnId(null)}
        />;
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
// BR-16 — "awaiting customer, day X" indicator. Shows on an intake ('created')
// return that's been waiting on the customer: amber once past the 7-day remind
// threshold, red (escalate) at 14 days or once followup_escalated_at is set.
// Fresh (< 7 days) and non-intake returns render nothing.
// ============================================================================
function CustomerWaitBadge({ r }: { r: ReturnRow }) {
  if (r.status !== 'created') return null;
  const w = customerWaitState(r.created_at);
  if (!w) return null;
  const escalated = w.stage === 'escalate' || !!r.followup_escalated_at;
  if (w.stage === 'fresh' && !escalated) return null;
  const dayLabel = w.days === 1 ? 'day 1' : `day ${w.days}`;
  return escalated ? (
    <div className={styles.usageBadgeOver}
         title="Awaiting the customer past the escalation interval (14+ days) — take it over or close it (BR-16).">
      ⚠ Awaiting customer · {dayLabel} — <strong>escalate</strong>
    </div>
  ) : (
    <div className={styles.usageBadgeUnknown}
         title="Awaiting a customer response — auto-reminders are going out every 7 days (BR-16).">
      ⏳ Awaiting customer · {dayLabel} — reminder sent
    </div>
  );
}

// ============================================================================
// FR-6 — Purchaser vs User. Every card/detail header states plainly whether the
// prominent name is the CUSTOMER (purchaser of record — accounting is against
// this person, BR-13) or, when the filer isn't the buyer (gift/household),
// shows the purchaser AND the USER who filed, each labelled.
// ============================================================================
type Parties = RefundParties;

function PartyPill({ text, tone, title }: { text: string; tone: 'purchaser' | 'user'; title: string }) {
  const c = tone === 'user'
    ? { color: '#2b6cb0', background: '#ebf8ff' }
    : { color: '#276749', background: '#f0fff4' };
  return (
    <span title={title} style={{
      fontSize: 9, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
      padding: '1px 5px', borderRadius: 4, marginLeft: 6, whiteSpace: 'nowrap', ...c,
    }}>{text}</span>
  );
}

// Small "filled the form" tag, shown on whichever party actually filed it, so
// it's clear whether the form-filler is the purchaser and/or the primary user.
function FiledTag({ show }: { show: boolean }) {
  return show ? <span style={{ fontSize: 10, color: '#a0aec0', marginLeft: 6 }}>· filled the form</span> : null;
}

// FR-6: state the roles definitively. When the customer is both the purchaser
// and the primary user, one combined line; otherwise a Purchaser line and a
// Primary user line, with the form-filler tagged.
function PartyHeader({ parties, nameNode }: { parties: Parties; nameNode?: (name: string) => React.ReactNode }) {
  const { purchaser, primaryUser, filer, samePerson, filerIsPurchaser, filerIsPrimaryUser } = parties;
  const name = (n: string) => nameNode ? nameNode(n) : <strong>{n}</strong>;

  if (samePerson) {
    return (
      <span>
        {name(purchaser)}
        <PartyPill text="Purchaser & primary user" tone="purchaser"
          title="This customer paid for the machine and is its primary user." />
        <FiledTag show={filerIsPurchaser} />
      </span>
    );
  }
  return (
    <span>
      {name(purchaser)}
      <PartyPill text="Purchaser" tone="purchaser"
        title="Purchaser of record — the refund is processed against this person (BR-13)." />
      <FiledTag show={filerIsPurchaser} />
      <span style={{ display: 'block', fontSize: 12, color: '#718096', marginTop: 2 }}>
        <strong style={{ fontWeight: 600 }}>{primaryUser}</strong>
        <PartyPill text="Primary user" tone="user" title="The primary user of the machine — may differ from who paid or who filed." />
        <FiledTag show={filerIsPrimaryUser} />
      </span>
      {!filerIsPurchaser && !filerIsPrimaryUser && (
        <span style={{ display: 'block', fontSize: 12, color: '#718096', marginTop: 2 }}>
          <strong style={{ fontWeight: 600 }}>{filer}</strong>
          <PartyPill text="Filed the form" tone="user" title="The person who submitted the return/refund form — neither the purchaser nor the primary user." />
        </span>
      )}
    </span>
  );
}

// USD ⇄ CAD toggle for the refund amount (a label — the value isn't converted).
// Editable by anyone who can edit the amount; read-only chip otherwise.
function CurrencyToggle({ refund, editable, onError }: { refund: RefundApproval; editable: boolean; onError: (m: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const cur: RefundCurrency = refund.currency === 'CAD' ? 'CAD' : 'USD';
  if (!editable) {
    return <span style={{ fontSize: 9, fontWeight: 700, color: '#a0aec0' }}>{cur}</span>;
  }
  const toggle = async () => {
    setBusy(true); onError(null);
    try { await setRefundCurrency(refund.id, cur === 'USD' ? 'CAD' : 'USD'); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <button onClick={e => { e.stopPropagation(); void toggle(); }} disabled={busy}
      title="Switch currency (USD ⇄ CAD)"
      style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.3, padding: '1px 6px', borderRadius: 4, cursor: 'pointer',
               border: '1px solid #cbd5e0', background: '#fff', color: '#4a5568', whiteSpace: 'nowrap' }}>
      {busy ? '…' : `${cur} ⇄`}
    </button>
  );
}

// Editable refund amount + currency toggle. Used on the card head AND in the
// opened detail panel so both stay identical.
function AmountEditor({ refund, editable, onError, big }: {
  refund: RefundApproval; editable: boolean; onError: (m: string | null) => void; big?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const start = () => { setDraft(String(refund.refund_amount_usd ?? '')); setEditing(true); };
  const save = async () => {
    const next = Number(draft);
    if (!Number.isFinite(next) || next < 0) { setEditing(false); return; }
    if (next === Number(refund.refund_amount_usd)) { setEditing(false); return; }
    setBusy(true); onError(null);
    try { await updateRefundAmount(refund.id, next); setEditing(false); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }} onClick={e => e.stopPropagation()}>
      {editing ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <span style={{ fontWeight: 700 }}>$</span>
          <input autoFocus type="number" step="0.01" min="0" value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setEditing(false); }}
            onBlur={() => void save()} disabled={busy}
            style={{ width: 100, fontSize: big ? 16 : 13, fontWeight: 700, padding: '2px 4px', border: '1px solid #2b6cb0', borderRadius: 4, textAlign: 'right' }} />
        </span>
      ) : (
        <span className={styles.refundAmount}
          onClick={editable ? start : undefined}
          style={{ ...(editable ? { cursor: 'pointer' } : {}), ...(big ? { fontSize: 18 } : {}) }}
          title={editable ? 'Click to edit the refund amount' : undefined}>
          ${Number(refund.refund_amount_usd).toLocaleString('en-US')}{editable && ' ✎'}
        </span>
      )}
      <CurrencyToggle refund={refund} editable={editable} onError={onError} />
    </div>
  );
}

// ============================================================================
// FR-14 — paste-to-attach photos/documents on a return card. Ported from the
// ticket AttachmentStrip: a window-level paste listener (Safari never fires
// `paste` on a div) captures clipboard images; a hidden file input covers the
// click path. Files go to the return-documents bucket via the lib layer.
// ============================================================================
function imageFilesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.items && dt.items.length) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  if (!out.length && dt.files) {
    for (const f of Array.from(dt.files)) if (f.type.startsWith('image/')) out.push(f);
  }
  return out;
}
function toNamedFile(blob: File): File {
  if (blob.name && blob.name !== 'image.png') return blob;
  const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  return new File([blob], `pasted-${Date.now()}.${ext}`, { type: blob.type });
}

// FR-13 — one-click return-shipping label. Shows the booked tracking once a
// label exists; otherwise offers to generate one (books a real Freightcom
// shipment, so it confirms first). Only meaningful when the customer ships the
// unit back (disposition 'ship_back').
function ReturnLabelControl({ r, onError }: { r: ReturnRow; onError: (m: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  if (r.disposition === 'discard') return null; // discard = no return shipment

  if (r.pickup_tracking) {
    return (
      <span onClick={e => e.stopPropagation()}
        style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, color: '#276749', background: '#f0fff4' }}
        title={`Return label booked${r.pickup_carrier ? ` · ${r.pickup_carrier}` : ''}`}>
        🏷 {r.pickup_carrier ? `${r.pickup_carrier} · ` : ''}{r.pickup_tracking}
      </span>
    );
  }

  const run = async () => {
    if (!window.confirm('Generate a return shipping label and book courier pickup for this unit? This books a shipment with the carrier.')) return;
    setBusy(true); onError(null);
    try {
      const res = await bookReturnLabel(r.id);
      if (res.label_url) window.open(res.label_url, '_blank', 'noopener');
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <button onClick={e => { e.stopPropagation(); void run(); }} disabled={busy}
      style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, cursor: 'pointer',
               border: '1px solid #cbd5e0', background: '#fff', color: '#2b6cb0' }}
      title="Quote + book a return label (customer → warehouse) via Freightcom">
      {busy ? 'Booking…' : '🏷 Generate return label'}
    </button>
  );
}

// Unit status (where the physical unit is) — anyone can record it. Used in the
// pre-refund card modal; mirrors the dropdown on the card + the refund panel.
function UnitStatusEditor({ r, onError }: { r: ReturnRow; onError: (m: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const run = async (s: ReturnStatus) => {
    if (r.status === s) return;
    setBusy(true); onError(null);
    try { await updateReturnStatus(r.id, s); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div onClick={e => e.stopPropagation()} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', margin: '8px 0' }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#4a5568' }}>Unit status:</span>
      <select value={r.status} onChange={e => void run(e.target.value as ReturnStatus)} disabled={busy}
        style={{ fontSize: 12, fontWeight: 600, padding: '3px 8px', borderRadius: 6, border: '1px solid #cbd5e0', background: '#fff', color: '#2d3748', cursor: 'pointer' }}>
        {!UNIT_STAGES.some(st => st.value === r.status) && (
          <option value={r.status} disabled>📦 {UNIT_STATUS_LABEL[r.status]}</option>
        )}
        {UNIT_STAGES.map(st => <option key={st.value} value={st.value}>📦 {st.label}</option>)}
      </select>
    </div>
  );
}

// Disposition (ship back vs discard) — anyone can set/clear it. Used in the
// pre-refund card modal; mirrors the refund detail panel's instruction row.
function DispositionEditor({ r, onError }: { r: ReturnRow; onError: (m: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const run = async (d: ReturnDisposition | null) => {
    setBusy(true); onError(null);
    try { await setReturnDisposition(r.id, d); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div onClick={e => e.stopPropagation()} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', margin: '8px 0' }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#4a5568' }}>Instruction:</span>
      {(['ship_back', 'discard'] as ReturnDisposition[]).map(d => {
        const on = r.disposition === d;
        const dm = RETURN_DISPOSITION_META[d];
        return (
          <button key={d} disabled={busy} onClick={() => void run(on ? null : d)}
            style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
                     border: `1px solid ${on ? dm.color : '#e2e8f0'}`, color: on ? dm.color : '#718096', background: on ? dm.bg : '#fff' }}>
            {on ? '✓ ' : ''}{dm.label}
          </button>
        );
      })}
      {!r.disposition && <span style={{ fontSize: 11, color: '#975a16' }}>⚠ not set</span>}
      <ReturnLabelControl r={r} onError={onError} />
    </div>
  );
}

// Notes on a pre-refund return card (Return Form Submitted / Return &
// Inspection). Everyone involved can add — mirrors the refund-card notes.
function ReturnNotes({ returnId, onError }: { returnId: string; onError: (m: string | null) => void }) {
  const { notes, refresh } = useReturnNotes(returnId);
  const { user } = useAuth();
  const uid = user?.id;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const add = async () => {
    if (!text.trim()) return;
    setBusy(true); onError(null);
    try { await addReturnNote(returnId, text); setText(''); refresh(); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };
  const del = async (id: string) => {
    setBusy(true); onError(null);
    try { await deleteReturnNote(id, returnId); refresh(); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };
  const saveEdit = async (id: string) => {
    if (!editText.trim()) return;
    setBusy(true); onError(null);
    try { await updateReturnNote(id, returnId, editText); setEditId(null); refresh(); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div onClick={e => e.stopPropagation()} style={{ margin: '8px 0' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#4a5568', marginBottom: 4 }}>Notes ({notes.length})</div>
      {notes.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
          {notes.map(n => (
            <div key={n.id} style={{ fontSize: 12, background: '#f7fafc', border: '1px solid #edf2f7', borderRadius: 6, padding: '4px 6px' }}>
              {editId === n.id ? (
                <>
                  <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={2} autoFocus
                    onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void saveEdit(n.id); if (e.key === 'Escape') setEditId(null); }}
                    style={{ width: '100%', fontSize: 12, padding: '4px 6px', border: '1px solid #2b6cb0', borderRadius: 6, resize: 'vertical' }} />
                  <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                    <button onClick={() => void saveEdit(n.id)} disabled={busy || !editText.trim()} className={styles.refundApproveBtn} style={{ fontSize: 10 }}>Save</button>
                    <button onClick={() => setEditId(null)} disabled={busy} style={{ border: 'none', background: 'none', color: '#a0aec0', cursor: 'pointer', fontSize: 10 }}>Cancel</button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: '#a0aec0', fontSize: 10, marginTop: 2 }}>
                    <span>{n.author_name ?? 'Unknown'} · {new Date(n.created_at).toLocaleString('en-US')}</span>
                    <span style={{ display: 'flex', gap: 8 }}>
                      {n.author_id === uid && (
                        <button onClick={() => { setEditId(n.id); setEditText(n.body); }} disabled={busy}
                          style={{ border: 'none', background: 'none', color: '#2b6cb0', cursor: 'pointer', fontSize: 10 }}>edit</button>
                      )}
                      <button onClick={() => void del(n.id)} disabled={busy}
                        style={{ border: 'none', background: 'none', color: '#a0aec0', cursor: 'pointer', fontSize: 10 }}>remove</button>
                    </span>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 4 }}>
        <textarea value={text} onChange={e => setText(e.target.value)} placeholder="Add a note…" rows={1}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void add(); }}
          style={{ flex: 1, fontSize: 12, padding: '4px 6px', border: '1px solid #cbd5e0', borderRadius: 6, resize: 'vertical', minHeight: 28 }} />
        <button onClick={() => void add()} disabled={busy || !text.trim()} className={styles.refundApproveBtn} style={{ fontSize: 11 }}>
          {busy ? '…' : 'Add'}
        </button>
      </div>
    </div>
  );
}

function ReturnAttachmentStrip({ returnId, onError }: { returnId: string; onError: (m: string | null) => void }) {
  const { attachments, refresh } = useReturnAttachments(returnId);
  const [busy, setBusy] = useState(false);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true); onError(null);
    try {
      for (const f of files) await uploadReturnAttachment(returnId, toNamedFile(f));
      refresh();
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const imgs = imageFilesFrom(e.clipboardData);
      if (imgs.length) { e.preventDefault(); void handleFiles(imgs); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returnId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const a of attachments) {
        try { next[a.id] = await returnAttachmentSignedUrl(a.file_path); } catch { /* skip */ }
      }
      if (!cancelled) setUrls(next);
    })();
    return () => { cancelled = true; };
  }, [attachments]);

  const del = async (a: ReturnAttachment) => {
    setBusy(true); onError(null);
    try { await deleteReturnAttachment(a); refresh(); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div onClick={e => e.stopPropagation()} style={{ margin: '8px 0' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#4a5568', marginBottom: 4 }}>
        Photos &amp; documents ({attachments.length})
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {attachments.map(a => {
          const isImg = (a.mime_type ?? '').startsWith('image/');
          return (
            <div key={a.id} style={{ position: 'relative', width: 64, height: 64, borderRadius: 6, overflow: 'hidden', border: '1px solid #e2e8f0', background: '#f7fafc' }}>
              {isImg && urls[a.id] ? (
                <img src={urls[a.id]} alt={a.file_name}
                     style={{ width: '100%', height: '100%', objectFit: 'cover', cursor: 'pointer' }}
                     onClick={() => urls[a.id] && window.open(urls[a.id], '_blank', 'noopener')} />
              ) : (
                <a href={urls[a.id]} target="_blank" rel="noopener noreferrer"
                   style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', fontSize: 10, padding: 4, textAlign: 'center', color: '#4a5568' }}>
                  {a.file_name.slice(0, 18)}
                </a>
              )}
              <button onClick={() => void del(a)} disabled={busy} title="Remove"
                style={{ position: 'absolute', top: 0, right: 0, background: 'rgba(0,0,0,0.6)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 11, lineHeight: 1, padding: '2px 5px' }}>✕</button>
            </div>
          );
        })}
        <button onClick={() => inputRef.current?.click()} disabled={busy}
          style={{ width: 64, height: 64, borderRadius: 6, border: '1px dashed #cbd5e0', background: '#fff', cursor: 'pointer', fontSize: 11, color: '#718096' }}>
          {busy ? '…' : '+ Add'}
        </button>
      </div>
      <input ref={inputRef} type="file" multiple accept={RETURN_ATTACH_INPUT_ACCEPT} style={{ display: 'none' }}
        onChange={e => { void handleFiles(Array.from(e.target.files ?? [])); e.currentTarget.value = ''; }} />
      <div style={{ fontSize: 10, color: '#a0aec0', marginTop: 2 }}>Paste (⌘/Ctrl+V) an image while this case is open, or click + to upload.</div>
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
// A card in the "Return & inspection" column. Mirrors RefundCard's information
// (usage window, invoices, ticket history, unit-status control) for a return
// that doesn't yet have a refund request — so the inspection stage carries all
// the same context as the downstream refund stages.
function InspectionCard({
  r, parties, canOwn, usage, invoices, tickets, onOpenTicket, onView, onCompile, onError,
}: {
  r: ReturnRow;
  parties: Parties;
  canOwn: boolean;
  usage: RefundUsageWindow;
  invoices: CustomerInvoice[];
  tickets: ServiceTicket[];
  onOpenTicket: (ticketId: string) => void;
  onView: () => void;
  onCompile: () => void;
  onError: (msg: string | null) => void;
}) {
  const [statusBusy, setStatusBusy] = useState(false);
  const runStatus = async (s: ReturnStatus) => {
    if (r.status === s) return;
    setStatusBusy(true); onError(null);
    try { await updateReturnStatus(r.id, s); }
    catch (e) { onError((e as Error).message); }
    finally { setStatusBusy(false); }
  };
  return (
    <div
      className={styles.refundCard}
      style={{ borderLeftColor: '#805ad5', cursor: 'pointer' }}
      role="button"
      tabIndex={0}
      onClick={onView}
      title="Click to view the full return form"
    >
      <div className={styles.refundCardHead}>
        <PartyHeader parties={parties} />
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
      {r.refund_method_preference && <div className={styles.refundMeta}>via {r.refund_method_preference}</div>}
      <CustomerWaitBadge r={r} />
      <UsageWindowBadge usage={usage} />
      <RefundInvoices invoices={invoices} fallbackOrderRef={r.original_order_ref} />
      <CustomerTicketHistory tickets={tickets} onOpenTicket={onOpenTicket} defaultOpen />
      <ReturnNotes returnId={r.id} onError={onError} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '6px 0', alignItems: 'center' }}
           onClick={e => e.stopPropagation()}>
        <select
          value={r.status}
          onChange={e => void runStatus(e.target.value as ReturnStatus)}
          disabled={statusBusy}
          style={{ fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 4,
                   border: '1px solid #cbd5e0', background: '#edf2f7', color: '#2d3748',
                   cursor: 'pointer', maxWidth: 160 }}
        >
          {!UNIT_STAGES.some(st => st.value === r.status) && (
            <option value={r.status} disabled>📦 {UNIT_STATUS_LABEL[r.status]}</option>
          )}
          {UNIT_STAGES.map(st => (
            <option key={st.value} value={st.value}>📦 {st.label}</option>
          ))}
        </select>
        {r.disposition ? (
          <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
                         color: RETURN_DISPOSITION_META[r.disposition].color,
                         background: RETURN_DISPOSITION_META[r.disposition].bg }}>
            {RETURN_DISPOSITION_META[r.disposition].label}
          </span>
        ) : (
          <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
                         color: '#975a16', background: '#fffbeb' }}>
            ⚠ Disposition not set
          </span>
        )}
        <ReturnLabelControl r={r} onError={onError} />
      </div>
      <div className={styles.refundActions} onClick={e => e.stopPropagation()}>
        {preRefundStage(r.status) === 'intake' ? (
          canOwn ? (
            <>
              <button className={styles.refundApproveBtn} disabled={statusBusy}
                onClick={() => void runStatus('received')}
                title="Unit is back — move this case to the Return & Inspection column">
                Move to Return &amp; Inspection →
              </button>
              {r.disposition === 'discard' && (
                <button className={styles.refundApproveBtn} onClick={onCompile}
                  title="Customer is discarding the unit (no return) — compile straight to Completeness, skipping Return & Inspection">
                  Discard → Completeness
                </button>
              )}
            </>
          ) : (
            <span className={styles.refundCardHint}>Reina moves these forward</span>
          )
        ) : (
          <>
            {/* back-move stays open to everyone */}
            <button className={styles.refundCloseBtn} disabled={statusBusy}
              onClick={() => void runStatus('created')}
              title="Move this case back to the Return Form Submitted column">
              ← Return Form Submitted
            </button>
            {canOwn && (
              <button className={styles.refundApproveBtn} onClick={onCompile}
                title="Compile the case into a refund request (moves it to the Completeness column)">
                Compile → Completeness
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RefundCard({
  refund, linkedReturn, parties, canApproveHere, usage, invoices, tickets, onOpenTicket, canFlow, selected, onSelect, onError, onOpenFinanceModal,
}: {
  refund: RefundApproval;
  linkedReturn: ReturnRow | null;
  parties: Parties;
  canApproveHere: boolean;
  usage: RefundUsageWindow;
  invoices: CustomerInvoice[];
  tickets: ServiceTicket[];
  onOpenTicket: (ticketId: string) => void;
  canFlow: boolean;
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
        const stage = (['submitted', 'manager_review', 'finance_review', 'refund_queue'].includes(refund.status)
          ? refund.status : 'manager_review') as 'submitted' | 'manager_review' | 'finance_review' | 'refund_queue';
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

  // Only the OWNER of a card's column may approve/move it forward
  // (canApproveHere). Denial + back-moves stay open to everyone (canFlow).
  const canActSubmit = refund.status === 'submitted' && canApproveHere;
  const canActManager = refund.status === 'manager_review' && canApproveHere;
  const canActFinance = refund.status === 'finance_review' && canApproveHere;
  const canActExecute = refund.status === 'refund_queue' && canApproveHere;
  const canDeny = canFlow && ['submitted', 'manager_review', 'finance_review', 'refund_queue'].includes(refund.status);

  // FR-11: flag a case whose purchaser linkage is unverified; the manager can
  // override (BR-15) before approving.
  const linkageOk = hasValidPurchaserLinkage(linkedReturn);
  const needsLinkage = canActManager && !linkageOk;

  // Send a card BACK a column (not enough info, etc.). From Completeness this
  // "uncompiles" the case back to Return & Inspection.
  const backTarget: RefundBackTarget | 'uncompile' | null =
    refund.status === 'manager_review' ? 'submitted' :
    refund.status === 'finance_review' ? 'manager_review' :
    refund.status === 'refund_queue'   ? 'finance_review' :
    refund.status === 'submitted'      ? 'uncompile' : null;
  const backLabel =
    refund.status === 'manager_review' ? '← Completeness' :
    refund.status === 'finance_review' ? '← Manager review' :
    refund.status === 'refund_queue'   ? '← Finance review' :
    refund.status === 'submitted'      ? '← Return & Inspection' : '';
  const runBack = async () => {
    if (!backTarget) return;
    if (backTarget === 'uncompile' &&
        !window.confirm('Move this case back to Return & Inspection? This removes the refund request. Any notes on it are kept on the return.')) return;
    setBusy(true); onError(null);
    try {
      if (backTarget === 'uncompile') await uncompileRefund(refund.id, refund.return_id);
      else await sendRefundBack(refund.id, backTarget);
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  const runSubmitToManager = async () => {
    setBusy(true); onError(null);
    try { await submitToManager(refund.id); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  const runConfirmLinkage = async () => {
    if (!linkedReturn) return;
    setBusy(true); onError(null);
    try { await confirmPurchaserLinkage(linkedReturn.id); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div
      className={`${styles.refundCard} ${selected ? styles.refundCardSelected : ''}`}
      style={{ borderLeftColor: meta.color }}
      onClick={onSelect}
      role="button"
      tabIndex={0}
    >
      <div className={styles.refundCardHead}>
        <PartyHeader parties={parties} />
        <AmountEditor refund={refund} editable={canFlow} onError={onError} />
      </div>
      {refund.reason && <div className={styles.refundReason}>{refund.reason}</div>}
      {/* The refund method is set by Finance (Julie) at Finance Review and shown
          to Pedrum in the Refund Queue. Falls back to the legacy payment_method. */}
      {refund.refund_method ? (
        <div className={styles.refundMeta} style={{ fontWeight: 700, color: '#2d3748' }}>
          Refund via {REFUND_METHOD_META[refund.refund_method].label}
        </div>
      ) : refund.payment_method ? (
        <div className={styles.refundMeta}>via {refund.payment_method}</div>
      ) : null}
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
            {canFlow && backTarget && (
              <button onClick={() => void runBack()} disabled={busy} className={styles.refundCloseBtn}
                title="Send this card back a column (e.g. not enough information)">
                {busy ? '…' : backLabel}
              </button>
            )}
            {canActSubmit && (
              <button onClick={() => void runSubmitToManager()} disabled={busy} className={styles.refundApproveBtn}>
                {busy ? '…' : 'Submit to manager →'}
              </button>
            )}
            {needsLinkage && (
              <button onClick={() => void runConfirmLinkage()} disabled={busy} className={styles.refundDenyBtn}
                title="Filer isn't the buyer and no purchaser receipt is on file — confirm linkage to override (BR-15).">
                {busy ? '…' : '⚠ Confirm purchaser linkage'}
              </button>
            )}
            {(canActManager || canActFinance) && (
              <button onClick={openApprove} disabled={busy || needsLinkage} className={styles.refundApproveBtn}
                title={needsLinkage ? 'Confirm purchaser linkage before approving' : undefined}>
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
  refund, linkedReturn, parties, canApproveHere, usage, invoices, tickets, onOpenTicket, queuedReplacements, canFlow, onClose, onError, onOpenFinanceModal,
}: {
  refund: RefundApproval;
  linkedReturn: ReturnRow | null;
  parties: Parties;
  canApproveHere: boolean;
  usage: RefundUsageWindow;
  invoices: CustomerInvoice[];
  tickets: ServiceTicket[];
  onOpenTicket: (ticketId: string) => void;
  queuedReplacements: Order[];
  canFlow: boolean;
  onClose: () => void;
  onError: (msg: string | null) => void;
  onOpenFinanceModal: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [holdBusy, setHoldBusy] = useState<string | null>(null);
  const { notes, refresh: refreshNotes } = useRefundNotes(refund.id);
  const { user: authUser } = useAuth();
  const uid = authUser?.id;
  const [newNote, setNewNote] = useState('');
  const [editNoteId, setEditNoteId] = useState<string | null>(null);
  const [editNoteText, setEditNoteText] = useState('');
  const meta = REFUND_STATUS_META[refund.status];

  // Forward/approve is owner-only (canApproveHere); deny is open to everyone.
  const canActSubmit = refund.status === 'submitted' && canApproveHere;
  const canActManager = refund.status === 'manager_review' && canApproveHere;
  const canActFinance = refund.status === 'finance_review' && canApproveHere;
  const canActExecute = refund.status === 'refund_queue' && canApproveHere;
  const canAct = canActManager || canActFinance;
  const canDeny = canFlow && ['submitted', 'manager_review', 'finance_review', 'refund_queue'].includes(refund.status);

  // Send a card back a column (mirrors RefundCard).
  const backTarget: RefundBackTarget | 'uncompile' | null =
    refund.status === 'manager_review' ? 'submitted' :
    refund.status === 'finance_review' ? 'manager_review' :
    refund.status === 'refund_queue'   ? 'finance_review' :
    refund.status === 'submitted'      ? 'uncompile' : null;
  const backLabel =
    refund.status === 'manager_review' ? '← Completeness' :
    refund.status === 'finance_review' ? '← Manager review' :
    refund.status === 'refund_queue'   ? '← Finance review' :
    refund.status === 'submitted'      ? '← Return & Inspection' : '';
  const runBack = async () => {
    if (!backTarget) return;
    if (backTarget === 'uncompile' &&
        !window.confirm('Move this case back to Return & Inspection? This removes the refund request. Any notes on it are kept on the return.')) return;
    setBusy(true); onError(null);
    try {
      if (backTarget === 'uncompile') { await uncompileRefund(refund.id, refund.return_id); onClose(); }
      else await sendRefundBack(refund.id, backTarget);
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  // FR-11: block manager approval until purchaser linkage is verified or the
  // manager overrides it (BR-15).
  const linkageOk = hasValidPurchaserLinkage(linkedReturn);
  const needsLinkage = canActManager && !linkageOk;

  const runConfirmLinkage = async () => {
    if (!linkedReturn) return;
    setBusy(true); onError(null);
    try { await confirmPurchaserLinkage(linkedReturn.id); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  const runExecute = async () => {
    setBusy(true); onError(null);
    try { await executeRefund(refund.id); onClose(); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  const runSubmitToManager = async () => {
    setBusy(true); onError(null);
    try { await submitToManager(refund.id); onClose(); }
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
  const runEditNote = async (noteId: string) => {
    if (!editNoteText.trim()) return;
    setBusy(true); onError(null);
    try { await updateRefundNote(noteId, refund.id, editNoteText); setEditNoteId(null); refreshNotes(); }
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
        const stage = (['submitted', 'manager_review', 'finance_review', 'refund_queue'].includes(refund.status)
          ? refund.status : 'manager_review') as 'submitted' | 'manager_review' | 'finance_review' | 'refund_queue';
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
            <h3 className={styles.refundDetailTitle} style={{ display: 'inline' }}>
              <PartyHeader parties={parties} nameNode={(name) => <span>{name}</span>} />
            </h3>
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
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#4a5568' }}>Refund amount:</span>
            <AmountEditor refund={refund} editable={canFlow} onError={onError} big />
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
          <ReturnLabelControl r={linkedReturn} onError={onError} />
        </div>
        <ReturnFormAnswers r={linkedReturn} />
        <ReturnAttachmentStrip returnId={linkedReturn.id} onError={onError} />
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
              {editNoteId === n.id ? (
                <>
                  <textarea value={editNoteText} onChange={e => setEditNoteText(e.target.value)} rows={2} autoFocus
                    onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void runEditNote(n.id); if (e.key === 'Escape') setEditNoteId(null); }}
                    style={{ width: '100%', fontSize: 13, padding: '6px 9px', border: '1px solid #2b6cb0', borderRadius: 6, resize: 'vertical' }} />
                  <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                    <button onClick={() => void runEditNote(n.id)} disabled={busy || !editNoteText.trim()}
                      style={{ fontSize: 11, fontWeight: 600, padding: '2px 10px', borderRadius: 6, border: '1px solid #2b6cb0', color: '#fff', background: '#2b6cb0', cursor: 'pointer' }}>Save</button>
                    <button onClick={() => setEditNoteId(null)} disabled={busy}
                      style={{ border: 'none', background: 'none', color: '#a0aec0', cursor: 'pointer', fontSize: 11 }}>Cancel</button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
                  <div style={{ fontSize: 10, color: '#a0aec0', marginTop: 3, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span>{n.author_name ?? 'Unknown'} · {new Date(n.created_at).toLocaleString()}</span>
                    <span style={{ display: 'flex', gap: 10 }}>
                      {n.author_id === uid && (
                        <button onClick={() => { setEditNoteId(n.id); setEditNoteText(n.body); }} disabled={busy} title="Edit your note"
                          style={{ border: 'none', background: 'none', color: '#2b6cb0', cursor: 'pointer', fontSize: 11 }}>edit</button>
                      )}
                      <button onClick={() => void runDeleteNote(n.id)} disabled={busy} title="Delete note"
                        style={{ border: 'none', background: 'none', color: '#cbd5e0', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>×</button>
                    </span>
                  </div>
                </>
              )}
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
          {needsLinkage ? '⚠ Purchaser linkage unverified — confirm linkage (BR-15 override) before approving' :
           canActSubmit ? 'Completeness check — submit to the Manager when ready' :
           canActManager ? 'You can act as Manager for this case' :
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
            {canFlow && backTarget && (
              <button onClick={() => void runBack()} disabled={busy} className={styles.refundCloseBtn}
                title="Send this card back a column (e.g. not enough information)">
                {busy ? '…' : backLabel}
              </button>
            )}
            {canActSubmit && (
              <button onClick={() => void runSubmitToManager()} disabled={busy} className={styles.refundDetailApproveBtn}>
                {busy ? '…' : 'Submit to manager →'}
              </button>
            )}
            {needsLinkage && (
              <button onClick={() => void runConfirmLinkage()} disabled={busy} className={styles.refundDetailDenyBtn}
                title="Filer isn't the buyer and no purchaser receipt is on file — confirm linkage to override (BR-15).">
                {busy ? '…' : '⚠ Confirm purchaser linkage'}
              </button>
            )}
            {canAct && (
              <button onClick={openApprove} disabled={busy || needsLinkage} className={styles.refundDetailApproveBtn}
                title={needsLinkage ? 'Confirm purchaser linkage before approving' : undefined}>
                {canActManager ? '✓ Approve as Manager' : '✓ Approve amount → Refund Queue'}
              </button>
            )}
            {canActExecute && (
              <button onClick={() => void runExecute()} disabled={busy} className={styles.refundDetailApproveBtn}>
                {busy ? '…' : '✓ Mark refunded (executed)'}
              </button>
            )}
            {canDeny && (
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
function ReturnDetailModal({ r, parties, usage, invoices, tickets, onOpenTicket, onError, onClose }: {
  r: ReturnRow;
  parties: Parties;
  usage: RefundUsageWindow;
  invoices: CustomerInvoice[];
  tickets: ServiceTicket[];
  onOpenTicket: (ticketId: string) => void;
  onError: (msg: string | null) => void;
  onClose: () => void;
}) {
  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={e => e.stopPropagation()} style={{ maxWidth: 720, maxHeight: '85vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <h3 className={styles.modalTitle} style={{ marginBottom: 2, display: 'inline' }}>
              <PartyHeader parties={parties} nameNode={(name) => <span>{name}</span>} />
            </h3>
            <div style={{ fontSize: 12, color: '#718096' }}>
              Return form · {r.return_ref ?? r.original_order_ref ?? '—'}
            </div>
            <div style={{ fontSize: 12, color: '#718096' }}>
              {[r.customer_email, r.customer_phone].filter(Boolean).join(' · ') || '—'}
            </div>
          </div>
          <button className={styles.btnSecondary} onClick={onClose}>Close</button>
        </div>
        {/* Full case context — same blocks the refund detail panel shows:
            usage window, sales invoice + order #, ticket history, saved notes,
            then the return form answers. */}
        <div style={{ marginTop: 12 }}>
          <UnitStatusEditor r={r} onError={onError} />
          <DispositionEditor r={r} onError={onError} />
          <UsageWindowBadge usage={usage} />
          <RefundInvoices invoices={invoices} fallbackOrderRef={r.original_order_ref} />
          <CustomerTicketHistory tickets={tickets} onOpenTicket={onOpenTicket} defaultOpen />
          <ReturnNotes returnId={r.id} onError={onError} />
          <ReturnAttachmentStrip returnId={r.id} onError={onError} />
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
    if (!customerName.trim()) return;
    setSubmitting(true); onError(null);
    try {
      // Amount + payment method are set by Finance (Julie) at Finance Review, not here.
      await submitRefundRequest({
        return_id: returnId || undefined,
        customer_name: customerName.trim(),
        customer_email: customerEmail.trim() || undefined,
        refund_amount_usd: 0,
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
          </div>
          <div style={{ fontSize: 12, color: '#718096', margin: '2px 0 6px' }}>
            The refund amount and payment method are set by Finance (Julie) at Finance Review.
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
          <button onClick={() => void submit()} disabled={submitting || !customerName.trim()}
                  className={styles.modalPrimary}>
            {submitting ? 'Creating…' : 'Create refund request'}
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
  const { user: authUser } = useAuth();
  const uid = authUser?.id;
  const [newNote, setNewNote] = useState('');
  const [noteBusy, setNoteBusy] = useState(false);
  const [editNoteId, setEditNoteId] = useState<string | null>(null);
  const [editNoteText, setEditNoteText] = useState('');
  const runAddNote = async () => {
    if (!newNote.trim()) return;
    setNoteBusy(true); setLocalError(null); onError(null);
    try { await addRefundNote(refund.id, newNote); setNewNote(''); refreshNotes(); }
    catch (e) { const m = (e as Error).message; setLocalError(m); onError(m); }
    finally { setNoteBusy(false); }
  };
  const runEditNote = async (noteId: string) => {
    if (!editNoteText.trim()) return;
    setNoteBusy(true); setLocalError(null);
    try { await updateRefundNote(noteId, refund.id, editNoteText); setEditNoteId(null); refreshNotes(); }
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

  // FR-12: fee breakdown. Restocking defaults to $50 (waived for genuine-defect
  // discards, BR-7); return shipping is operator-entered actual cost (OQ-2).
  const feeDefaults = defaultRefundFees(isDefectiveDiscard);
  const [restockingStr, setRestockingStr] = useState(feeDefaults.restocking.toFixed(2));
  const [returnShipStr, setReturnShipStr] = useState(feeDefaults.returnShipping.toFixed(2));
  const restockingFee = Number(restockingStr) || 0;
  const returnShipFee = Number(returnShipStr) || 0;
  const suggestedNet = computeRefundNet(original, restockingFee, returnShipFee);

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
        restocking_fee: restockingFee,
        return_shipping_fee: returnShipFee,
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

        <div className={styles.modalField}>
          <label className={styles.modalLabel}>Fees (FR-12)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <div className={styles.modalHint}>Restocking fee</div>
              <input type="number" step="0.01" min="0" value={restockingStr}
                onChange={e => setRestockingStr(e.target.value)} className={styles.modalInput} />
            </div>
            <div style={{ flex: 1 }}>
              <div className={styles.modalHint}>Return shipping (customer-paid)</div>
              <input type="number" step="0.01" min="0" value={returnShipStr}
                onChange={e => setReturnShipStr(e.target.value)} className={styles.modalInput} />
            </div>
          </div>
          <div className={styles.modalHint} style={{ marginTop: 6 }}>
            {isDefectiveDiscard
              ? '✓ Genuine defect — fees waived by default (BR-7).'
              : '$50 restocking default; return shipping is the actual cost (adjust for currency).'}
            {' '}Gross ${original.toFixed(2)} − restocking ${restockingFee.toFixed(2)} − shipping ${returnShipFee.toFixed(2)} = <strong>net ${suggestedNet.toFixed(2)}</strong>.
            {' '}<button type="button" onClick={() => setAmountStr(suggestedNet.toFixed(2))}
              style={{ border: 'none', background: 'none', color: '#2b6cb0', cursor: 'pointer', padding: 0, fontWeight: 600 }}>
              Apply net →
            </button>
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
                {editNoteId === n.id ? (
                  <>
                    <textarea value={editNoteText} onChange={e => setEditNoteText(e.target.value)} rows={2} autoFocus
                      onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void runEditNote(n.id); if (e.key === 'Escape') setEditNoteId(null); }}
                      className={styles.modalInput} style={{ resize: 'vertical' }} />
                    <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                      <button onClick={() => void runEditNote(n.id)} disabled={noteBusy || !editNoteText.trim()}
                        style={{ fontSize: 11, fontWeight: 600, padding: '2px 10px', borderRadius: 6, border: '1px solid #2b6cb0', color: '#fff', background: '#2b6cb0', cursor: 'pointer' }}>Save</button>
                      <button onClick={() => setEditNoteId(null)} disabled={noteBusy}
                        style={{ border: 'none', background: 'none', color: '#a0aec0', cursor: 'pointer', fontSize: 11 }}>Cancel</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
                    <div style={{ fontSize: 10, color: '#a0aec0', marginTop: 3, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span>{n.author_name ?? 'Unknown'} · {new Date(n.created_at).toLocaleString()}</span>
                      <span style={{ display: 'flex', gap: 10 }}>
                        {n.author_id === uid && (
                          <button onClick={() => { setEditNoteId(n.id); setEditNoteText(n.body); }} disabled={noteBusy} title="Edit your note"
                            style={{ border: 'none', background: 'none', color: '#2b6cb0', cursor: 'pointer', fontSize: 11 }}>edit</button>
                        )}
                        <button onClick={() => void runDeleteNote(n.id)} disabled={noteBusy} title="Delete note"
                          style={{ border: 'none', background: 'none', color: '#cbd5e0', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>×</button>
                      </span>
                    </div>
                  </>
                )}
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
