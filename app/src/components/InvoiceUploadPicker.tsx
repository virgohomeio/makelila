import { useRef, useState } from 'react';
import { uploadInvoiceForCustomer, type InvoiceDocType } from '../lib/invoices';
import { ShippingInvoiceForm } from './ShippingInvoices';
import styles from './ShippingInvoices.module.css';

// Customer profile: one "Upload invoice" button that opens either the sales
// invoice / refund receipt upload or the shipping invoice form.

type Kind = 'sales' | 'shipping';

export function InvoiceUploadPicker({
  customerId, onUploaded,
}: {
  customerId: string;
  /** Fired after either kind is saved, so the lists above can reload. */
  onUploaded: (kind: Kind) => void;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind | null>(null);

  if (!open) {
    return (
      <div className={styles.uploadPicker}>
        <div>
          <button className={styles.primaryBtn} onClick={() => setOpen(true)}>Upload invoice</button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.uploadPicker}>
      <div className={styles.choiceRow}>
        <span className={styles.muted}>Which kind?</span>
        <button className={kind === 'sales' ? styles.choiceBtnActive : styles.choiceBtn}
                onClick={() => setKind('sales')}>Sales invoice</button>
        <button className={kind === 'shipping' ? styles.choiceBtnActive : styles.choiceBtn}
                onClick={() => setKind('shipping')}>Shipping invoice</button>
        <button className={styles.linkBtn} onClick={() => { setOpen(false); setKind(null); }}>Close</button>
      </div>
      {kind === 'sales' && (
        <SalesInvoiceUploadForm customerId={customerId} onSaved={() => onUploaded('sales')} />
      )}
      {kind === 'shipping' && (
        <ShippingInvoiceForm customerId={customerId} onSaved={() => onUploaded('shipping')} />
      )}
    </div>
  );
}

function SalesInvoiceUploadForm({
  customerId, onSaved,
}: {
  customerId: string;
  onSaved: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [docType, setDocType] = useState<InvoiceDocType>('invoice');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const submit = async () => {
    if (!file) { setErr('Choose the PDF first.'); return; }
    setBusy(true); setErr(null); setOk(null);
    try {
      const res = await uploadInvoiceForCustomer(file, docType, customerId);
      if (!res.ok || !res.invoice) throw new Error(res.error ?? 'Upload failed');
      const inv = res.invoice;
      setOk(`Saved ${docType === 'refund_receipt' ? 'refund receipt' : 'invoice'} #${inv.invoice_number}`
        + (inv.order_ref ? ` (order ${inv.order_ref})` : '')
        + (res.extract_error ? ` — couldn't read every field: ${res.extract_error}` : '.'));
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.form}>
      <label className={styles.field}>
        Document
        <select className={styles.input} value={docType} onChange={e => setDocType(e.target.value as InvoiceDocType)}>
          <option value="invoice">Sales invoice</option>
          <option value="refund_receipt">Refund receipt</option>
        </select>
      </label>
      <label className={styles.fieldWide}>
        Invoice PDF
        <input ref={fileRef} type="file" accept="application/pdf" className={styles.input}
               onChange={e => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <div className={styles.hint}>
        The invoice number, date, total and order # are read from the PDF, and it is filed under this customer.
      </div>
      <div className={styles.actions}>
        <button className={styles.primaryBtn} disabled={busy || !file} onClick={() => void submit()}>
          {busy ? 'Uploading…' : 'Upload sales invoice'}
        </button>
        {err && <span className={styles.error}>{err}</span>}
        {ok && <span className={styles.ok}>{ok}</span>}
      </div>
    </div>
  );
}
