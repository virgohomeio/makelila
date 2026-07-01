import { useMemo, useRef, useState } from 'react';
import {
  bulkUploadAndMatch, useReviewQueueInvoices, assignInvoice, getInvoiceSignedUrl, deleteInvoice,
  type BulkUploadResult, type CustomerInvoice, type InvoiceDocType, type InvoiceMatchStatus,
} from '../../lib/invoices';
import { useCustomers } from '../../lib/customers';
import { useOrders } from '../../lib/orders';
import styles from './Upload.module.css';

// What can be uploaded. Extensible — add a kind here and (if it's not an
// invoice-shaped PDF) branch the handler. For now both kinds flow through the
// invoice matcher; document_type just tags the stored row.
type UploadKind = {
  key: string;
  label: string;
  description: string;
  accept: string;
  documentType: InvoiceDocType;
};

const UPLOAD_KINDS: UploadKind[] = [
  {
    key: 'sales_invoice',
    label: 'Sales invoices',
    description: 'Bulk-upload QuickBooks invoice PDFs. Each is auto-matched to its sales order + customer by the Shopify order # printed on it.',
    accept: 'application/pdf',
    documentType: 'invoice',
  },
  {
    key: 'refund_receipt',
    label: 'Refund receipts',
    description: 'Refund receipt PDFs — matched the same way and filed under the customer + order.',
    accept: 'application/pdf',
    documentType: 'refund_receipt',
  },
];

export default function Upload() {
  const [kindKey, setKindKey] = useState(UPLOAD_KINDS[0].key);
  const kind = UPLOAD_KINDS.find(k => k.key === kindKey) ?? UPLOAD_KINDS[0];
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<BulkUploadResult[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const { customers } = useCustomers();
  const customerName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of customers) m.set(c.id, c.full_name || c.email || c.id);
    return m;
  }, [customers]);

  const { invoices: reviewQueue, loading: queueLoading, reload: reloadQueue } = useReviewQueueInvoices();

  const onPick = (list: FileList | null) => {
    if (!list) return;
    setFiles(Array.from(list).filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')));
  };

  const run = async () => {
    if (files.length === 0) return;
    setBusy(true); setResults(null);
    try {
      const r = await bulkUploadAndMatch(files, kind.documentType);
      setResults(r);
      setFiles([]);
      if (fileInput.current) fileInput.current.value = '';
      void reloadQueue();
    } finally {
      setBusy(false);
    }
  };

  const matchedCount = results?.filter(r => r.ok && r.invoice?.match_status === 'matched').length ?? 0;
  const reviewCount  = results?.filter(r => r.ok && r.invoice?.match_status !== 'matched').length ?? 0;
  const failedCount  = results?.filter(r => !r.ok).length ?? 0;

  return (
    <div className={styles.layout}>
      <div className={styles.header}>
        <h2 className={styles.title}>Upload</h2>
        <p className={styles.subtitle}>
          Bulk-upload files and let makelila file them automatically. Pick what you're uploading, drop the files, and they're matched to the right records.
        </p>
      </div>

      <div className={styles.kindRow}>
        {UPLOAD_KINDS.map(k => (
          <button
            key={k.key}
            className={`${styles.kindChip} ${k.key === kindKey ? styles.kindChipActive : ''}`}
            onClick={() => { setKindKey(k.key); setResults(null); }}
          >
            {k.label}
          </button>
        ))}
      </div>

      <div className={styles.dropCard}>
        <div className={styles.kindDesc}>{kind.description}</div>
        <input
          ref={fileInput}
          type="file"
          accept={kind.accept}
          multiple
          onChange={e => onPick(e.target.files)}
          className={styles.fileInput}
        />
        {files.length > 0 && (
          <div className={styles.pickedList}>
            {files.length} file{files.length === 1 ? '' : 's'} selected: {files.map(f => f.name).join(', ')}
          </div>
        )}
        <button onClick={() => void run()} disabled={busy || files.length === 0} className={styles.uploadBtn}>
          {busy ? `Uploading & matching ${files.length}…` : `Upload & match ${files.length || ''}`.trim()}
        </button>
      </div>

      {results && (
        <div className={styles.resultsCard}>
          <div className={styles.resultsSummary}>
            <span className={styles.badgeMatched}>{matchedCount} matched</span>
            <span className={styles.badgeReview}>{reviewCount} need review</span>
            {failedCount > 0 && <span className={styles.badgeFailed}>{failedCount} failed</span>}
          </div>
          <table className={styles.table}>
            <thead>
              <tr><th>File</th><th>Invoice #</th><th>Order</th><th>Customer</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i}>
                  <td className={styles.fileCell} title={r.file_name}>{r.file_name}</td>
                  <td>{r.invoice?.invoice_number ?? '—'}</td>
                  <td className={styles.mono}>{r.invoice?.order_ref ?? '—'}</td>
                  <td>{r.ok ? (r.invoice?.customer_id ? (customerName.get(r.invoice.customer_id) ?? '—') : (r.invoice?.bill_to_name ?? '—')) : '—'}</td>
                  <td>{r.ok && r.invoice ? <StatusBadge status={r.invoice.match_status} /> : <span className={styles.badgeFailed}>failed</span>}</td>
                  <td>{r.ok && r.invoice ? <ViewLink path={r.invoice.storage_path} /> : <span className={styles.errText} title={r.error}>{r.error}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ReviewQueue
        invoices={reviewQueue}
        loading={queueLoading}
        customers={customers}
        customerName={customerName}
        onAssigned={reloadQueue}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: InvoiceMatchStatus }) {
  if (status === 'matched')      return <span className={styles.badgeMatched}>matched</span>;
  if (status === 'needs_review') return <span className={styles.badgeReview}>needs review</span>;
  return <span className={styles.badgeUnassigned}>unassigned</span>;
}

function ViewLink({ path }: { path: string }) {
  const open = async () => {
    try {
      const url = await getInvoiceSignedUrl(path);
      window.open(url, '_blank', 'noopener');
    } catch (e) { alert((e as Error).message); }
  };
  return <button className={styles.linkBtn} onClick={() => void open()}>View PDF</button>;
}

// The review queue: invoices the matcher couldn't confidently file. Operator
// types the Shopify order # — we resolve it against the loaded orders list to
// get the order + its customer in one step (every invoice carries an order #).
const CUST_DATALIST_ID = 'upload-customer-list';

function ReviewQueue({
  invoices, loading, customers, customerName, onAssigned,
}: {
  invoices: CustomerInvoice[];
  loading: boolean;
  customers: { id: string; full_name: string; email: string | null }[];
  customerName: Map<string, string>;
  onAssigned: () => void;
}) {
  const { all: orders } = useOrders();
  const ordersByRef = useMemo(() => {
    const m = new Map<string, { id: string; ref: string; customerId: string | null }>();
    for (const o of orders) {
      m.set(o.order_ref.replace(/^#/, ''), { id: o.id, ref: o.order_ref, customerId: o.customer_id });
    }
    return m;
  }, [orders]);

  // Datalist options + a resolver so the operator can type a customer name and
  // we can map it back to an id. Keyed by label, email and full_name so a typed
  // name, an email, or a picked-from-list label all resolve.
  const custLabel = (c: { full_name: string; email: string | null }) =>
    c.email ? `${c.full_name} (${c.email})` : c.full_name;
  const custOptions = useMemo(
    () => customers.map(c => custLabel(c)).filter(Boolean).sort(),
    [customers],
  );
  const custResolve = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of customers) {
      if (c.full_name) m.set(custLabel(c).toLowerCase(), c.id);
      if (c.full_name) m.set(c.full_name.toLowerCase(), c.id);
      if (c.email) m.set(c.email.toLowerCase(), c.id);
    }
    return m;
  }, [customers]);

  if (loading) return <div className={styles.queueCard}><div className={styles.queueTitle}>Needs review</div><div className={styles.emptyRow}>Loading…</div></div>;

  return (
    <div className={styles.queueCard}>
      <div className={styles.queueTitle}>Needs review ({invoices.length})</div>
      <datalist id={CUST_DATALIST_ID}>
        {custOptions.map(o => <option key={o} value={o} />)}
      </datalist>
      {invoices.length === 0 ? (
        <div className={styles.emptyRow}>Nothing waiting — every uploaded invoice has been filed.</div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr><th>File</th><th>Invoice #</th><th>Bill to</th><th>Parsed order</th><th>Current customer</th><th>Assign to order # and/or customer</th><th></th></tr>
          </thead>
          <tbody>
            {invoices.map(inv => (
              <ReviewRow
                key={inv.id}
                inv={inv}
                ordersByRef={ordersByRef}
                custResolve={custResolve}
                customerName={customerName}
                onAssigned={onAssigned}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ReviewRow({
  inv, ordersByRef, custResolve, customerName, onAssigned,
}: {
  inv: CustomerInvoice;
  ordersByRef: Map<string, { id: string; ref: string; customerId: string | null }>;
  custResolve: Map<string, string>;
  customerName: Map<string, string>;
  onAssigned: () => void;
}) {
  const [orderRef, setOrderRef] = useState(inv.order_ref?.replace(/^#/, '') ?? '');
  const [custText, setCustText] = useState(inv.customer_id ? (customerName.get(inv.customer_id) ?? '') : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Order # and customer are independent. Fill either or both: an order # links
  // the order (and defaults the customer to that order's customer); a typed
  // customer overrides it — for the husband-ordered / wife-owns-it case, put the
  // husband's order # AND the wife's name and it files under both.
  const assign = async () => {
    const orderTyped = orderRef.trim();
    const custTyped = custText.trim();
    if (!orderTyped && !custTyped) { setErr('Enter an order # or a customer'); return; }

    const params: { orderId?: string; orderRef?: string; customerId?: string } = {};
    if (orderTyped) {
      const digits = orderTyped.replace(/\D/g, '');
      const match = digits ? ordersByRef.get(digits) : null;
      if (!match) { setErr(`No order #${digits}`); return; }
      params.orderId = match.id;
      params.orderRef = match.ref;
      if (match.customerId) params.customerId = match.customerId;
    }
    if (custTyped) {
      const cid = custResolve.get(custTyped.toLowerCase());
      if (!cid) { setErr('Pick a customer from the list'); return; }
      params.customerId = cid;   // overrides the order's customer
    }

    setBusy(true); setErr(null);
    try {
      await assignInvoice(inv.id, params);
      onAssigned();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Cancel/remove a mistakenly-uploaded invoice: deletes the row + the stored
  // PDF so it leaves the queue entirely.
  const remove = async () => {
    if (!window.confirm(`Remove "${inv.file_name}"? This deletes the uploaded file.`)) return;
    setBusy(true); setErr(null);
    try {
      await deleteInvoice(inv.id, inv.storage_path);
      onAssigned();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <tr>
      <td className={styles.fileCell} title={inv.file_name}>{inv.file_name}</td>
      <td>{inv.invoice_number}</td>
      <td>{inv.bill_to_name ?? '—'}</td>
      <td className={styles.mono}>{inv.order_ref ?? '—'}</td>
      <td>{inv.customer_id ? (customerName.get(inv.customer_id) ?? '—') : <span className={styles.muted}>unassigned</span>}</td>
      <td>
        <div className={styles.assignFields}>
          <input
            className={styles.orderInput}
            value={orderRef}
            onChange={e => setOrderRef(e.target.value)}
            placeholder="order # e.g. 1192"
          />
          <input
            className={styles.custInput}
            list={CUST_DATALIST_ID}
            value={custText}
            onChange={e => setCustText(e.target.value)}
            placeholder="customer name"
          />
        </div>
      </td>
      <td>
        <button className={styles.assignBtn} disabled={busy} onClick={() => void assign()}>
          {busy ? '…' : 'Assign'}
        </button>
        <ViewLink path={inv.storage_path} />
        <button className={styles.removeBtn} disabled={busy} onClick={() => void remove()}>Remove</button>
        {err && <div className={styles.errText}>{err}</div>}
      </td>
    </tr>
  );
}
