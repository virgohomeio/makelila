import { useEffect, useRef, useState } from 'react';
import {
  useCustomerShippingInvoices, uploadShippingInvoice, deleteShippingInvoice,
  openShippingInvoice, useProfitabilityAdjustment, saveProfitabilityAdjustment,
  extractShippingInvoice, fetchCustomerOrderOptions, guessOrderRef, updateShippingInvoice,
  type CustomerShippingInvoice, type ShippingCurrency, type CustomerOrderOption,
} from '../lib/shippingInvoices';
import styles from './ShippingInvoices.module.css';

// Shared by Customers (profile panel), Customers › Profitability (detail
// panel) and Upload (Shipping invoices kind) — one customer's shipping
// invoices, with an upload form.

const ACCEPT = 'application/pdf,image/png,image/jpeg,image/heic,image/webp';
const CARRIERS = ['UPS', 'Freightcom', 'Goorooship', 'FedEx', 'Canpar', 'GLS', 'Purolator', 'Canada Post', 'USPS', 'Other'];

/** Map whatever the invoice reader called the carrier onto the picker. */
function matchCarrier(name: string | null): string | null {
  if (!name) return null;
  const n = name.toLowerCase();
  if (n.includes('clickship')) return 'Freightcom';
  if (n.includes('united parcel')) return 'UPS';
  if (n.includes('federal express')) return 'FedEx';
  if (n.includes('postal service')) return 'USPS';
  return CARRIERS.find(c => c !== 'Other' && n.includes(c.toLowerCase())) ?? 'Other';
}

const OTHER_ORDER = '__other__';

function orderLabel(o: CustomerOrderOption): string {
  const model = o.p100x ? 'P100X' : (o.batches.length ? o.batches.join('/') : null);
  return [
    o.order_ref,
    o.date,
    o.kind === 'replacement' ? 'replacement' : null,
    model ? `${model} · ${o.items}` : o.items,
    `→ ${o.destination}`,
    o.status === 'cancelled' ? '(cancelled)' : null,
  ].filter(Boolean).join(' · ');
}

function money(v: number, currency: ShippingCurrency): string {
  return `${currency === 'USD' ? 'US$' : '$'}${v.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Parse a money input; blank → 0, junk → NaN so the form can refuse it. */
function parseAmount(s: string): number {
  const t = s.replace(/[$,\s]/g, '');
  if (!t) return 0;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

export function CustomerShippingInvoices({
  customerId, onChanged, showForm = true, reloadSignal = 0,
}: {
  customerId: string;
  /** Fired after an upload, edit or delete, e.g. to refresh profitability. */
  onChanged?: () => void;
  showForm?: boolean;
  /** Bump to reload, e.g. after an upload made outside this component. */
  reloadSignal?: number;
}) {
  const { invoices, loading, error, reload } = useCustomerShippingInvoices(customerId);
  const [opening, setOpening] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => { if (reloadSignal) void reload(); }, [reloadSignal, reload]);

  const changed = () => { void reload(); onChanged?.(); };

  const remove = async (inv: CustomerShippingInvoice) => {
    const label = inv.invoice_number || inv.file_name || 'this invoice';
    if (!window.confirm(`Remove shipping invoice ${label}? This also deletes the uploaded file.`)) return;
    try { await deleteShippingInvoice(inv); changed(); }
    catch (e) { alert((e as Error).message); }
  };

  const view = async (path: string) => {
    setOpening(true);
    try { await openShippingInvoice(path); }
    catch (e) { alert((e as Error).message); }
    finally { setOpening(false); }
  };

  return (
    <div className={styles.wrap}>
      {loading ? (
        <div className={styles.empty}>Loading shipping invoices…</div>
      ) : error ? (
        <div className={styles.error}>{error}</div>
      ) : invoices.length === 0 ? (
        <div className={styles.empty}>No shipping invoices on file for this customer.</div>
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date</th><th>Carrier</th><th>Invoice #</th><th>Order</th>
                <th className={styles.num}>Freight</th>
                <th className={styles.num}>Customer paid</th>
                <th className={styles.num}>Customs</th>
                <th className={styles.num}>We covered</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map(inv => editingId === inv.id ? (
                <tr key={inv.id}>
                  <td colSpan={9}>
                    <ShippingInvoiceEditor
                      invoice={inv}
                      onCancel={() => setEditingId(null)}
                      onSaved={() => { setEditingId(null); changed(); }}
                    />
                  </td>
                </tr>
              ) : (
                <tr key={inv.id}>
                  <td>{inv.invoice_date ?? '—'}</td>
                  <td>{inv.carrier ?? '—'}</td>
                  <td>{inv.invoice_number ?? '—'}</td>
                  <td>{inv.order_ref ?? '—'}</td>
                  <td className={styles.num}>
                    {money(inv.freight_amount, inv.currency)}
                    {!inv.counts_in_shipping && inv.freight_amount > 0 && (
                      <div className={styles.muted} title="Already costed by the Freightcom sync, so not added to Shipping again">
                        not added
                      </div>
                    )}
                  </td>
                  <td className={styles.num}>{money(inv.freight_customer_paid_amount, inv.currency)}</td>
                  <td className={styles.num}>{money(inv.customs_amount, inv.currency)}</td>
                  <td className={styles.num}>{money(inv.customs_covered_amount, inv.currency)}</td>
                  <td>
                    {inv.storage_path && (
                      <button className={styles.linkBtn} disabled={opening}
                              onClick={() => void view(inv.storage_path!)}>View</button>
                    )}
                    {' '}
                    <button className={styles.linkBtn} onClick={() => setEditingId(inv.id)}>Edit</button>
                    {' '}
                    <button className={styles.removeBtn} onClick={() => void remove(inv)}>Remove</button>
                    {inv.notes && <div className={styles.muted}>{inv.notes}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showForm && <ShippingInvoiceForm customerId={customerId} onSaved={changed} />}
    </div>
  );
}

/** Inline correction of an invoice already on file — every field editable. */
function ShippingInvoiceEditor({
  invoice, onCancel, onSaved,
}: {
  invoice: CustomerShippingInvoice;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const knownCarrier = !invoice.carrier || CARRIERS.includes(invoice.carrier);
  const [carrier, setCarrier] = useState(knownCarrier ? invoice.carrier ?? 'UPS' : 'Other');
  const [carrierOther, setCarrierOther] = useState(knownCarrier ? '' : invoice.carrier ?? '');
  const [invoiceNumber, setInvoiceNumber] = useState(invoice.invoice_number ?? '');
  const [invoiceDate, setInvoiceDate] = useState(invoice.invoice_date ?? '');
  const [orderRef, setOrderRef] = useState(invoice.order_ref ?? '');
  const [currency, setCurrency] = useState<ShippingCurrency>(invoice.currency);
  const [freight, setFreight] = useState(String(invoice.freight_amount));
  const [countsInShipping, setCountsInShipping] = useState(invoice.counts_in_shipping);
  const [customerPaid, setCustomerPaid] = useState(String(invoice.freight_customer_paid_amount));
  const [customs, setCustoms] = useState(String(invoice.customs_amount));
  const [covered, setCovered] = useState(String(invoice.customs_covered_amount));
  const [notes, setNotes] = useState(invoice.notes ?? '');
  const [orders, setOrders] = useState<CustomerOrderOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchCustomerOrderOptions(invoice.customer_id)
      .then(o => { if (live) setOrders(o); })
      .catch(() => { /* free-text box only */ });
    return () => { live = false; };
  }, [invoice.customer_id]);

  const carrierChoice = carrier;
  const [orderTyped, setOrderTyped] = useState(false);

  const save = async () => {
    const f = parseAmount(freight), c = parseAmount(customs), cov = parseAmount(covered);
    const cp = parseAmount(customerPaid);
    if ([f, cp, c, cov].some(Number.isNaN)) { setErr('Amounts must be positive numbers.'); return; }
    setBusy(true); setErr(null);
    try {
      await updateShippingInvoice(invoice, {
        carrier: carrierChoice === 'Other' && carrierOther.trim() ? carrierOther : carrierChoice,
        invoiceNumber, invoiceDate, orderRef, currency,
        freightAmount: f, countsInShipping, freightCustomerPaidAmount: cp, customsAmount: c, customsCoveredAmount: cov, notes,
      });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  // Free-text when the operator asked for it, or the stored ref isn't one of
  // this customer's orders (so the picker would silently drop it).
  const orderFree = orderTyped || orders.length === 0
    || (!!orderRef && !orders.some(o => o.order_ref === orderRef));

  return (
    <div className={styles.form}>
      <label className={styles.field}>
        Carrier
        <select className={styles.input} value={carrierChoice}
                onChange={e => { setCarrier(e.target.value); if (e.target.value !== 'Other') setCarrierOther(''); }}>
          {CARRIERS.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      {carrierChoice === 'Other' && (
        <label className={styles.field}>
          Carrier name
          <input className={styles.input} value={carrierOther} onChange={e => setCarrierOther(e.target.value)} />
        </label>
      )}
      <label className={styles.field}>
        Invoice #
        <input className={styles.input} value={invoiceNumber} onChange={e => setInvoiceNumber(e.target.value)} />
      </label>
      <label className={styles.field}>
        Invoice date
        <input type="date" className={styles.input} value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} />
      </label>
      {!orderFree ? (
        <label className={styles.fieldWide}>
          Order #
          <select className={styles.input} value={orderRef}
                  onChange={e => {
                    if (e.target.value === OTHER_ORDER) { setOrderTyped(true); setOrderRef(''); }
                    else setOrderRef(e.target.value);
                  }}>
            <option value="">— No order —</option>
            {orders.map(o => <option key={o.order_ref} value={o.order_ref}>{orderLabel(o)}</option>)}
            <option value={OTHER_ORDER}>Other — type an order #…</option>
          </select>
        </label>
      ) : (
        <label className={styles.field}>
          Order #
          <input className={styles.input} value={orderRef} placeholder="e.g. #1192"
                 onChange={e => setOrderRef(e.target.value)} />
        </label>
      )}
      <label className={styles.field}>
        Currency
        <select className={styles.input} value={currency} onChange={e => setCurrency(e.target.value as ShippingCurrency)}>
          <option value="CAD">CAD</option>
          <option value="USD">USD</option>
        </select>
      </label>
      <label className={styles.field}>
        Freight we paid
        <input className={styles.input} inputMode="decimal" value={freight} onChange={e => setFreight(e.target.value)} />
      </label>
      <label className={styles.field}>
        Freight customer paid
        <input className={styles.input} inputMode="decimal" value={customerPaid} onChange={e => setCustomerPaid(e.target.value)} />
      </label>
      <label className={styles.field}>
        Customs / duty on invoice
        <input className={styles.input} inputMode="decimal" value={customs} onChange={e => setCustoms(e.target.value)} />
      </label>
      <label className={styles.field}>
        Customs we cover
        <input className={styles.input} inputMode="decimal" value={covered} onChange={e => setCovered(e.target.value)} />
      </label>
      <label className={styles.check}>
        <input type="checkbox" checked={countsInShipping} onChange={e => setCountsInShipping(e.target.checked)} />
        Add the freight to this customer's shipping cost
      </label>
      <label className={styles.fieldWide}>
        Notes
        <input className={styles.input} value={notes} onChange={e => setNotes(e.target.value)} />
      </label>
      <div className={styles.actions}>
        <button className={styles.primaryBtn} disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <button className={styles.secondaryBtn} disabled={busy} onClick={onCancel}>Cancel</button>
        {err && <span className={styles.error}>{err}</span>}
      </div>
    </div>
  );
}

export function ShippingInvoiceForm({
  customerId, onSaved,
}: {
  customerId: string;
  onSaved: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [carrier, setCarrier] = useState('UPS');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [orderRef, setOrderRef] = useState('');
  const [currency, setCurrency] = useState<ShippingCurrency>('CAD');
  const [freight, setFreight] = useState('');
  const [countsInShipping, setCountsInShipping] = useState(true);
  const [customerPaid, setCustomerPaid] = useState('');
  const [customs, setCustoms] = useState('');
  const [covered, setCovered] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [orders, setOrders] = useState<CustomerOrderOption[]>([]);
  const [orderTyped, setOrderTyped] = useState(false);   // "Other" in the picker
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState<string | null>(null);
  const readSeq = useRef(0);

  useEffect(() => {
    let live = true;
    setOrders([]); setOrderRef(''); setOrderTyped(false);
    fetchCustomerOrderOptions(customerId)
      .then(opts => {
        if (!live) return;
        setOrders(opts);
        // A single order needs no choosing.
        if (opts.length === 1) setOrderRef(opts[0].order_ref);
      })
      .catch(() => { /* picker falls back to a free-text box */ });
    return () => { live = false; };
  }, [customerId]);

  /** Prefill carrier / invoice # / date / order from the chosen file. Every
   *  field stays editable; a value the reader didn't find is left as it was. */
  const pickFile = async (f: File | null) => {
    setFile(f); setReadNote(null);
    if (!f) return;
    const seq = ++readSeq.current;
    setReading(true);
    try {
      const { fields, extract_error } = await extractShippingInvoice(f);
      if (seq !== readSeq.current) return;   // a newer file was picked meanwhile
      const c = matchCarrier(fields.carrier);
      if (c) setCarrier(c);
      if (c === 'Other' && fields.carrier) {
        setNotes(n => n || `Carrier: ${fields.carrier}`);
      }
      if (fields.invoice_number) setInvoiceNumber(fields.invoice_number);
      if (fields.invoice_date) setInvoiceDate(fields.invoice_date);
      const guess = guessOrderRef(orders, fields);
      if (guess) { setOrderRef(guess); setOrderTyped(false); }
      else if (!orders.length && fields.order_number) setOrderRef(`#${fields.order_number}`);
      const found = [c && 'carrier', fields.invoice_number && 'invoice #', fields.invoice_date && 'date', guess && 'order']
        .filter(Boolean);
      setReadNote(found.length
        ? `Filled ${found.join(', ')} from the invoice — check and edit if needed.`
        : `Couldn't read the invoice details${extract_error ? ` (${extract_error})` : ''} — enter them by hand.`);
    } catch (e) {
      if (seq === readSeq.current) setReadNote(`Couldn't read the invoice (${(e as Error).message}) — enter the details by hand.`);
    } finally {
      if (seq === readSeq.current) setReading(false);
    }
  };

  const reset = () => {
    readSeq.current++; setReading(false); setReadNote(null);
    setFile(null); if (fileRef.current) fileRef.current.value = '';
    setInvoiceNumber(''); setInvoiceDate('');
    setOrderRef(orders.length === 1 ? orders[0].order_ref : ''); setOrderTyped(false);
    setFreight(''); setCustomerPaid(''); setCustoms(''); setCovered(''); setNotes('');
    setCountsInShipping(true);
  };

  const submit = async () => {
    setErr(null); setOk(null);
    const f = parseAmount(freight), c = parseAmount(customs), cov = parseAmount(covered);
    const cp = parseAmount(customerPaid);
    if ([f, cp, c, cov].some(Number.isNaN)) { setErr('Amounts must be positive numbers.'); return; }
    if (!file && f === 0 && cp === 0 && c === 0 && cov === 0) {
      setErr('Attach the invoice or enter at least one amount.'); return;
    }
    setBusy(true);
    try {
      await uploadShippingInvoice({
        customerId, file, carrier, invoiceNumber, invoiceDate, orderRef, currency,
        freightAmount: f, countsInShipping, freightCustomerPaidAmount: cp, customsAmount: c, customsCoveredAmount: cov, notes,
      });
      reset();
      setOk('Saved.');
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.form}>
      <label className={styles.fieldWide}>
        Invoice file (PDF or photo)
        <input ref={fileRef} type="file" accept={ACCEPT} className={styles.input}
               onChange={e => void pickFile(e.target.files?.[0] ?? null)} />
        {reading && <span className={styles.muted}>Reading invoice…</span>}
        {!reading && readNote && <span className={styles.muted}>{readNote}</span>}
      </label>
      <label className={styles.field}>
        Carrier
        <select className={styles.input} value={carrier} onChange={e => setCarrier(e.target.value)}>
          {CARRIERS.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <label className={styles.field}>
        Invoice #
        <input className={styles.input} value={invoiceNumber} onChange={e => setInvoiceNumber(e.target.value)} />
      </label>
      <label className={styles.field}>
        Invoice date
        <input type="date" className={styles.input} value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} />
      </label>
      {orders.length > 0 && !orderTyped ? (
        <label className={styles.fieldWide}>
          Order #
          <select className={styles.input}
                  value={orders.some(o => o.order_ref === orderRef) ? orderRef : ''}
                  onChange={e => {
                    if (e.target.value === OTHER_ORDER) { setOrderTyped(true); setOrderRef(''); }
                    else setOrderRef(e.target.value);
                  }}>
            <option value="">— Pick the order this shipment was for —</option>
            {orders.map(o => <option key={o.order_ref} value={o.order_ref}>{orderLabel(o)}</option>)}
            <option value={OTHER_ORDER}>Other — type an order #…</option>
          </select>
        </label>
      ) : (
        <label className={styles.field}>
          Order #
          <input className={styles.input} value={orderRef} placeholder="e.g. #1192" onChange={e => setOrderRef(e.target.value)} />
          {orders.length > 0 && (
            <button type="button" className={styles.linkBtn}
                    onClick={() => { setOrderTyped(false); setOrderRef(''); }}>Pick from this customer's orders</button>
          )}
        </label>
      )}
      <label className={styles.field}>
        Currency
        <select className={styles.input} value={currency} onChange={e => setCurrency(e.target.value as ShippingCurrency)}>
          <option value="CAD">CAD</option>
          <option value="USD">USD</option>
        </select>
      </label>
      <label className={styles.field}>
        Freight we paid
        <input className={styles.input} inputMode="decimal" value={freight} placeholder="0.00" onChange={e => setFreight(e.target.value)} />
      </label>
      <label className={styles.field}>
        Freight customer paid
        <input className={styles.input} inputMode="decimal" value={customerPaid} placeholder="0.00" onChange={e => setCustomerPaid(e.target.value)} />
      </label>
      <label className={styles.field}>
        Customs / duty on invoice
        <input className={styles.input} inputMode="decimal" value={customs} placeholder="0.00" onChange={e => setCustoms(e.target.value)} />
      </label>
      <label className={styles.field}>
        Customs we cover
        <input className={styles.input} inputMode="decimal" value={covered} placeholder="0.00" onChange={e => setCovered(e.target.value)} />
      </label>
      <label className={styles.check}>
        <input type="checkbox" checked={countsInShipping} onChange={e => setCountsInShipping(e.target.checked)} />
        Add the freight to this customer's shipping cost (untick if this shipment is already costed from the Freightcom sync)
      </label>
      <label className={styles.fieldWide}>
        Notes
        <input className={styles.input} value={notes} onChange={e => setNotes(e.target.value)} />
      </label>
      <div className={styles.hint}>
        "Customs we cover" is the part of the duty bill VCycene pays or reimburses — it is what lands in the
        customer's Customs &amp; duties cost on the Profitability tab. "Freight customer paid" is kept for the record
        only and does not change the margin. USD amounts convert at the company FX rate.
      </div>
      <div className={styles.actions}>
        <button className={styles.primaryBtn} disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : 'Save shipping invoice'}
        </button>
        {err && <span className={styles.error}>{err}</span>}
        {ok && <span className={styles.ok}>{ok}</span>}
      </div>
    </div>
  );
}

/** Edit a customer's profitability by hand: customs covered with no invoice
 *  on file, and an optional override of the whole Shipping bucket. */
export function ProfitabilityAdjustmentEditor({
  customerId, customerName, onSaved,
}: {
  customerId: string;
  customerName: string;
  onSaved?: () => void;
}) {
  const { adjustment, loading, error, reload } = useProfitabilityAdjustment(customerId);
  const [editing, setEditing] = useState(false);
  const [currency, setCurrency] = useState<ShippingCurrency>('CAD');
  const [customs, setCustoms] = useState('');
  const [override, setOverride] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const start = () => {
    setCurrency(adjustment?.currency ?? 'CAD');
    setCustoms(adjustment?.customs_covered_amount ? String(adjustment.customs_covered_amount) : '');
    setOverride(adjustment?.shipping_override_amount != null ? String(adjustment.shipping_override_amount) : '');
    setNote(adjustment?.note ?? '');
    setErr(null);
    setEditing(true);
  };

  const save = async () => {
    const c = parseAmount(customs);
    const o = override.trim() === '' ? null : parseAmount(override);
    if (Number.isNaN(c) || (o != null && Number.isNaN(o))) { setErr('Amounts must be positive numbers.'); return; }
    setBusy(true); setErr(null);
    try {
      await saveProfitabilityAdjustment({
        customerId, customerName, currency,
        customsCoveredAmount: c, shippingOverrideAmount: o, note,
      });
      await reload();
      setEditing(false);
      onSaved?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className={styles.empty}>Loading adjustments…</div>;

  if (!editing) {
    const cur = adjustment?.currency ?? 'CAD';
    return (
      <div className={styles.wrap}>
        {error && <div className={styles.error}>{error}</div>}
        <table className={styles.table}>
          <tbody>
            <tr>
              <td>Customs covered (no invoice)</td>
              <td className={styles.num}>{money(adjustment?.customs_covered_amount ?? 0, cur)}</td>
            </tr>
            <tr>
              <td>Shipping override</td>
              <td className={styles.num}>
                {adjustment?.shipping_override_amount != null
                  ? money(adjustment.shipping_override_amount, cur)
                  : <span className={styles.muted}>none — computed</span>}
              </td>
            </tr>
            {adjustment?.note && (
              <tr><td colSpan={2} className={styles.muted}>{adjustment.note}</td></tr>
            )}
            {adjustment?.updated_by && (
              <tr><td colSpan={2} className={styles.muted}>
                Last edited by {adjustment.updated_by} on {adjustment.updated_at.slice(0, 10)}
              </td></tr>
            )}
          </tbody>
        </table>
        <div>
          <button className={styles.secondaryBtn} onClick={start} disabled={!!error}>Edit</button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.form}>
      <label className={styles.field}>
        Currency
        <select className={styles.input} value={currency} onChange={e => setCurrency(e.target.value as ShippingCurrency)}>
          <option value="CAD">CAD</option>
          <option value="USD">USD</option>
        </select>
      </label>
      <label className={styles.field}>
        Customs we covered
        <input className={styles.input} inputMode="decimal" value={customs} placeholder="0.00" onChange={e => setCustoms(e.target.value)} />
      </label>
      <label className={styles.field}>
        Shipping override
        <input className={styles.input} inputMode="decimal" value={override} placeholder="blank = computed" onChange={e => setOverride(e.target.value)} />
      </label>
      <label className={styles.fieldWide}>
        Reason / note
        <input className={styles.input} value={note} placeholder="e.g. reimbursed UPS duty bill by e-transfer" onChange={e => setNote(e.target.value)} />
      </label>
      <div className={styles.hint}>
        Customs here is added to any customs covered on uploaded shipping invoices. A shipping override replaces the
        computed freight (Freightcom + legacy + uploaded invoices) in the margin; leave it blank to keep the computed figure.
      </div>
      <div className={styles.actions}>
        <button className={styles.primaryBtn} disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button className={styles.secondaryBtn} disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
        {err && <span className={styles.error}>{err}</span>}
      </div>
    </div>
  );
}
