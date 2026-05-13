import { useMemo, useState } from 'react';
import {
  useOrderCancellations, processCancellation,
  CANCELLATION_STATUS_META,
  type OrderCancellation,
} from '../../lib/postShipment';
import styles from './PostShipment.module.css';

type Filter = 'all' | 'open' | 'closed';

export function CancellationsTab() {
  const { cancellations, loading } = useOrderCancellations();
  const [filter, setFilter] = useState<Filter>('open');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cancellations.filter(c => {
      if (filter === 'open' && c.status === 'completed') return false;
      if (filter === 'closed' && c.status !== 'completed') return false;
      if (q && !(
        c.customer_name.toLowerCase().includes(q) ||
        c.customer_email.toLowerCase().includes(q) ||
        c.order_ref?.toLowerCase().includes(q) ||
        c.reason?.toLowerCase().includes(q)
      )) return false;
      return true;
    });
  }, [cancellations, filter, search]);

  const stats = useMemo(() => {
    const s = { total: 0, open: 0, completed: 0, received: 0, sumAmount: 0 };
    for (const c of cancellations) {
      s.total++;
      if (c.status === 'submitted') s.open++;
      if (c.status === 'completed') s.completed++;
      if (c.product_received)       s.received++;
      if (c.order_amount_usd)       s.sumAmount += Number(c.order_amount_usd);
    }
    return s;
  }, [cancellations]);

  const selected = useMemo(
    () => cancellations.find(c => c.id === selectedId) ?? null,
    [cancellations, selectedId],
  );

  if (loading) return <div className={styles.loading}>Loading cancellations…</div>;

  return (
    <div className={styles.tabContent}>
      <div className={styles.kpiRow}>
        <KPI label="Awaiting processing" value={stats.open} tone={stats.open > 0 ? 'warn' : undefined}
             sub={stats.open > 0 ? 'click to process' : 'queue clear'} />
        <KPI label="Completed" value={stats.completed} sub="cancelled + refund routed" />
        <KPI label="Already received" value={stats.received}
             sub={stats.received > 0 ? 'consider Returns' : 'all pre-ship'} />
        <KPI label="Total cancellation $" value={`$${Math.round(stats.sumAmount).toLocaleString('en-US')}`}
             sub={`${stats.total} total requests`} />
      </div>

      <div className={styles.filterBar}>
        {(['open','closed','all'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`${styles.chip} ${filter === f ? styles.chipActive : ''}`}
          >{f === 'open' ? 'Open' : f === 'closed' ? 'Closed' : 'All'}</button>
        ))}
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search customer, order #, email, reason…"
          className={styles.searchInput}
        />
        <div className={styles.resultCount}>{rows.length} {rows.length === 1 ? 'row' : 'rows'}</div>
      </div>

      {error && <div className={styles.errorBar}>{error}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Submitted</th>
              <th>Customer</th>
              <th>Order #</th>
              <th>Amount</th>
              <th>Received?</th>
              <th>Reason</th>
              <th>Resolution wanted</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(c => {
              const meta = CANCELLATION_STATUS_META[c.status];
              return (
                <tr
                  key={c.id}
                  className={`${styles.cancellationRow} ${selectedId === c.id ? styles.cancellationRowSelected : ''}`}
                  onClick={() => setSelectedId(prev => prev === c.id ? null : c.id)}
                >
                  <td className={styles.mono}>{formatDate(c.created_at)}</td>
                  <td><strong>{c.customer_name}</strong><br /><span className={styles.muted}>{c.customer_email}</span></td>
                  <td className={styles.mono}>{c.order_ref ?? '—'}</td>
                  <td className={styles.mono}>{c.order_amount_usd ? `$${Number(c.order_amount_usd).toLocaleString('en-US')}` : <span className={styles.muted}>—</span>}</td>
                  <td>{c.product_received === null ? <span className={styles.muted}>—</span> : c.product_received ? 'Yes' : 'No'}</td>
                  <td>{c.reason ?? <span className={styles.muted}>—</span>}</td>
                  <td>{c.desired_resolution ?? <span className={styles.muted}>—</span>}</td>
                  <td>
                    <span className={styles.cancStatusPill}
                          style={{ color: meta.color, background: meta.bg, borderColor: meta.border }}>
                      {meta.label}
                    </span>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={8} className={styles.empty}>No cancellations match the filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <CancellationDetail
          cancellation={selected}
          onClose={() => setSelectedId(null)}
          onError={setError}
        />
      )}
    </div>
  );
}

// ============================================================================
// Detail panel
// ============================================================================
function CancellationDetail({
  cancellation: c, onClose, onError,
}: {
  cancellation: OrderCancellation;
  onClose: () => void;
  onError: (m: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const meta = CANCELLATION_STATUS_META[c.status];

  const canAct = c.status === 'submitted';

  const runProcess = async () => {
    // Money already collected? Spawn a refund_approval. Pre-charge cancel
    // (e.g. abandoned during checkout) → mark completed only, no refund.
    const refundConfirm = window.confirm(
      `Process cancellation for ${c.customer_name}?\n\nClick OK if payment was already collected — this creates a refund_approval (manager_review) for $${c.order_amount_usd ?? 0}.\nClick Cancel if no money needs to be refunded (e.g. pre-charge cancel).`
    );
    const opsNote = window.prompt('Ops note (optional):') ?? undefined;
    setBusy(true); onError(null);
    try {
      await processCancellation(c.id, refundConfirm, undefined, opsNote);
      onClose();
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className={styles.refundDetail}>
      <div className={styles.refundDetailHead}>
        <div>
          <div className={styles.refundDetailTitleRow}>
            <h3 className={styles.refundDetailTitle}>{c.customer_name}</h3>
            <span
              className={styles.refundDetailStatusPill}
              style={{ color: meta.color, background: meta.bg, borderColor: meta.border }}
            >{meta.label}</span>
          </div>
          <div className={styles.refundDetailSub}>
            {c.order_ref ?? '—'} · {c.customer_email} · {c.customer_phone ?? '—'} ·
            {' '}Preferred contact: <strong>{c.preferred_contact ?? '—'}</strong>
          </div>
        </div>
        <button onClick={onClose} className={styles.refundDetailClose} title="Close detail">✕</button>
      </div>

      <div className={styles.refundDetailGrid}>
        <DetailField label="Order ref" value={c.order_ref ?? '—'} mono />
        <DetailField label="Order date" value={c.order_date ?? '—'} mono />
        <DetailField label="Product" value={c.product_name ?? '—'} />
        <DetailField label="Order amount" value={c.order_amount_usd ? `$${Number(c.order_amount_usd).toLocaleString('en-US')}` : '—'} mono />
        <DetailField label="Purchase channel" value={c.purchase_channel ?? '—'} />
        <DetailField label="Received product?" value={c.product_received === null ? '—' : c.product_received ? 'Yes — has the unit' : 'No — pre-ship'} />

        <DetailField label="Reason for cancellation" wide value={c.reason ?? '—'} />
        <DetailField label="Desired resolution" wide value={c.desired_resolution ?? '—'} />

        {c.description && (
          <DetailField label="Detailed explanation" wide>
            <div className={styles.detailQuote}>{c.description}</div>
          </DetailField>
        )}

        {c.ops_notes && (
          <DetailField label="Ops notes" wide>
            <div className={styles.detailQuote}>{c.ops_notes}</div>
          </DetailField>
        )}

        {c.processed_at && (
          <DetailField
            label={`Processed by ops`}
            wide
            value={`${new Date(c.processed_at).toLocaleString('en-US')}${c.refund_approval_id ? ` · Linked refund: ${c.refund_approval_id.slice(0, 8)}…` : ''}`}
          />
        )}
      </div>

      <div className={styles.refundDetailActions}>
        <div className={styles.refundDetailRolePill}>
          {c.product_received
            ? '⚠ Customer says they received the unit — consider routing through Returns instead.'
            : canAct
              ? 'Cancellations are always accepted. Process to cancel the order and route any refund.'
              : 'Completed — view only.'}
        </div>
        <div className={styles.refundDetailButtons}>
          {canAct && (
            <button onClick={() => void runProcess()} disabled={busy}
                    className={styles.refundDetailApproveBtn}>
              {busy ? '…' : '✓ Process cancellation'}
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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' });
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

