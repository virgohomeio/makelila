import { useEffect, useMemo, useState } from 'react';
import {
  createManualOrder, manualOrderTotals, SALES_QUEUE_START,
  type ManualOrderLine,
} from '../../lib/orders';
import { formatMoney } from '../../lib/money';
import { Button } from '../../components/ui';
import styles from './NewOrderForm.module.css';

// The form for a sale that never went through Shopify. See createManualOrder in
// lib/orders.ts for what the row it writes has to look like and why.
//
// Two things are deliberately NOT asked for here, and both are load-bearing:
//
//   Freight. freightQuoted() counts a 'manual' source with a non-zero estimate
//   as a carrier rate having been pulled, and that is one of the four criteria
//   Confirm is gated on. A box on this form would let an operator satisfy that
//   gate by typing a number. The estimate comes from the Freight card's live
//   quote on the order itself, like it does for every other order.
//
//   The order reference. It is allocated as the next M-#### — a fourth series
//   kept clear of Shopify's '#', the importer's 'INV-' and replacements' 'R-'.
//   Letting it be typed is how the 14 INV- rows ended up colliding with a
//   different customer's '#' order.

/** The product names already in the orders table, offered as a datalist so the
 *  hand-typed name matches what every other sale calls the same machine. The
 *  line is free text underneath — a one-off accessory does not need a migration. */
const KNOWN_PRODUCTS = ['LILA Pro', 'LILA Composter', 'LILA Mini'];

const BLANK_LINE: ManualOrderLine = { name: 'LILA Pro', sku: '', qty: 1, price_usd: 0 };

/** Today, in the operator's own timezone, as the date input wants it. */
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A date-only input, at local noon rather than UTC midnight. Midnight UTC is
 *  the previous evening everywhere in North America, which would show the
 *  operator a date one day before the one they picked. */
function isoFromDateInput(date: string): string {
  return new Date(`${date}T12:00:00`).toISOString();
}

type Props = {
  onClose: () => void;
  onCreated: (result: { id: string; order_ref: string; status: string }) => void;
};

export default function NewOrderForm({ onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [postal, setPostal] = useState('');
  const [country, setCountry] = useState<'US' | 'CA'>('CA');
  const [currency, setCurrency] = useState('CAD');
  const [placedOn, setPlacedOn] = useState(todayLocal());
  const [paid, setPaid] = useState<'paid' | 'pending'>('paid');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<ManualOrderLine[]>([{ ...BLANK_LINE }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // CAD for a Canadian address, USD for an American one — the operator can
  // still override it afterwards, but the common case should not need a second
  // thought. Done here rather than in an effect on `country` so that an
  // override survives: an effect would reset the currency every time the
  // country was touched again, including after it had been deliberately set.
  const changeCountry = (next: 'US' | 'CA') => {
    setCountry(next);
    setCurrency(next === 'CA' ? 'CAD' : 'USD');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const totals = useMemo(() => manualOrderTotals(lines), [lines]);

  const setLine = (i: number, patch: Partial<ManualOrderLine>) =>
    setLines(ls => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  // An order dated before the Sales cutoff is in no tab in this module and
  // search does not reach it either — the one way to create a row that cannot
  // be found from the screen that created it.
  const tooOld = placedOn < SALES_QUEUE_START;
  const cutoffLabel = new Date(`${SALES_QUEUE_START}T00:00:00`)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const canSubmit = name.trim() !== ''
    && city.trim() !== ''
    && lines.length > 0
    && lines.every(l => l.name.trim() !== '' && l.qty >= 1 && l.price_usd >= 0)
    && !tooOld
    && !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await createManualOrder({
        customer_name: name,
        customer_email: email || null,
        customer_phone: phone || null,
        address: {
          address_line: line1 || null,
          address_line2: line2 || null,
          city,
          region_state: region || null,
          country,
          postal_code: postal || null,
        },
        currency,
        line_items: lines,
        financial_status: paid,
        payment_method: paymentMethod || null,
        placed_at: isoFromDateInput(placedOn),
        note,
      });
      onCreated(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const dirty = name !== '' || city !== '' || lines.some(l => l.price_usd > 0);

  return (
    <div
      className={styles.backdrop}
      onClick={() => {
        if (dirty && !window.confirm('Discard this order?')) return;
        onClose();
      }}
    >
      <div
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-label="New sales order"
        onClick={e => e.stopPropagation()}
      >
        <header className={styles.head}>
          <span className={styles.headTitle}>New sales order</span>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className={styles.body}>
          <p className={styles.lede}>
            For a sale that did not come through the web store — taken on the phone, at an
            event, or invoiced directly. It becomes an ordinary order: it lands in Sales
            waiting for its address to be verified and freight quoted, and confirming it is
            what sends it to Fulfillment.
          </p>

          <section className={styles.section}>
            <h3 className={styles.sectionHead}>Customer</h3>
            <div className={styles.grid2}>
              <label className={styles.field}>
                <span className={styles.label}>Name *</span>
                <input
                  className={styles.input}
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Dana Whitfield"
                  autoFocus
                />
              </label>
              <label className={styles.field}>
                <span className={styles.label}>Email</span>
                <input
                  className={styles.input}
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="dana@example.com"
                />
              </label>
            </div>
            <label className={styles.field}>
              <span className={styles.label}>Phone</span>
              <input
                className={styles.input}
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="+1 416 555 0123"
              />
              {/* The auto_flag_orders_without_phone trigger does this to every
                  order, synced or not. Saying so up front beats the operator
                  hunting for a row that is not in the tab they expected. */}
              {phone.trim() === '' && (
                <span className={styles.hint}>
                  With no phone number the order arrives in <strong>Flagged</strong> rather than
                  Pending — the same thing happens to a Shopify order without one. A freight
                  carrier needs a number for the delivery appointment.
                </span>
              )}
            </label>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionHead}>Ship to</h3>
            <div className={styles.grid2}>
              <label className={styles.field}>
                <span className={styles.label}>Address</span>
                <input
                  className={styles.input}
                  value={line1}
                  onChange={e => setLine1(e.target.value)}
                  placeholder="88 Palmerston Ave"
                />
              </label>
              <label className={styles.field}>
                <span className={styles.label}>Unit / suite</span>
                <input
                  className={styles.input}
                  value={line2}
                  onChange={e => setLine2(e.target.value)}
                  placeholder="4B"
                />
              </label>
            </div>
            <div className={styles.gridAddr}>
              <label className={styles.field}>
                <span className={styles.label}>City *</span>
                <input className={styles.input} value={city} onChange={e => setCity(e.target.value)} />
              </label>
              <label className={styles.field}>
                <span className={styles.label}>{country === 'CA' ? 'Province' : 'State'}</span>
                <input className={styles.input} value={region} onChange={e => setRegion(e.target.value)} />
              </label>
              <label className={styles.field}>
                <span className={styles.label}>{country === 'CA' ? 'Postal' : 'ZIP'}</span>
                <input className={styles.input} value={postal} onChange={e => setPostal(e.target.value)} />
              </label>
              <label className={styles.field}>
                <span className={styles.label}>Country</span>
                <select
                  className={styles.select}
                  value={country}
                  onChange={e => changeCountry(e.target.value as 'US' | 'CA')}
                >
                  <option value="CA">CA</option>
                  <option value="US">US</option>
                </select>
              </label>
            </div>
            <span className={styles.hint}>
              Nothing has checked this address yet. Verify it and pull a freight rate on the
              order itself once it exists — Confirm stays closed until both have run.
            </span>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionHead}>What they bought</h3>
            <datalist id="manual-order-products">
              {KNOWN_PRODUCTS.map(p => <option key={p} value={p} />)}
            </datalist>
            {lines.map((l, i) => (
              <div className={styles.lineRow} key={i}>
                <input
                  className={styles.input}
                  list="manual-order-products"
                  value={l.name}
                  onChange={e => setLine(i, { name: e.target.value })}
                  placeholder="Product"
                  aria-label={`Line ${i + 1} product`}
                />
                <input
                  className={styles.input}
                  value={l.sku}
                  onChange={e => setLine(i, { sku: e.target.value })}
                  placeholder="SKU"
                  aria-label={`Line ${i + 1} SKU`}
                />
                <input
                  className={styles.inputNum}
                  type="number"
                  min={1}
                  step={1}
                  value={l.qty}
                  onChange={e => setLine(i, { qty: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
                  aria-label={`Line ${i + 1} quantity`}
                />
                <input
                  className={styles.inputNum}
                  type="number"
                  min={0}
                  step="0.01"
                  value={l.price_usd}
                  onChange={e => setLine(i, { price_usd: Math.max(0, Number(e.target.value) || 0) })}
                  aria-label={`Line ${i + 1} unit price`}
                />
                <button
                  type="button"
                  className={styles.lineRemove}
                  onClick={() => setLines(ls => ls.filter((_, j) => j !== i))}
                  disabled={lines.length === 1}
                  aria-label={`Remove line ${i + 1}`}
                  title={lines.length === 1 ? 'An order needs at least one line' : 'Remove this line'}
                >×</button>
              </div>
            ))}
            <div className={styles.lineFoot}>
              <Button small onClick={() => setLines(ls => [...ls, { ...BLANK_LINE, price_usd: 0 }])}>
                + Add a line
              </Button>
              <span className={styles.total}>
                {totals.units} unit{totals.units === 1 ? '' : 's'} ·{' '}
                <strong>{formatMoney(totals.subtotal, currency)}</strong>
              </span>
            </div>
            {/* The cost side is not asked for: the orders_set_sale_cogs trigger
                sets COGS from the batch actual or the dated schedule, the same
                way it does for a synced sale. */}
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionHead}>Money and date</h3>
            <div className={styles.gridAddr}>
              <label className={styles.field}>
                <span className={styles.label}>Currency</span>
                <select className={styles.select} value={currency} onChange={e => setCurrency(e.target.value)}>
                  <option value="CAD">CAD</option>
                  <option value="USD">USD</option>
                </select>
              </label>
              <label className={styles.field}>
                <span className={styles.label}>Payment</span>
                <select
                  className={styles.select}
                  value={paid}
                  onChange={e => setPaid(e.target.value as 'paid' | 'pending')}
                >
                  <option value="paid">Paid</option>
                  <option value="pending">Not yet paid</option>
                </select>
              </label>
              <label className={styles.field}>
                <span className={styles.label}>Method</span>
                <input
                  className={styles.input}
                  value={paymentMethod}
                  onChange={e => setPaymentMethod(e.target.value)}
                  placeholder="e-transfer"
                />
              </label>
              <label className={styles.field}>
                <span className={styles.label}>Date placed</span>
                <input
                  className={styles.input}
                  type="date"
                  value={placedOn}
                  max={todayLocal()}
                  onChange={e => setPlacedOn(e.target.value)}
                />
              </label>
            </div>
            {tooOld && (
              <span className={styles.warn}>
                Sales only shows orders placed on or after {cutoffLabel}. Dated earlier, this
                order would exist but appear in no tab here and search would not find it.
              </span>
            )}
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionHead}>Note</h3>
            <textarea
              className={styles.textarea}
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Where this sale came from — the market stall, the call, the invoice number."
            />
          </section>

          {error && <div className={styles.error}>{error}</div>}
        </div>

        <footer className={styles.foot}>
          <span className={styles.footNote}>
            Creates it at <strong>{phone.trim() === '' ? 'Flagged' : 'Pending'}</strong> — nothing ships
            until someone confirms it.
          </span>
          <div className={styles.footBtns}>
            <Button onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit}>
              {busy ? 'Creating…' : 'Create order'}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
