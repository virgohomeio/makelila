import { useMemo, useState } from 'react';
import {
  useRefundApprovals, useReturns,
  submitRefundRequest, managerApprove, financeApprove, denyRefund, closeRefund,
  canApproveManager, canApproveFinance,
  REFUND_STATUS_META,
  type RefundApproval, type ReturnRow,
} from '../../lib/postShipment';
import { useAuth } from '../../lib/auth';
import styles from './PostShipment.module.css';

const STAR = '★';

type ColKey = 'manager_review' | 'finance_review' | 'refunded' | 'denied';

const COLUMNS: { key: ColKey; label: string; helper: string }[] = [
  { key: 'manager_review', label: 'Manager review',  helper: 'Awaiting George' },
  { key: 'finance_review', label: 'Finance review',  helper: 'Awaiting Julie' },
  { key: 'refunded',       label: 'Refunded',        helper: 'Payment processed' },
  { key: 'denied',         label: 'Denied',          helper: 'Rejected at any stage' },
];

export function RefundsTab() {
  const { approvals, loading: aLoading } = useRefundApprovals();
  const { returns, loading: rLoading } = useReturns();
  const { user } = useAuth();
  const userEmail = user?.email;

  const [showRequestModal, setShowRequestModal] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isManager = canApproveManager(userEmail);
  const isFinance = canApproveFinance(userEmail);

  const returnsById = useMemo(() => {
    const m = new Map<string, ReturnRow>();
    for (const r of returns) m.set(r.id, r);
    return m;
  }, [returns]);

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
        a.status === 'refunded' ? 'refunded' :
        a.status === 'denied' ? 'denied' :
        null;
      if (k) m.get(k)!.push(a);
    }
    return m;
  }, [approvals]);

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

      <div className={styles.kanban}>
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
                    canManager={isManager}
                    canFinance={isFinance}
                    selected={selectedId === r.id}
                    onSelect={() => setSelectedId(prev => prev === r.id ? null : r.id)}
                    onError={setError}
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
          canManager={isManager}
          canFinance={isFinance}
          onClose={() => setSelectedId(null)}
          onError={setError}
        />
      )}

      {showRequestModal && (
        <RequestRefundModal
          returns={returns}
          onClose={() => setShowRequestModal(false)}
          onError={setError}
        />
      )}
    </div>
  );
}

// ============================================================================
// Refund card
// ============================================================================
function RefundCard({
  refund, canManager, canFinance, selected, onSelect, onError,
}: {
  refund: RefundApproval;
  canManager: boolean;
  canFinance: boolean;
  selected: boolean;
  onSelect: () => void;
  onError: (msg: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const meta = REFUND_STATUS_META[refund.status];

  const runApprove = async () => {
    setBusy(true); onError(null);
    try {
      if (refund.status === 'manager_review' || refund.status === 'submitted') {
        const note = window.prompt('Manager approval note (optional):') ?? undefined;
        await managerApprove(refund.id, note);
      } else if (refund.status === 'finance_review') {
        const note = window.prompt('Finance approval note (e.g. Stripe refund ID):') ?? undefined;
        await financeApprove(refund.id, note);
      }
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  const runDeny = async () => {
    const reason = window.prompt('Reason for denial (required):');
    if (!reason) return;
    setBusy(true); onError(null);
    try {
      const stage = refund.status === 'finance_review' ? 'finance_review' : 'manager_review';
      await denyRefund(refund.id, stage, reason);
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  const runClose = async () => {
    setBusy(true); onError(null);
    try { await closeRefund(refund.id); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  const canActManager = (refund.status === 'manager_review' || refund.status === 'submitted') && canManager;
  const canActFinance = refund.status === 'finance_review' && canFinance;
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
        <span className={styles.refundAmount}>${Number(refund.refund_amount_usd).toLocaleString('en-US')}</span>
      </div>
      {refund.reason && <div className={styles.refundReason}>{refund.reason}</div>}
      {refund.payment_method && <div className={styles.refundMeta}>via {refund.payment_method}</div>}
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
            label="Finance ✓ Paid"
            ts={refund.finance_approved_at}
            note={refund.finance_decision_note}
            active
          />
        )}
        {refund.denied_at && (
          <RefundStep
            label={`Denied @ ${refund.denied_at_stage}`}
            ts={refund.denied_at}
            note={refund.denied_reason}
            negative
            active
          />
        )}
      </div>
      <div className={styles.refundActions} onClick={e => e.stopPropagation()}>
        {(canActManager || canActFinance) && (
          <button onClick={() => void runApprove()} disabled={busy}
                  className={styles.refundApproveBtn}>
            {busy ? '…' : canActManager ? 'Approve (manager)' : 'Approve (finance, paid)'}
          </button>
        )}
        {canDeny && (
          <button onClick={() => void runDeny()} disabled={busy} className={styles.refundDenyBtn}>
            Deny
          </button>
        )}
        {refund.status === 'refunded' && (
          <button onClick={() => void runClose()} disabled={busy} className={styles.refundCloseBtn}>
            Close
          </button>
        )}
      </div>
      {!selected && (
        <div className={styles.refundCardHint}>Click to review full return form ↓</div>
      )}
    </div>
  );
}

// ============================================================================
// Detail panel — shown below the Kanban when a card is selected.
// Renders the linked return-form data + approve / deny actions.
// ============================================================================
function RefundDetailPanel({
  refund, linkedReturn, canManager, canFinance, onClose, onError,
}: {
  refund: RefundApproval;
  linkedReturn: ReturnRow | null;
  canManager: boolean;
  canFinance: boolean;
  onClose: () => void;
  onError: (msg: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const meta = REFUND_STATUS_META[refund.status];

  const canActManager = (refund.status === 'manager_review' || refund.status === 'submitted') && canManager;
  const canActFinance = refund.status === 'finance_review' && canFinance;
  const canAct = canActManager || canActFinance;

  const runApprove = async () => {
    setBusy(true); onError(null);
    try {
      if (canActManager) {
        const note = window.prompt('Manager approval note (optional):') ?? undefined;
        await managerApprove(refund.id, note);
      } else if (canActFinance) {
        const note = window.prompt('Finance approval note (e.g. Stripe refund ID):') ?? undefined;
        await financeApprove(refund.id, note);
      }
      onClose();
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  const runDeny = async () => {
    const reason = window.prompt('Reason for denial (required):');
    if (!reason) return;
    setBusy(true); onError(null);
    try {
      const stage = refund.status === 'finance_review' ? 'finance_review' : 'manager_review';
      await denyRefund(refund.id, stage, reason);
      onClose();
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className={styles.refundDetail}>
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
        </div>
        <button onClick={onClose} className={styles.refundDetailClose} title="Close detail">✕</button>
      </div>

      {!linkedReturn ? (
        <div className={styles.refundDetailEmpty}>
          This refund isn't linked to a return record. No customer form data to display.
        </div>
      ) : (
        <div className={styles.refundDetailGrid}>
          <DetailField label="Order #" value={linkedReturn.original_order_ref ?? '—'} mono />
          <DetailField label="Unit serial" value={linkedReturn.unit_serial ?? '—'} mono />
          <DetailField label="Channel" value={linkedReturn.channel ?? '—'} />
          <DetailField label="Source" value={linkedReturn.source ?? '—'} />
          <DetailField label="Usage duration" value={linkedReturn.usage_duration ?? '—'} />
          <DetailField label="Condition" value={linkedReturn.condition ?? '—'} />
          <DetailField label="Packaging" value={linkedReturn.packaging_status ?? '—'} />
          <DetailField label="Alternative composting" value={linkedReturn.alternative_composting ?? '—'} />
          <DetailField label="Refund preference" value={linkedReturn.refund_method_preference ?? '—'} />
          <DetailField label="Refund contact" value={linkedReturn.refund_contact ?? '—'} mono />
          <DetailField label="Future LILA likelihood" value={linkedReturn.future_likelihood ?? '—'} />
          <DetailField
            label="Experience rating"
            value={
              linkedReturn.experience_rating
                ? `${STAR.repeat(linkedReturn.experience_rating)}${'☆'.repeat(5 - linkedReturn.experience_rating)} (${linkedReturn.experience_rating}/5)`
                : '—'
            }
          />

          <DetailField label="Selected reasons" wide>
            {linkedReturn.return_reasons && linkedReturn.return_reasons.length > 0 ? (
              <div className={styles.reasonTags}>
                {linkedReturn.return_reasons.map(r => (
                  <span key={r} className={styles.reasonTag}>{r}</span>
                ))}
              </div>
            ) : '—'}
          </DetailField>

          <DetailField label="Support contacted" wide value={linkedReturn.support_contacted ?? '—'} />

          <DetailField label="Issue description" wide>
            <div className={styles.detailQuote}>{linkedReturn.description ?? '—'}</div>
          </DetailField>

          {linkedReturn.would_change_decision && (
            <DetailField label="What would've changed their mind" wide>
              <div className={styles.detailQuote}>{linkedReturn.would_change_decision}</div>
            </DetailField>
          )}

          {linkedReturn.additional_comments && (
            <DetailField label="Additional comments" wide>
              <div className={styles.detailQuote}>{linkedReturn.additional_comments}</div>
            </DetailField>
          )}
        </div>
      )}

      <div className={styles.refundDetailActions}>
        <div className={styles.refundDetailRolePill}>
          {canActManager ? 'You can act as Manager for this case' :
           canActFinance ? 'You can act as Finance for this case' :
           refund.status === 'refunded' ? 'Refunded — no action needed' :
           refund.status === 'denied'   ? 'Denied — no action needed' :
           refund.status === 'closed'   ? 'Closed — no action needed' :
                                          'Not your stage — view only'}
        </div>
        <div className={styles.refundDetailButtons}>
          {canAct && (
            <button onClick={() => void runApprove()} disabled={busy}
                    className={styles.refundDetailApproveBtn}>
              {busy ? '…' : canActManager ? '✓ Approve as Manager' : '✓ Approve as Finance (paid)'}
            </button>
          )}
          {canAct && (
            <button onClick={() => void runDeny()} disabled={busy}
                    className={styles.refundDetailDenyBtn}>
              ✕ Deny
            </button>
          )}
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
  returns, onClose, onError,
}: {
  returns: ReturnRow[];
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

  // Surface returns that are received/inspected and don't already have a
  // refund_approval row downstream — those are the natural ones to request
  // a refund on. (We don't enforce this; CS can still type a freeform name.)
  const eligibleReturns = useMemo(
    () => returns.filter(r => ['received', 'inspected'].includes(r.status))
      .sort((a, b) => (b.created_at).localeCompare(a.created_at)),
    [returns],
  );

  const onReturnChange = (id: string) => {
    setReturnId(id);
    const r = returns.find(x => x.id === id);
    if (r) {
      setCustomerName(r.customer_name);
      setCustomerEmail(r.customer_email ?? '');
      if (r.refund_amount_usd) setAmount(String(r.refund_amount_usd));
      if (r.reason) setReason(r.reason);
    }
  };

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
