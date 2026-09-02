import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  useRefundApprovals, useReturns,
  submitRefundRequest, compileReturnToRefund, defaultRefundAmountFromInvoice,
  updateRefundAmount, setRefundCurrency, type RefundCurrency, submitToManager, managerApprove, financeApprove, executeRefund, denyRefund, closeRefund,
  sendRefundBack, uncompileRefund, type RefundBackTarget,
  confirmPurchaserLinkage, hasValidPurchaserLinkage,
  computeRefundNet, defaultRefundFees,
  preRefundStage, customerWaitState,
  useOrderCancellations, pendingCancellationRefunds, cancellationForRefund,
  compileCancellationToRefund, dismissCancellationRefund, type OrderCancellation,
  setReturnDisposition, updateReturnStatus,
  useCaseAttachments, uploadCaseAttachment, deleteCaseAttachment, returnAttachmentSignedUrl,
  RETURN_ATTACH_INPUT_ACCEPT, RETURN_ATTACH_CATEGORIES, RETURN_ATTACH_ALLOWED_MIME,
  RETURN_CATEGORIES, RETURN_CATEGORY_META, manualRefundReason,
  type ReturnAttachment, type ReturnAttachmentCategory,
  useCaseNotes, addCaseNote, updateCaseNote, deleteCaseNote, type CaseNote,
  REFUND_STATUS_META, REFUND_METHODS, REFUND_METHOD_META,
  resolveCaseUnit, confirmCaseUnitSerial, CASE_UNIT_VIA_LABEL,
  type CaseUnitResolution,
  UNIT_STATUS_LABEL, RETURN_DISPOSITION_META,
  type RefundApproval, type ReturnRow, type RefundMethod, type ReturnDisposition, type ReturnStatus, type ReturnCategory,
} from '../../lib/postShipment';
import { useUnits, STATUS_META, type UnitStatus } from '../../lib/stock';
import { Link } from 'react-router-dom';

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
import {
  useOnboardDates, useCustomerIdByEmail, useCustomers, refundUsageWindow,
  resolveRefundParties, resolvePurchaserId,
  buildContactIndex, lookupContactRow, resolveCustomerContact,
  type Customer, type CustomerContact, type RefundParties, type RefundUsageWindow,
} from '../../lib/customers';
import {
  useInvoicesByCustomerEmail, openInvoiceInNewTab, invoiceAmountCad, type CustomerInvoice,
} from '../../lib/invoices';
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
  cancellation:   ['reina@virgohome.io'],
  intake:         ['reina@virgohome.io'],
  inspection:     ['reina@virgohome.io'],
  submitted:      ['reina@virgohome.io'],
  manager_review: ['george@virgohome.io'],
  finance_review: ['yueli@virgohome.io', 'huayi@virgohome.io'],
  refund_queue:   ['pedrum@virgohome.io'],
};
export function ownsRefundColumn(email: string | null | undefined, column: string | null | undefined): boolean {
  const e = (email ?? '').toLowerCase().trim();
  return !!column && !!e && (REFUND_COLUMN_OWNERS[column] ?? []).includes(e);
}

// Names for the owner emails above — used in the "you can't write here" hints
// on a card sitting in someone else's column. An address nobody recognises
// ("yueli@…") reads as a bug; "Julie owns this column" reads as a rule.
const REFUND_OWNER_NAMES: Record<string, string> = {
  'reina@virgohome.io':  'Reina',
  'george@virgohome.io': 'George',
  'yueli@virgohome.io':  'Julie',
  'huayi@virgohome.io':  'Huayi',
  'pedrum@virgohome.io': 'Pedrum',
};
// Empty for the terminal columns (Refunded / Denied), which nobody owns — the
// case is finished there and its notes are the record of what happened.
export function refundColumnOwnerLabel(column: string | null | undefined): string {
  const owners = (column && REFUND_COLUMN_OWNERS[column]) || [];
  return owners.map(e => REFUND_OWNER_NAMES[e] ?? e.split('@')[0]).join(' / ');
}

export function RefundsTab() {
  const { approvals, loading: aLoading, refresh: refreshApprovals } = useRefundApprovals();
  const { returns, loading: rLoading } = useReturns();
  const { cancellations, loading: cLoading } = useOrderCancellations();
  const { replacements: queuedRepls } = useQueuedReplacements();
  const { byEmail: onboardByEmail } = useOnboardDates();
  const { byEmail: invoicesByEmail } = useInvoicesByCustomerEmail();
  const { byEmail: customerIdByEmail } = useCustomerIdByEmail();
  const { customers } = useCustomers();
  const { units } = useUnits();
  const { tickets: allTickets } = useServiceTickets();
  const { user, profile, role } = useAuth();
  // Gate on the profile email (loaded from the DB, stable) — the auth session's
  // user.email is often transiently undefined after a token refresh, which would
  // silently blank out every column owner's forward/approve button.
  const userEmail = profile?.email ?? user?.email;

  const [showRequestModal, setShowRequestModal] = useState(false);
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

  // A cancellation form is a refund request the moment the customer submits it,
  // exactly like a return form — so it queues here immediately instead of
  // waiting for someone to open the Cancellations tab and process it.
  const pendingCancellations = useMemo(
    () => pendingCancellationRefunds(cancellations),
    [cancellations],
  );

  // A refund compiled from a cancellation keeps reading that cancellation's
  // notes, so the thread written on the intake card doesn't disappear the
  // moment the case moves to Completeness.
  const cancellationIdFor = (refundId: string): string | null =>
    cancellationForRefund(cancellations, refundId)?.id ?? null;

  // Contact block for a card on this board. A refund row only ever carries an
  // email, a return form adds a phone, a cancellation form carries both — and
  // none of the three carries an address, so the customer directory (Customers
  // → Directory) is what supplies the rest. Case data wins where it exists;
  // anything neither side has is reported as not on file rather than left
  // blank. Every intake column goes through here, not just the refund columns:
  // a cancellation request is a refund case an operator has to work, and having
  // to leave for the directory to phone that customer is the bug this fixes.
  const contactIndex = useMemo(() => buildContactIndex(customers), [customers]);
  const contactForCase = (c: {
    email?: string | null; phone?: string | null; name?: string | null;
  }): CustomerContact => resolveCustomerContact({
    caseEmail: c.email,
    casePhone: c.phone,
    directory: lookupContactRow(contactIndex, { email: c.email, name: c.name }),
  });

  // The machine a case is about. Once a unit is back it leaves `shipped`, so
  // nothing keyed on "currently held" finds it — and most cases on this board
  // never captured a serial to begin with. resolveCaseUnit reaches through the
  // order ref, the name on the unit and the customer record, and reports which
  // of those answered so the operator can judge the guess. The directory row is
  // resolved here, the same way the contact block resolves it.
  const caseUnitFor = (c: {
    serial?: string | null; orderRef?: string | null;
    email?: string | null; name?: string | null;
  }): CaseUnitResolution => resolveCaseUnit({
    caseSerial: c.serial,
    orderRef: c.orderRef,
    customerName: c.name,
    customerId: lookupContactRow(contactIndex, { email: c.email, name: c.name })?.id ?? null,
    units,
  });

  const contactFor = (refund: RefundApproval, linkedReturn: ReturnRow | null): CustomerContact => {
    const email = refund.customer_email ?? linkedReturn?.customer_email ?? null;
    const cancellation = cancellationForRefund(cancellations, refund.id);
    return contactForCase({
      email: email ?? cancellation?.customer_email,
      phone: linkedReturn?.customer_phone ?? cancellation?.customer_phone,
      // Name is only the fallback key, so it has to be the name the directory
      // would file this person under — the one on the card.
      name: refund.customer_name,
    });
  };

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
  }, [approvals, preRefundReturns, pendingCancellations]);
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
    try { await compileReturnToRefund(r); await refreshApprovals(); }
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
        ) : rows.map(r => (
          <InspectionCard
            key={r.id}
            r={r}
            parties={partiesForReturn(r)}
            onView={() => setViewReturnId(r.id)}
          />
        ))}
      </div>
    </div>
  );

  // Cancellation cards carry the same context as a return card (parties, usage
  // window, invoices, ticket history) — only the source record differs.
  const renderCancellationColumn = () => (
    <div className={styles.kanbanCol}>
      <div className={styles.kanbanColHead}>
        <span className={styles.kanbanColLabel}>Cancellation Requests</span>
        <span className={styles.kanbanColCount}>{pendingCancellations.length}</span>
      </div>
      <div className={styles.kanbanColSub}>Reina — new cancellation forms · queue the refund</div>
      <div className={styles.kanbanList}>
        {pendingCancellations.length === 0 ? (
          <div className={styles.kanbanEmpty}>—</div>
        ) : pendingCancellations.map(c => (
          <CancellationCard
            key={c.id}
            c={c}
            canOwn={ownsRefundColumn(userEmail, 'cancellation')}
            parties={partiesFor({ filerEmail: c.customer_email, filerName: c.customer_name })}
            contact={contactForCase({
              email: c.customer_email, phone: c.customer_phone, name: c.customer_name,
            })}
            usage={usageForEmail(c.customer_email)}
            invoices={invoicesForEmail(c.customer_email)}
            tickets={ticketsForEmails([c.customer_email])}
            onOpenTicket={setOpenTicketId}
            onError={setError}
          />
        ))}
      </div>
    </div>
  );

  if (aLoading || rLoading || cLoading) return <div className={styles.loading}>Loading refunds…</div>;

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
          + Create Manual Refund
        </button>
        {error && <span className={styles.refundsError}>{error}</span>}
      </div>

      <div ref={topScrollRef} className={styles.kanbanScrollTop} onScroll={syncFromTop}>
        <div style={{ width: scrollW }} />
      </div>
      <div ref={kanbanRef} className={styles.kanban} onScroll={syncFromKanban}>
        {/* Customer cancellation forms land here the moment they're submitted —
            the cancellation-side twin of "Return Form Submitted". */}
        {renderCancellationColumn()}
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
                ) : rows.map(r => {
                  const linked = r.return_id ? returnsById.get(r.return_id) ?? null : null;
                  return (
                    <RefundCard
                      key={r.id}
                      refund={r}
                      linkedReturn={linked}
                      // A refund born from a cancellation form has no return
                      // behind it — fall back to the cancellation's order ref
                      // so the card still names the order it's against.
                      orderRef={linked?.original_order_ref ?? cancellationForRefund(cancellations, r.id)?.order_ref ?? null}
                      parties={partiesForRefund(r, linked)}
                      selected={selectedId === r.id}
                      onSelect={() => setSelectedId(prev => prev === r.id ? null : r.id)}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {selectedRefund && (
        <RefundDetailPanel
          refund={selectedRefund}
          linkedReturn={selectedReturn}
          cancellation={cancellationForRefund(cancellations, selectedRefund.id)}
          parties={partiesForRefund(selectedRefund, selectedReturn)}
          contact={contactFor(selectedRefund, selectedReturn)}
          caseUnit={caseUnitFor({
            serial: selectedReturn?.unit_serial,
            orderRef: selectedReturn?.original_order_ref,
            email: selectedRefund.customer_email ?? selectedReturn?.customer_email,
            name: selectedRefund.customer_name,
          })}
          returnId={selectedReturn?.id ?? null}
          canApproveHere={ownsRefundColumn(userEmail, selectedRefund.status)}
          usage={usageFor(selectedRefund, selectedReturn)}
          invoices={invoicesFor(selectedRefund, selectedReturn)}
          tickets={ticketsFor(selectedRefund, selectedReturn)}
          onOpenTicket={setOpenTicketId}
          queuedReplacements={replsByEmail.get((selectedRefund.customer_email ?? '').toLowerCase().trim()) ?? []}
          canFlow={canFlow}
          onClose={() => setSelectedId(null)}
          onError={setError}
          onMoved={refreshApprovals}
          onOpenFinanceModal={setFinanceModalId}
        />
      )}

      {showRequestModal && (
        <CreateManualRefundModal
          onClose={() => setShowRequestModal(false)}
          onError={setError}
          onMoved={refreshApprovals}
        />
      )}

      {viewReturnId && (() => {
        const r = returnsById.get(viewReturnId);
        if (!r) return null;
        const email = r.purchaser_email?.trim() || r.customer_email;
        return <ReturnDetailModal
          r={r}
          parties={partiesForReturn(r)}
          contact={contactForCase({
            email: r.customer_email, phone: r.customer_phone, name: r.customer_name,
          })}
          caseUnit={caseUnitFor({
            serial: r.unit_serial, orderRef: r.original_order_ref,
            email: r.customer_email, name: r.customer_name,
          })}
          canOwn={ownsRefundColumn(userEmail, preRefundStage(r.status))}
          usage={usageForEmail(email)}
          invoices={invoicesForEmail(email)}
          tickets={ticketsForEmails([r.purchaser_email, r.customer_email])}
          onOpenTicket={setOpenTicketId}
          onCompile={() => { void compileReturn(r); setViewReturnId(null); }}
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
            cancellationId={cancellationIdFor(refund.id)}
            canWrite={ownsRefundColumn(userEmail, refund.status)}
            onClose={() => setFinanceModalId(null)}
            onError={setError}
            onMoved={refreshApprovals}
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
//
// NOTE (2026-08-04): the automatic 7-day customer nudge was switched off — the
// send-return-followups cron is inactive. The day counter is computed here from
// created_at, so the badge still ages correctly; it now means "nobody has
// chased this customer", not "a reminder went out".
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
         title="Awaiting a customer response past the 7-day mark (BR-16). Auto-reminders are OFF — chase this one by hand if it needs it.">
      ⏳ Awaiting customer · {dayLabel} — needs a nudge
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
//
// `editable` is unconditionally true at both call sites: the amount is the one
// field on a refund card that is NOT column-gated. Julie confirms the real
// figure and she doesn't own every column it passes through, and anyone may
// correct an obviously wrong amount or flip the currency label. Advancing the
// refund through its approvals stays gated (canFlow / canApproveHere).
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

// FR-13 — read-only return-shipping tracking. The "Generate return label"
// action (one-click Freightcom booking via the `book-return-label` edge fn) was
// pulled 2026-08-04: it 400'd on every card because the edge fn reads a column
// (`orders.address_postal_code`) that doesn't exist, and even on success it only
// popped the PDF in a tab — nothing reached the customer. Feature is parked in
// docs/feature-backlog-alpha-feedback.md; `bookReturnLabel()` and the edge fn
// stay in the tree, unwired, for whoever picks it back up. This badge still
// surfaces pickup tracking recorded by any other means.
function ReturnTrackingBadge({ r }: { r: ReturnRow }) {
  if (r.disposition === 'discard') return null; // discard = no return shipment
  if (!r.pickup_tracking) return null;
  return (
    <span onClick={e => e.stopPropagation()}
      style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, color: '#276749', background: '#f0fff4' }}
      title={`Return shipment${r.pickup_carrier ? ` · ${r.pickup_carrier}` : ''}`}>
      🏷 {r.pickup_carrier ? `${r.pickup_carrier} · ` : ''}{r.pickup_tracking}
    </span>
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
      <ReturnTrackingBadge r={r} />
    </div>
  );
}

// ============================================================================
// Case notes — the single notes surface on this board
// ============================================================================
// Notes for a case. Pass a returnId (return-only cards), a cancellationId
// and/or a refundId (refund cards). Reads the union and anchors new notes to
// the return so the same list shows at every stage and is never lost across
// compile/uncompile.
//
// Reading is open to everyone, at every stage — the thread is how the next
// person picks the case up. Writing is scoped to whoever the case is with:
//   - add     — only the owner of the column the card is sitting in right now
//   - edit    — the note's own author, and only while they own that column
//   - delete  — same as edit, and always behind a confirm step
// Every button renders either way: red when the action is yours to take, grey
// and inert when it isn't. A card parked in someone else's column should read
// as "not your turn", not as a broken button.
const NOTE_RED = '#c53030';
const NOTE_GREY = '#a0aec0';

// Shared look for the inline edit/delete links on a note.
function noteLinkStyle(enabled: boolean, fontSize: number): CSSProperties {
  return {
    border: 'none', background: 'none', padding: 0,
    color: enabled ? NOTE_RED : NOTE_GREY,
    cursor: enabled ? 'pointer' : 'not-allowed',
    fontWeight: enabled ? 600 : 400,
    fontSize, lineHeight: 1.4,
  };
}

export function CaseNotes({
  refundId = null, returnId = null, cancellationId = null,
  canWrite, ownerLabel = '', variant = 'compact',
  label = 'Notes', emptyHint, placeholder = 'Add a note…', onError,
}: {
  refundId?: string | null;
  returnId?: string | null;
  cancellationId?: string | null;
  /** True when the card currently sits in a column this user owns. */
  canWrite: boolean;
  /** Who does own it — named in the hint when canWrite is false. Empty for
   *  the terminal columns, which nobody owns. */
  ownerLabel?: string;
  variant?: 'compact' | 'panel';
  label?: string;
  emptyHint?: string;
  placeholder?: string;
  onError: (m: string | null) => void;
}) {
  const { notes, refresh } = useCaseNotes(refundId, returnId, cancellationId);
  const { user } = useAuth();
  const uid = user?.id;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  // Which note is asking "delete this?" — the confirm popover is per-note, so
  // one stray click never removes anything on its own.
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const panel = variant === 'panel';
  const bodySize = panel ? 13 : 12;
  const linkSize = panel ? 11 : 10;
  const lockedHint = ownerLabel
    ? `${ownerLabel} owns this column — only they can add, edit or delete notes while the card is here`
    : 'This case is closed — its notes are read-only';

  const add = async () => {
    if (!canWrite || !text.trim()) return;
    setBusy(true); onError(null);
    try { await addCaseNote(refundId, returnId, text, cancellationId); setText(''); refresh(); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };
  const del = async (n: CaseNote) => {
    if (!canWrite || n.author_id !== uid) return;
    setBusy(true); onError(null);
    try { await deleteCaseNote(n, refundId, returnId, cancellationId); setConfirmId(null); refresh(); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };
  const saveEdit = async (n: CaseNote) => {
    if (!canWrite || n.author_id !== uid || !editText.trim()) return;
    setBusy(true); onError(null);
    try { await updateCaseNote(n, refundId, returnId, editText, cancellationId); setEditId(null); refresh(); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div onClick={e => e.stopPropagation()} style={{ margin: panel ? 0 : '8px 0' }}>
      <div style={{ fontSize: 12, fontWeight: panel ? 700 : 600, color: '#4a5568', marginBottom: panel ? 6 : 4 }}>
        {label} ({notes.length})
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: panel ? 6 : 4, marginBottom: panel ? 8 : 6 }}>
        {notes.length === 0 && emptyHint && (
          <div style={{ fontSize: 12, color: NOTE_GREY }}>{emptyHint}</div>
        )}
        {notes.map(n => {
          const isAuthor = n.author_id === uid;
          const mayEdit = canWrite && isAuthor;
          const editHint = !canWrite ? lockedHint
            : !isAuthor ? `Only ${n.author_name ?? 'the author'} can edit or delete this note`
            : undefined;
          return (
            <div key={n.id} style={{ fontSize: bodySize, background: '#f7fafc', border: panel ? 'none' : '1px solid #edf2f7', borderRadius: 6, padding: panel ? '6px 9px' : '4px 6px' }}>
              {editId === n.id ? (
                <>
                  <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={2} autoFocus
                    aria-label="Edit note"
                    onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void saveEdit(n); if (e.key === 'Escape') setEditId(null); }}
                    style={{ width: '100%', fontSize: bodySize, padding: '4px 6px', border: `1px solid ${NOTE_RED}`, borderRadius: 6, resize: 'vertical' }} />
                  <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                    <button onClick={() => void saveEdit(n)} disabled={busy || !editText.trim()}
                      style={{ fontSize: linkSize, fontWeight: 600, padding: '2px 10px', borderRadius: 6,
                               border: `1px solid ${NOTE_RED}`, color: '#fff', background: NOTE_RED,
                               cursor: busy || !editText.trim() ? 'default' : 'pointer',
                               opacity: busy || !editText.trim() ? 0.6 : 1 }}>Save</button>
                    <button onClick={() => setEditId(null)} disabled={busy}
                      style={{ border: 'none', background: 'none', color: NOTE_GREY, cursor: 'pointer', fontSize: linkSize }}>Cancel</button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, color: NOTE_GREY, fontSize: 10, marginTop: panel ? 3 : 2 }}>
                    <span>{n.author_name ?? 'Unknown'} · {new Date(n.created_at).toLocaleString('en-US')}</span>
                    <span style={{ display: 'flex', gap: 10, position: 'relative' }}>
                      <button onClick={() => { if (!mayEdit) return; setConfirmId(null); setEditId(n.id); setEditText(n.body); }}
                        disabled={busy || !mayEdit} aria-disabled={!mayEdit}
                        title={editHint ?? 'Edit your note'}
                        style={noteLinkStyle(mayEdit, linkSize)}>edit</button>
                      <button onClick={() => { if (!mayEdit) return; setConfirmId(n.id); }}
                        disabled={busy || !mayEdit} aria-disabled={!mayEdit}
                        title={editHint ?? 'Delete your note'}
                        style={noteLinkStyle(mayEdit, linkSize)}>delete</button>
                      {confirmId === n.id && (
                        <span role="dialog" aria-label="Confirm delete note"
                          style={{ position: 'absolute', right: 0, bottom: '100%', marginBottom: 6, zIndex: 20,
                                   display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap',
                                   background: '#fff', border: `1px solid ${NOTE_RED}`, borderRadius: 6,
                                   padding: '6px 8px', boxShadow: '0 4px 12px rgba(0,0,0,0.12)' }}>
                          <span style={{ fontSize: 11, color: '#4a5568' }}>Delete this note?</span>
                          <button onClick={() => void del(n)} disabled={busy}
                            style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 6,
                                     border: `1px solid ${NOTE_RED}`, color: '#fff', background: NOTE_RED, cursor: 'pointer' }}>
                            {busy ? '…' : 'Delete'}
                          </button>
                          <button onClick={() => setConfirmId(null)} disabled={busy}
                            style={{ border: 'none', background: 'none', color: NOTE_GREY, cursor: 'pointer', fontSize: 11 }}>Cancel</button>
                        </span>
                      )}
                    </span>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: panel ? 6 : 4 }}>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={panel ? 2 : 1}
          aria-label="New note"
          placeholder={canWrite ? placeholder : lockedHint}
          disabled={!canWrite} title={canWrite ? undefined : lockedHint}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void add(); }}
          style={{ flex: 1, fontSize: bodySize, padding: panel ? '6px 9px' : '4px 6px',
                   border: '1px solid #e2e8f0', borderRadius: 6, resize: 'vertical', minHeight: panel ? undefined : 28,
                   background: canWrite ? '#fff' : '#f7fafc', color: canWrite ? undefined : NOTE_GREY,
                   cursor: canWrite ? undefined : 'not-allowed' }} />
        <button onClick={() => void add()} disabled={busy || !canWrite || !text.trim()} aria-disabled={!canWrite}
          title={canWrite ? undefined : lockedHint}
          style={{ fontSize: panel ? 12 : 11, fontWeight: 600, padding: panel ? '0 14px' : '0 10px', borderRadius: 6,
                   whiteSpace: 'nowrap',
                   border: `1px solid ${canWrite ? NOTE_RED : '#e2e8f0'}`,
                   color: canWrite ? '#fff' : NOTE_GREY,
                   background: canWrite ? NOTE_RED : '#f7fafc',
                   cursor: canWrite && text.trim() && !busy ? 'pointer' : 'not-allowed',
                   opacity: canWrite && text.trim() && !busy ? 1 : 0.75 }}>
          {busy ? '…' : panel ? 'Add note' : 'Add'}
        </button>
      </div>
      {!canWrite && (
        <div style={{ fontSize: 11, color: NOTE_GREY, marginTop: 4 }}>{lockedHint}.</div>
      )}
    </div>
  );
}

// Photos on a case live in two sections — "Context of the Case" (what the
// customer sent us) and "Inspection" (what we found on the bench). Both take
// pasted images, so a single window-level paste listener lives here in the
// parent and routes to whichever section is armed; two independent listeners
// would file the same clipboard image into both sections.
function CaseAttachmentStrip({ refundId = null, returnId = null, onError }: {
  refundId?: string | null;
  returnId?: string | null;
  onError: (m: string | null) => void;
}) {
  const { attachments, refresh } = useCaseAttachments(refundId, returnId);
  const [busy, setBusy] = useState(false);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [pasteTarget, setPasteTarget] = useState<ReturnAttachmentCategory>('context');

  const handleFiles = async (files: File[], category: ReturnAttachmentCategory) => {
    if (!files.length) return;
    setBusy(true); onError(null);
    try {
      for (const f of files) await uploadCaseAttachment({ refundId, returnId }, toNamedFile(f), category);
      refresh();
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const imgs = imageFilesFrom(e.clipboardData);
      if (imgs.length) { e.preventDefault(); void handleFiles(imgs, pasteTarget); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refundId, returnId, pasteTarget]);

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
    try { await deleteCaseAttachment(a); refresh(); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div onClick={e => e.stopPropagation()} style={{ margin: '8px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {RETURN_ATTACH_CATEGORIES.map(cat => (
        <ReturnAttachmentSection
          key={cat.value}
          label={cat.label}
          armed={pasteTarget === cat.value}
          onArm={() => setPasteTarget(cat.value)}
          items={attachments.filter(a => (a.category ?? 'context') === cat.value)}
          urls={urls}
          busy={busy}
          onUpload={files => void handleFiles(files, cat.value)}
          onDelete={a => void del(a)}
        />
      ))}
    </div>
  );
}

// One titled photo section. Clicking anywhere in it arms it as the paste
// target, so the operator can paste straight into the section they mean.
function ReturnAttachmentSection({ label, armed, onArm, items, urls, busy, onUpload, onDelete }: {
  label: string;
  armed: boolean;
  onArm: () => void;
  items: ReturnAttachment[];
  urls: Record<string, string>;
  busy: boolean;
  onUpload: (files: File[]) => void;
  onDelete: (a: ReturnAttachment) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div onClick={onArm}
      style={{ border: `1px solid ${armed ? '#90cdf4' : '#edf2f7'}`, background: armed ? '#f7fbff' : '#fff',
               borderRadius: 8, padding: '8px 10px', cursor: armed ? 'default' : 'pointer' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#4a5568' }}>{label} ({items.length})</span>
        {armed && (
          <span style={{ fontSize: 10, fontWeight: 600, color: '#2b6cb0', background: '#ebf8ff', border: '1px solid #bee3f8', borderRadius: 999, padding: '1px 7px' }}>
            ⌘/Ctrl+V pastes here
          </span>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {items.map(a => {
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
              <button onClick={() => onDelete(a)} disabled={busy} title="Remove"
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
        onChange={e => { onUpload(Array.from(e.target.files ?? [])); e.currentTarget.value = ''; }} />
      <div style={{ fontSize: 10, color: '#a0aec0', marginTop: 3 }}>
        {armed
          ? 'Paste (⌘/Ctrl+V) an image to file it here, or click + to upload.'
          : 'Click this section to paste here, or click + to upload.'}
      </div>
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
    try { await openInvoiceInNewTab(path); }
    catch (e) { alert((e as Error).message); }
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
            {/* What they paid (the invoice's Payment line), which is what the
                refund is based on — not Total Due, which is $0.00 once paid. */}
            {invoiceAmountCad(inv) != null && (
              <span className={styles.invoiceAmount}
                title={inv.payment_cad != null ? 'Paid (invoice Payment line)' : 'Invoice total'}>
                ${invoiceAmountCad(inv)!.toFixed(2)} CAD
              </span>
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
// Collapsed queue card — every card on the Refunds board
// ============================================================================
// The board itself carries identity only: who the case belongs to (purchaser /
// primary user, and which of them filled the form) and the order it's against.
// Amount, badges, notes, unit status and every action live behind "Open Full
// Refund Card", which opens the same full view the card always opened.
export function CollapsedCard({
  borderColor, parties, orderRef, selected = false, onOpen,
}: {
  borderColor: string;
  parties: Parties;
  orderRef?: string | null;
  selected?: boolean;
  onOpen: () => void;
}) {
  return (
    <div
      className={`${styles.refundCard} ${selected ? styles.refundCardSelected : ''}`}
      style={{ borderLeftColor: borderColor }}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
      }}
      title="Open the full refund card"
    >
      <div className={styles.refundCardHead}>
        <PartyHeader parties={parties} />
      </div>
      {orderRef && <div className={styles.refundMeta}>{orderRef}</div>}
      <button
        className={styles.openFullCardBtn}
        onClick={e => { e.stopPropagation(); onOpen(); }}
      >
        Open Full Refund Card
      </button>
    </div>
  );
}

// ============================================================================
// Refund card
// ============================================================================
// A card in the "Return Form Submitted" / "Return & inspection" columns — a
// return that doesn't yet have a refund request. Collapsed like every other
// card on the board; the full return form (with the column actions) opens in
// ReturnDetailModal.
function InspectionCard({ r, parties, onView }: {
  r: ReturnRow;
  parties: Parties;
  onView: () => void;
}) {
  return (
    <CollapsedCard
      borderColor="#805ad5"
      parties={parties}
      orderRef={r.original_order_ref}
      onOpen={onView}
    />
  );
}

// The column actions for a pre-refund return (intake → inspection → compile).
// They live in the return's full view now that the board card is collapsed.
function InspectionActions({ r, canOwn, onCompile, onError }: {
  r: ReturnRow;
  canOwn: boolean;
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
    <div className={styles.refundActions}>
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
  );
}

// ============================================================================
// Cancellation card
// ============================================================================
// A card in the "Cancellation Requests" column: a customer cancellation form
// that hasn't been turned into a refund yet. Sibling of InspectionCard — the
// return form's card — so both intake paths look and behave the same. Compiling
// opens a refund card in Completeness; "No refund needed" closes the request
// out for orders that were never charged.
export function CancellationCard({
  c, parties, contact, canOwn, usage, invoices, tickets, onOpenTicket, onError,
}: {
  c: OrderCancellation;
  parties: Parties;
  contact: CustomerContact;
  canOwn: boolean;
  usage: RefundUsageWindow;
  invoices: CustomerInvoice[];
  tickets: ServiceTicket[];
  onOpenTicket: (ticketId: string) => void;
  onError: (msg: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); onError(null);
    try { await fn(); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  const dismiss = () => {
    const note = window.prompt('Why is no refund needed? (e.g. order was never charged)') ?? undefined;
    void run(() => dismissCancellationRefund(c, note));
  };

  // Collapsed on the board like every other card; the full request — context,
  // notes and the compile/dismiss actions — opens in a modal ON TOP of it. The
  // card stays in its column the whole time: every other card type keeps its
  // place because the parent owns the modal, and a request that disappears from
  // Cancellation Requests while someone reads it looks like it was already
  // dealt with.
  const [open, setOpen] = useState(false);

  return (
    <>
    <CollapsedCard
      borderColor="#d69e2e"
      parties={parties}
      orderRef={c.order_ref}
      selected={open}
      onOpen={() => setOpen(true)}
    />
    {open && (
    <div className={styles.modalBackdrop} onClick={() => setOpen(false)}>
    <div className={styles.modalCard} onClick={e => e.stopPropagation()}
         style={{ maxWidth: 720, maxHeight: '85vh', overflowY: 'auto' }}>
      <div className={styles.refundCardHead}>
        <PartyHeader parties={parties} />
        {c.order_amount_usd != null && (
          <span className={styles.refundAmount}>${Number(c.order_amount_usd).toLocaleString('en-US')}</span>
        )}
        <button className={styles.btnSecondary} onClick={() => setOpen(false)}>Close</button>
      </div>
      <div className={styles.refundMeta}>
        {[c.order_ref, c.product_name, c.purchase_channel].filter(Boolean).join(' · ') || '—'}
      </div>
      <ContactBlock contact={contact} />
      {/* Top of the card, not buried at the bottom — the customer's own words
          are the first thing an operator wants, and the return side has had
          this since the board collapsed its cards. Both intake paths now open
          the form the customer actually filled out. */}
      <div style={{ margin: '10px 0 4px' }}><CancellationFormButton c={c} /></div>
      {c.reason && <div className={styles.refundReason}>{c.reason}</div>}
      {c.desired_resolution && <div className={styles.refundMeta}>Wants: {c.desired_resolution}</div>}
      {/* Which channel the customer asked to be reached on — the numbers
          themselves are in the contact block above. */}
      <div className={styles.refundMeta}>
        Preferred contact: {c.preferred_contact ?? '—'}
      </div>
      {c.product_received && (
        <div style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
                      color: '#975a16', background: '#fffbeb', display: 'inline-block', margin: '4px 0' }}>
          ⚠ Customer already has the unit — route through Returns
        </div>
      )}
      {c.description && <div className={styles.refundReason}>{c.description}</div>}
      <UsageWindowBadge usage={usage} />
      <RefundInvoices invoices={invoices} fallbackOrderRef={c.order_ref} />
      <CustomerTicketHistory tickets={tickets} onOpenTicket={onOpenTicket} defaultOpen />
      {/* Notes anchor to the cancellation, so they carry onto the refund card
          this compiles into instead of starting over there. */}
      <CaseNotes cancellationId={c.id} canWrite={canOwn} ownerLabel={refundColumnOwnerLabel('cancellation')} onError={onError} />
      <div className={styles.refundActions}>
        {canOwn ? (
          <>
            <button className={styles.refundApproveBtn} disabled={busy}
              onClick={() => void run(() => compileCancellationToRefund(c))}
              title="Open a refund request for this cancellation (moves it to the Completeness column)">
              {busy ? '…' : 'Compile → Completeness'}
            </button>
            <button className={styles.refundCloseBtn} disabled={busy} onClick={dismiss}
              title="No money was collected — close the cancellation without a refund">
              No refund needed
            </button>
          </>
        ) : (
          <span className={styles.refundCardHint}>Reina moves these forward</span>
        )}
      </div>
    </div>
    </div>
    )}
    </>
  );
}

// A card in one of the refund columns. Collapsed to the case's identity — the
// full card (amount, badges, unit status, notes, actions) opens in
// RefundDetailPanel, exactly as clicking the card always did.
function RefundCard({ refund, linkedReturn, orderRef, parties, selected, onSelect }: {
  refund: RefundApproval;
  linkedReturn: ReturnRow | null;
  orderRef?: string | null;
  parties: Parties;
  selected: boolean;
  onSelect: () => void;
}) {
  const meta = REFUND_STATUS_META[refund.status];
  return (
    <CollapsedCard
      borderColor={meta.color}
      parties={parties}
      orderRef={orderRef ?? linkedReturn?.original_order_ref}
      selected={selected}
      onOpen={onSelect}
    />
  );
}

// ============================================================================
// Contact block — on every card on this board
// ============================================================================
// Whoever is looking at a card has to be able to reach the customer without
// leaving for the Customers directory, whether the card came from a return
// form, a cancellation or was raised by hand. That means the intake columns
// too: a cancellation request is a refund case someone has to work, and it is
// the case least likely to have anything else on file. A field with nothing
// behind it says so in plain words — a blank line reads like an oversight, and
// an operator can't tell "we never captured a phone" from "the card forgot to
// render it".
export function ContactBlock({ contact }: { contact: CustomerContact }) {
  const row = (label: string, value: string | null, missing: string, href?: string) => (
    <div className={styles.contactRow}>
      <span className={styles.contactLabel}>{label}</span>
      {value ? (
        href
          ? <a className={styles.contactLink} href={`${href}${value}`}>{value}</a>
          : <span className={styles.contactValue}>{value}</span>
      ) : (
        <span className={styles.contactMissing}>{missing}</span>
      )}
    </div>
  );
  return (
    <div className={styles.contactBlock}>
      {row('Email', contact.email, 'No email on file', 'mailto:')}
      {row('Phone', contact.phone, 'No phone number on file', 'tel:')}
      {row('Address', contact.address, 'No address on file')}
    </div>
  );
}

// ============================================================================
// The machine this case is about
// ============================================================================
// A refund case names a unit the customer has already sent back, so the moment
// it leaves `shipped` every "currently held" lookup renders it as nothing — and
// most cases on this board never captured a serial at all. resolveCaseUnit
// reaches for it instead, and this block shows the answer together with the
// path that produced it: an operator deciding a refund needs to know whether
// the serial came off the case itself or was inferred from a customer record
// that the June backfill may have pointed at the wrong person. A confirmed
// serial is stated plainly; a guess says it is one, and offers to become fact.
function CaseUnitBlock({ unit, returnId, onError, onConfirmed }: {
  unit: CaseUnitResolution;
  returnId: string | null;
  onError: (msg: string) => void;
  onConfirmed: () => void;
}) {
  const [busy, setBusy] = useState(false);

  if (!unit.serial) {
    return (
      <div className={styles.contactBlock}>
        <div className={styles.contactRow}>
          <span className={styles.contactLabel}>Unit</span>
          <span className={styles.contactMissing}>
            No serial on this case, and nothing on file identifies the machine
          </span>
        </div>
      </div>
    );
  }

  const confirmable = !unit.confirmed && returnId !== null;
  const confirm = () => {
    if (!returnId || !unit.serial) return;
    setBusy(true);
    void confirmCaseUnitSerial(returnId, unit.serial)
      .then(onConfirmed)
      .catch(e => onError((e as Error).message))
      .finally(() => setBusy(false));
  };

  return (
    <div className={styles.contactBlock}>
      <div className={styles.contactRow}>
        <span className={styles.contactLabel}>Unit</span>
        <span className={styles.contactValue}>
          <Link className={styles.contactLink} to={`/customers?tab=fleet&serial=${unit.serial}`}>
            {unit.serial}
          </Link>
          {unit.status && (
            <span className={styles.caseUnitStatus}>
              now {STATUS_META[unit.status as UnitStatus]?.label ?? unit.status}
            </span>
          )}
        </span>
      </div>
      <div className={styles.contactRow}>
        <span className={styles.contactLabel}>Source</span>
        <span className={unit.confirmed ? styles.contactValue : styles.caseUnitGuess}>
          {CASE_UNIT_VIA_LABEL[unit.via ?? 'case']}
          {unit.others.length > 0 && (
            <> · {unit.others.length === 1
              ? `1 other unit also matches (${unit.others[0].serial})`
              : `${unit.others.length} other units also match`}</>
          )}
          {unit.conflictingName && (
            <> · the unit itself is recorded to <strong>{unit.conflictingName}</strong></>
          )}
          {confirmable && (
            <button className={styles.caseUnitConfirm} disabled={busy} onClick={confirm}>
              {busy ? 'Saving…' : 'Confirm'}
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

// ============================================================================
// Detail panel — shown below the Kanban when a card is selected.
// Renders the linked return-form data + approve / deny actions.
// ============================================================================
function RefundDetailPanel({
  refund, linkedReturn, cancellation = null, parties, contact, caseUnit, returnId, canApproveHere, usage, invoices, tickets, onOpenTicket, queuedReplacements, canFlow, onClose, onError, onMoved, onOpenFinanceModal,
}: {
  refund: RefundApproval;
  linkedReturn: ReturnRow | null;
  /** The cancellation form this refund was compiled from, when it came from
   *  one — it carries both the notes thread and the customer's answers. */
  cancellation?: OrderCancellation | null;
  parties: Parties;
  contact: CustomerContact;
  canApproveHere: boolean;
  usage: RefundUsageWindow;
  invoices: CustomerInvoice[];
  tickets: ServiceTicket[];
  onOpenTicket: (ticketId: string) => void;
  queuedReplacements: Order[];
  caseUnit: CaseUnitResolution;
  returnId: string | null;
  canFlow: boolean;
  onClose: () => void;
  onError: (msg: string | null) => void;
  /** Re-read the board after a stage write. Realtime is meant to deliver the
   *  change on its own, but a dropped socket loses it silently and strands the
   *  card in the column it just left — so every move confirms itself. */
  onMoved: () => Promise<void>;
  onOpenFinanceModal: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [holdBusy, setHoldBusy] = useState<string | null>(null);
  const meta = REFUND_STATUS_META[refund.status];
  const cancellationId = cancellation?.id ?? null;

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
      await onMoved();
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
    try { await executeRefund(refund.id); onClose(); await onMoved(); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  const runClose = async () => {
    setBusy(true); onError(null);
    try { await closeRefund(refund.id); onClose(); await onMoved(); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  const runSubmitToManager = async () => {
    setBusy(true); onError(null);
    try { await submitToManager(refund.id); onClose(); await onMoved(); }
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
        await onMoved();
      } else {
        const stage = (['submitted', 'manager_review', 'finance_review', 'refund_queue'].includes(refund.status)
          ? refund.status : 'manager_review') as 'submitted' | 'manager_review' | 'finance_review' | 'refund_queue';
        await denyRefund(refund.id, stage, inputVal.trim());
        onClose();
        await onMoved();
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
            {linkedReturn?.original_order_ref ?? 'No order reference on file'}
          </div>
          <ContactBlock contact={contact} />
          <CaseUnitBlock unit={caseUnit} returnId={returnId}
                         onError={onError} onConfirmed={onMoved} />
          {/* Top of the card, not buried at the bottom — the customer's own
              words are the first thing an approver wants. */}
          {linkedReturn && (
            <div style={{ marginTop: 10 }}><ReturnFormButton r={linkedReturn} /></div>
          )}
          {!linkedReturn && cancellation && (
            <div style={{ marginTop: 10 }}><CancellationFormButton c={cancellation} /></div>
          )}
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#4a5568' }}>Refund amount:</span>
            <AmountEditor refund={refund} editable onError={onError} big />
          </div>
          {/* The refund method is set by Finance (Julie) at Finance Review and
              read by Pedrum in the Refund Queue. Falls back to the legacy
              payment_method. */}
          {refund.refund_method ? (
            <div className={styles.refundMeta} style={{ fontWeight: 700, color: '#2d3748', fontStyle: 'normal', marginTop: 6 }}>
              Refund via {REFUND_METHOD_META[refund.refund_method].label}
            </div>
          ) : refund.payment_method ? (
            <div className={styles.refundMeta} style={{ marginTop: 6 }}>via {refund.payment_method}</div>
          ) : null}
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
          <ReturnTrackingBadge r={linkedReturn} />
        </div>
        </>
      )}

      {/* Photos file against the return when the case has one and against the
          refund when it doesn't, so a card with no return behind it — born from
          a cancellation form, or opened by hand — still takes evidence. */}
      <CaseAttachmentStrip refundId={refund.id} returnId={linkedReturn?.id ?? null} onError={onError} />

      {/* Notes for approvers (George/Julie) — collaborative, timestamped,
          attributed, and writable only by whoever owns the column the card is
          in right now (canApproveHere). Everyone still reads the whole thread. */}
      <div style={{ margin: '12px 0', borderTop: '1px solid #edf2f7', paddingTop: 12 }}>
        <CaseNotes
          refundId={refund.id}
          returnId={refund.return_id}
          cancellationId={cancellationId}
          canWrite={canApproveHere}
          ownerLabel={refundColumnOwnerLabel(refund.status)}
          variant="panel"
          label="Notes for approvers"
          emptyHint="No notes yet — add context for the approver here."
          placeholder="Add a note for approvers (extra details on the refund/return)…"
          onError={onError}
        />
      </div>

      {/* Approval trail — who moved the case and what they said. Used to sit on
          the board card; it lives here now that the card is collapsed. */}
      <div style={{ margin: '12px 0', borderTop: '1px solid #edf2f7', paddingTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#4a5568', marginBottom: 6 }}>Approval trail</div>
        <div className={styles.refundTimeline}>
          <RefundStep label="Submitted" ts={refund.submitted_at} active />
          {refund.manager_approved_at && (
            <RefundStep label="Manager ✓" ts={refund.manager_approved_at} note={refund.manager_decision_note} active />
          )}
          {refund.finance_approved_at && (
            <RefundStep label="Finance ✓ amount" ts={refund.finance_approved_at} note={refund.finance_decision_note} active />
          )}
          {refund.refunded_at && (
            <RefundStep label="Refunded ✓ paid" ts={refund.refunded_at} active />
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
            {refund.status === 'refunded' && (
              <button onClick={() => void runClose()} disabled={busy} className={styles.refundCloseBtn}
                title="Close this case out — the payout is done and nothing else is owed">
                {busy ? '…' : 'Close'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
    </div>
  );
}

// The customer's form answers run long — a dozen fields plus free text — and
// they buried the case controls in every detail view. Both views now open them
// on demand, in their own window, the same way the board opens a full card.
export function ReturnFormButton({ r }: { r: ReturnRow }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className={styles.openFormBtn}
        onClick={e => { e.stopPropagation(); setOpen(true); }}
      >
        Open Refund/Return Form
      </button>
      {open && (
        <div className={styles.modalBackdrop} onClick={() => setOpen(false)}>
          <div className={styles.modalCard} onClick={e => e.stopPropagation()}
               style={{ maxWidth: 720, maxHeight: '85vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          gap: 12, marginBottom: 12 }}>
              <h3 className={styles.modalTitle} style={{ margin: 0 }}>
                Refund/Return form · {r.return_ref ?? r.original_order_ref ?? '—'}
              </h3>
              <button className={styles.btnSecondary} onClick={() => setOpen(false)}>Close</button>
            </div>
            <ReturnFormAnswers r={r} />
          </div>
        </div>
      )}
    </>
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

// The cancellation-side twin of ReturnFormButton. A cancellation request is an
// intake form like any other, so the answers open the same way — on demand, in
// their own window — from the request card and from the refund it compiles
// into.
export function CancellationFormButton({ c }: { c: OrderCancellation }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className={styles.openFormBtn}
        onClick={e => { e.stopPropagation(); setOpen(true); }}
      >
        Open Cancellation Form
      </button>
      {open && (
        <div className={styles.modalBackdrop} onClick={() => setOpen(false)}>
          <div className={styles.modalCard} onClick={e => e.stopPropagation()}
               style={{ maxWidth: 720, maxHeight: '85vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          gap: 12, marginBottom: 12 }}>
              <h3 className={styles.modalTitle} style={{ margin: 0 }}>
                Cancellation form · {c.order_ref ?? '—'}
              </h3>
              <button className={styles.btnSecondary} onClick={() => setOpen(false)}>Close</button>
            </div>
            <CancellationFormAnswers c={c} />
          </div>
        </div>
      )}
    </>
  );
}

// The full set of cancellation-form answers, in the order the customer was
// asked for them (see modules/Forms/CancelOrderForm.tsx). Name, email and
// phone are deliberately absent: every view that opens this renders a
// ContactBlock above it.
function CancellationFormAnswers({ c }: { c: OrderCancellation }) {
  return (
    <div className={styles.refundDetailGrid}>
      <DetailField label="Order #" value={c.order_ref ?? '—'} mono />
      <DetailField label="Order date" value={c.order_date ?? '—'} />
      <DetailField label="Product / Service" value={c.product_name ?? '—'} />
      <DetailField
        label="Order amount"
        value={c.order_amount_usd != null
          ? `$${Number(c.order_amount_usd).toLocaleString('en-US')}`
          : '—'}
      />
      <DetailField label="Purchase channel" value={c.purchase_channel ?? '—'} />
      <DetailField label="Preferred contact" value={c.preferred_contact ?? '—'} />
      {/* Whether the unit is already with the customer decides whether this is
          a cancellation at all or a return — so it reads as words, not a tick. */}
      <DetailField
        label="Product received yet?"
        value={c.product_received == null ? '—' : c.product_received ? 'Yes' : 'No'}
      />
      <DetailField label="Submitted" value={new Date(c.created_at).toLocaleString('en-US')} />

      <DetailField label="Reason for cancellation" wide value={c.reason ?? '—'} />
      <DetailField label="Desired resolution" wide value={c.desired_resolution ?? '—'} />

      <DetailField label="Detailed explanation" wide>
        <div className={styles.detailQuote}>{c.description ?? '—'}</div>
      </DetailField>

      {c.ops_notes && (
        <DetailField label="Ops notes" wide>
          <div className={styles.detailQuote}>{c.ops_notes}</div>
        </DetailField>
      )}
    </div>
  );
}

// Read-only viewer for a return's full submitted form — opened by clicking a
// card in the Return & inspection column (before a refund request exists).
export function ReturnDetailModal({ r, parties, contact, caseUnit, canOwn, usage, invoices, tickets, onOpenTicket, onCompile, onError, onClose }: {
  r: ReturnRow;
  parties: Parties;
  contact: CustomerContact;
  caseUnit: CaseUnitResolution;
  canOwn: boolean;
  usage: RefundUsageWindow;
  invoices: CustomerInvoice[];
  tickets: ServiceTicket[];
  onOpenTicket: (ticketId: string) => void;
  onCompile: () => void;
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
          </div>
          <button className={styles.btnSecondary} onClick={onClose}>Close</button>
        </div>
        {/* Replaces the old "email · phone" line: same two values, plus the
            mailing address the return form never captured, and each one says
            so when it isn't on file. */}
        <ContactBlock contact={contact} />
        <CaseUnitBlock unit={caseUnit} returnId={r.id}
                       onError={onError} onConfirmed={onClose} />
        {/* Full case context — same blocks the refund detail panel shows:
            usage window, sales invoice + order #, ticket history, saved notes,
            then the return form answers. */}
        <div style={{ marginTop: 12 }}>
          {/* Top of the card, not buried at the bottom — the customer's own
              words are the first thing an operator wants. */}
          <ReturnFormButton r={r} />
          {r.refund_amount_usd != null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#4a5568' }}>Requested amount:</span>
              <span className={styles.refundAmount}>${Number(r.refund_amount_usd).toLocaleString('en-US')}</span>
            </div>
          )}
          {r.reason && <div className={styles.refundReason}>{r.reason}</div>}
          <CustomerWaitBadge r={r} />
          <UnitStatusEditor r={r} onError={onError} />
          <DispositionEditor r={r} onError={onError} />
          <UsageWindowBadge usage={usage} />
          <RefundInvoices invoices={invoices} fallbackOrderRef={r.original_order_ref} />
          <CustomerTicketHistory tickets={tickets} onOpenTicket={onOpenTicket} defaultOpen />
          <CaseNotes returnId={r.id} canWrite={canOwn} ownerLabel={refundColumnOwnerLabel(preRefundStage(r.status))} onError={onError} />
          <CaseAttachmentStrip returnId={r.id} onError={onError} />
          {/* Column actions — these used to live on the board card, which is
              now collapsed to the case's identity. */}
          <div style={{ marginTop: 12, borderTop: '1px solid #edf2f7', paddingTop: 12 }}>
            <InspectionActions r={r} canOwn={canOwn} onCompile={onCompile} onError={onError} />
          </div>
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
// Create Manual Refund modal
// ============================================================================
// Open a refund on a customer picked straight from the directory, with no
// return or cancellation form behind it — the path for cases that arrive by
// email or phone. Everyone in the refund workflow can create one; it lands in
// Completeness like every other card, so nothing skips verification.
//
// Photos and the opening note can only be written once the refund row exists
// (both are keyed to its id), so submit creates the card first and then files
// them against it.
function CreateManualRefundModal({
  onClose, onError, onMoved,
}: {
  onClose: () => void;
  onError: (msg: string | null) => void;
  /** Re-read the board once the card exists — see RefundDetailPanel. */
  onMoved: () => Promise<void>;
}) {
  const { customers, loading: customersLoading } = useCustomers();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Customer | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [category, setCategory] = useState<ReturnCategory | ''>('');
  const [reasonDetail, setReasonDetail] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // FR-6: a directory row can be a USER acting for someone else. Refunds book
  // against the PURCHASER, so that's who the card is opened for.
  const purchaser = useMemo(() => {
    if (!picked) return null;
    const payeeId = resolvePurchaserId(picked);
    return payeeId === picked.id ? null : customers.find(c => c.id === payeeId) ?? null;
  }, [picked, customers]);
  const payee = purchaser ?? picked;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return customers.slice(0, 50);
    return customers.filter(c =>
      c.full_name.toLowerCase().includes(q) ||
      (c.email ?? '').toLowerCase().includes(q) ||
      (c.phone ?? '').toLowerCase().includes(q)
    ).slice(0, 50);
  }, [customers, query]);

  const pick = (c: Customer) => {
    setPicked(c);
    setQuery(c.full_name);
    setListOpen(false);
  };

  const addFiles = (picked: File[]) => {
    const ok = picked.filter(f => !f.type || RETURN_ATTACH_ALLOWED_MIME.includes(f.type));
    if (ok.length !== picked.length) onError('Some files were skipped — images and PDFs only.');
    setFiles(prev => [...prev, ...ok.map(toNamedFile)]);
  };

  // Paste-to-attach, same gesture as the card's photo strip.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const imgs = imageFilesFrom(e.clipboardData);
      if (imgs.length) { e.preventDefault(); addFiles(imgs); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canSubmit = !!payee && !!category && !submitting;

  const submit = async () => {
    if (!payee || !category) return;
    setSubmitting(true); onError(null);
    let refundId: string | null = null;
    try {
      setStep('Creating the card…');
      // Opens at what they paid on their sales invoice (CAD); Finance confirms
      // the figure and sets the method at Finance Review.
      const opening = await defaultRefundAmountFromInvoice(payee.email, null, null);
      const reason = manualRefundReason(category, reasonDetail);
      refundId = await submitRefundRequest({
        customer_name: payee.full_name,
        customer_email: payee.email ?? undefined,
        refund_amount_usd: opening.amount,
        currency: opening.currency,
        reason,
        notes: purchaser ? `Opened from directory entry "${picked?.full_name}" (user); refund books to the purchaser.` : undefined,
      });

      if (files.length) {
        setStep(`Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`);
        for (const f of files) {
          await uploadCaseAttachment({ refundId, returnId: null }, f, 'context');
        }
      }
      if (notes.trim()) {
        setStep('Saving the note…');
        await addCaseNote(refundId, null, notes);
      }
      onClose();
    } catch (e) {
      // The card may already exist — say so rather than implying nothing happened.
      const msg = (e as Error).message;
      onError(refundId
        ? `The refund card was created, but finishing it failed: ${msg}. Open the card to add the rest.`
        : msg);
    } finally {
      // Whether or not the extras landed, the card itself exists once
      // refundId is set — pull it onto the board rather than waiting on a
      // realtime insert that may never arrive.
      if (refundId) await onMoved();
      setSubmitting(false);
      setStep(null);
    }
  };

  const field = (label: string, value: string | null | undefined) => (
    <div style={{ display: 'flex', gap: 6, fontSize: 12 }}>
      <span style={{ color: '#718096', minWidth: 62 }}>{label}</span>
      <span style={{ color: value ? '#2d3748' : '#a0aec0', fontWeight: value ? 600 : 400 }}>{value || '—'}</span>
    </div>
  );

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <strong>Create Manual Refund</strong>
          <button onClick={onClose} className={styles.modalClose}>✕</button>
        </div>
        <div className={styles.modalBody}>

          {/* Customer — picked from the directory, never typed freehand, so the
              card always resolves to a real customer record. */}
          <div className={styles.modalRow} style={{ position: 'relative' }}>
            <label>Customer <span style={{ color: '#c53030' }}>*</span></label>
            <input
              type="text"
              className={styles.modalInput}
              value={query}
              disabled={customersLoading}
              placeholder={customersLoading ? 'Loading the directory…' : 'Search by name, email or phone'}
              onChange={e => { setQuery(e.target.value); setPicked(null); setListOpen(true); }}
              onFocus={() => setListOpen(true)}
            />
            {listOpen && !picked && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, maxHeight: 240,
                            overflowY: 'auto', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8,
                            boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }}>
                {matches.length === 0 ? (
                  <div style={{ padding: '10px 12px', fontSize: 12, color: '#a0aec0' }}>
                    No customer in the directory matches that.
                  </div>
                ) : matches.map(c => (
                  <button key={c.id} type="button" onClick={() => pick(c)}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 12px', border: 'none',
                             background: 'none', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid #f7fafc' }}>
                    <span style={{ fontWeight: 600, color: '#2d3748' }}>{c.full_name}</span>
                    <span style={{ color: '#718096' }}>{c.email ? ` · ${c.email}` : ''}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Everything the directory knows, pulled in with the selection. */}
          {picked && (
            <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '9px 11px', margin: '2px 0 10px',
                          display: 'flex', flexDirection: 'column', gap: 4, background: '#f7fafc' }}>
              {field('Email', payee?.email)}
              {field('Phone', payee?.phone)}
              {field('Address', [picked.address_line, picked.city, picked.region, picked.postal_code, picked.country]
                .filter(Boolean).join(', ') || null)}
              {field('Serials', picked.serials?.length ? picked.serials.join(', ') : null)}
              {field('Onboarded', picked.onboard_date)}
              {purchaser && (
                <div style={{ fontSize: 11, fontWeight: 600, color: '#975a16', background: '#fffbeb',
                              border: '1px solid #fbd38d', borderRadius: 6, padding: '4px 8px', marginTop: 2 }}>
                  ⚠ {picked.full_name} is a user, not the buyer — this refund books to {purchaser.full_name}.
                </div>
              )}
            </div>
          )}

          <div className={styles.modalRow}>
            <label>Reason for refund <span style={{ color: '#c53030' }}>*</span></label>
            <select value={category} onChange={e => setCategory(e.target.value as ReturnCategory)}
                    className={styles.modalInput}>
              <option value="">— select a reason —</option>
              {RETURN_CATEGORIES.map(c => (
                <option key={c} value={c}>{RETURN_CATEGORY_META[c].label}</option>
              ))}
            </select>
          </div>
          <div className={styles.modalRow}>
            <label>Reason detail (optional)</label>
            <input type="text" value={reasonDetail} onChange={e => setReasonDetail(e.target.value)}
                   className={styles.modalInput}
                   placeholder="What happened, in one line" />
          </div>

          <div className={styles.modalRow}>
            <label>Photos (optional)</label>
            <div onClick={() => fileRef.current?.click()}
              style={{ border: '1px dashed #cbd5e0', borderRadius: 8, padding: '10px 12px', cursor: 'pointer',
                       fontSize: 12, color: '#718096', background: '#fff' }}>
              Click to choose files, or paste an image — {files.length
                ? `${files.length} file${files.length > 1 ? 's' : ''} ready`
                : 'nothing attached yet'}
            </div>
            <input ref={fileRef} type="file" multiple accept={RETURN_ATTACH_INPUT_ACCEPT} style={{ display: 'none' }}
              onChange={e => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
            {files.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {files.map((f, i) => (
                  <span key={`${f.name}-${i}`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, background: '#edf2f7',
                             borderRadius: 999, padding: '3px 8px', color: '#4a5568' }}>
                    {f.name.slice(0, 24)}
                    <button type="button" onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))}
                      style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#a0aec0', fontSize: 12 }}>✕</button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className={styles.modalRow}>
            <label>Notes (optional)</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)}
                      className={styles.modalTextarea} rows={3}
                      placeholder="Context for whoever picks this up — more can be added at any stage on the card." />
          </div>

          <div style={{ fontSize: 12, color: '#718096', margin: '2px 0 0' }}>
            Opens in Completeness at what the customer paid on their sales invoice. Finance confirms
            the amount and sets the payment method at Finance Review.
          </div>
        </div>
        <div className={styles.modalFoot}>
          {step && <span style={{ fontSize: 12, color: '#718096', marginRight: 'auto' }}>{step}</span>}
          <button onClick={onClose} className={styles.modalSecondary}>Cancel</button>
          <button onClick={() => void submit()} disabled={!canSubmit} className={styles.modalPrimary}
                  title={!picked ? 'Pick a customer from the directory' : !category ? 'Choose a reason for the refund' : ''}>
            {submitting ? 'Creating…' : 'Create refund'}
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
  refund, linkedReturn, cancellationId = null, canWrite, onClose, onError, onMoved,
}: {
  refund: RefundApproval;
  linkedReturn: ReturnRow | null;
  cancellationId?: string | null;
  /** True when the signed-in user owns the column this card sits in. */
  canWrite: boolean;
  onClose: () => void;
  onError: (m: string | null) => void;
  /** Re-read the board after the approval lands — see RefundDetailPanel. */
  onMoved: () => Promise<void>;
}) {
  const [method, setMethod] = useState<RefundMethod>('shopify');
  const original = Number(refund.original_amount_usd ?? refund.refund_amount_usd);
  const [amountStr, setAmountStr] = useState(original.toFixed(2));
  const [note, setNote] = useState('');
  const [correctionNote, setCorrectionNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

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
      await onMoved();
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
          <CaseNotes
            refundId={refund.id}
            returnId={refund.return_id}
            cancellationId={cancellationId}
            canWrite={canWrite}
            ownerLabel={refundColumnOwnerLabel(refund.status)}
            variant="panel"
            label="Notes for approvers"
            emptyHint="No notes yet — save context here without approving."
            placeholder="Add a note for approvers (saved immediately, no approval needed)…"
            onError={m => { setLocalError(m); onError(m); }}
          />
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
