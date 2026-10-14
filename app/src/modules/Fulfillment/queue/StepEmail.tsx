import { useMemo, useState } from 'react';
import {
  sendFulfillmentEmail,
  shipmentEmailVars,
  renderShipmentEmail,
  type FulfillmentQueueRow,
} from '../../../lib/fulfillment';
import { markOrderShipped } from '../../../lib/orders';
import { useOrderRecipient } from '../../../lib/orderRecipient';
import { useEmailTemplate, updateTemplate, createTemplate } from '../../../lib/templates';
import {
  SHIPMENT_EMAIL_DEFAULT,
  SHIPMENT_EMAIL_VARIABLES,
  unsupportedVariables,
} from '../../../lib/shipmentEmailTemplate';
import { StepBlockers } from './StepBlockers';
import styles from '../Fulfillment.module.css';

/** Step 5 renders SHIPMENT_EMAIL_DEFAULT unless the stored
 *  'shipment_confirmation' row overrides it, and sends exactly what is on
 *  screen — so the draft and the email cannot drift apart.
 *
 *  The operator can edit the subject/body in place. An edit applies to that one
 *  send unless they also press "Save as default", which stores it for every
 *  shipment after it. */
const TEMPLATE_KEY = 'shipment_confirmation';

export function StepEmail({
  row,
  order,
  onSent,
}: {
  row: FulfillmentQueueRow;
  /** customer_id is read so a replacement born off a phone-call ticket — no
   *  email copied onto the order row — can still be addressed from the
   *  customer record. See lib/orderRecipient.ts. */
  order: {
    id: string; customer_name: string; customer_email: string | null;
    customer_id?: string | null; order_ref: string; country: 'US'|'CA';
  };
  /** Ask the board to re-read the queue. The send moves the row to step 6 in
   *  the database, but the board learns that over a realtime socket it is
   *  documented to drop, so it is told explicitly too. */
  onSent?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // Confirmation the operator can trust the instant the send returns. Relying
  // on row.email_sent_at alone made a completed send look like a dead button
  // whenever the socket was down (#1184, 2026-09-24).
  const [justSent, setJustSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shippingCost, setShippingCost] = useState('');
  const [shipError, setShipError] = useState<string | null>(null);

  const { template, loading: tplLoading, refresh: refreshTemplate } = useEmailTemplate(TEMPLATE_KEY);

  const vars = useMemo(() => shipmentEmailVars(row, order), [row, order]);

  // A stored row wins only if this renderer can actually fill every
  // placeholder in it. The row seeded in May declares {{calendly_url}}, which
  // nothing supplies any more — rendering it would put a literal
  // "{{calendly_url}}" in the customer's email, so the built-in default is
  // used instead and the operator is told why.
  const staleVars = template ? unsupportedVariables(template) : [];
  const source = template && staleVars.length === 0 ? template : SHIPMENT_EMAIL_DEFAULT;

  const baseSubject = renderShipmentEmail(source.subject, vars);
  const baseBody = renderShipmentEmail(source.body, vars);

  // null = untouched, so the fields keep tracking the template as it loads or
  // changes underneath. A string means the operator has typed something.
  const [subjectEdit, setSubjectEdit] = useState<string | null>(null);
  const [bodyEdit, setBodyEdit] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'confirm' | 'saving' | 'saved'>('idle');

  const subject = subjectEdit ?? baseSubject;
  const body = bodyEdit ?? baseBody;
  const dirty = (subjectEdit !== null && subjectEdit !== baseSubject)
    || (bodyEdit !== null && bodyEdit !== baseBody);

  // Who the mail actually goes to: the order's own column, else the linked
  // customer record. Step 5 used to read order.customer_email alone, which
  // blocked every replacement raised from a phone call — the order row has no
  // email on it and the customer record does (R-0023, Candace Chan).
  const recipient = useOrderRecipient(order);

  // Sending never depends on the stored row: the default below always renders.
  const canSend = !!recipient.email;
  // A customer with no email on file blocks this step with nothing on screen
  // to say so — the operator has to go add one in Customers first.
  const blockers: string[] = [];
  // Silent while the customer record is still being read, rather than naming a
  // blocker that is about to clear itself.
  if (!recipient.email && !recipient.loading) {
    blockers.push(recipient.nameMismatch
      // The directory row linked to this order names someone else, so its
      // address is not safe to use — say which link is wrong, not "no email".
      ? 'an email address on this order — the customer record linked to it names someone else'
      : 'an email address on this customer');
  }
  if (shippingCost.trim() === '') blockers.push('the actual shipping cost');
  const alreadySent = !!row.email_sent_at || justSent;

  const handleSend = async () => {
    if (!canSend) return;
    const n = Number(shippingCost);
    if (!shippingCost.trim() || !Number.isFinite(n) || n < 0) {
      setShipError('Enter a valid shipping cost before sending.');
      return;
    }
    setShipError(null);
    setBusy(true); setError(null);
    try {
      await markOrderShipped(order.id, n, 'CAD');
      // The rendered text always travels with the request. The edge function
      // has no copy of the wording of its own, so what is on screen here is
      // exactly what Resend is handed.
      await sendFulfillmentEmail(row.id, { subject, body, edited: dirty });
      setJustSent(true);
      onSent?.();
    }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  /** Write the edit back to the template. The rendered values are swapped back
   *  out for their {{placeholders}} first — saving "Hi Juanita," as the default
   *  would greet every future customer by this one's name. */
  const handleSaveDefault = async () => {
    if (saveState !== 'confirm') { setSaveState('confirm'); return; }
    setSaveState('saving'); setError(null);
    try {
      const patch = {
        subject: unrender(subject, vars, source.subject),
        body: unrender(body, vars, source.body),
      };
      // Updating a stale row replaces the placeholders it used to declare, so
      // saving is also how an operator repairs one without waiting on a
      // migration. If the row was never seeded at all, create it.
      if (template) await updateTemplate(template.id, { ...patch, variables: [...SHIPMENT_EMAIL_VARIABLES] });
      else await createTemplate({
        key: TEMPLATE_KEY, name: 'LILA has shipped', category: 'fulfillment',
        description: 'Step-5 shipment confirmation. Saved from the Fulfillment queue.',
        ...patch, variables: [...SHIPMENT_EMAIL_VARIABLES],
      });
      // This hook has no realtime subscription, so without the refetch the
      // fields would snap back to the pre-save wording the moment the local
      // edits are cleared.
      await refreshTemplate();
      setSubjectEdit(null); setBodyEdit(null);
      setSaveState('saved');
    } catch (e) {
      setError(`Could not save the default: ${(e as Error).message}`);
      setSaveState('idle');
    }
  };

  const handleReset = () => { setSubjectEdit(null); setBodyEdit(null); setSaveState('idle'); };

  return (
    <div>
      <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Send the shipment-confirmation email</h3>

      {tplLoading && <div style={{ fontSize: 11, color: 'var(--color-ink-subtle)' }}>Loading the saved wording…</div>}
      {!tplLoading && staleVars.length > 0 && (
        <div style={{ fontSize: 10, color: 'var(--color-ink-subtle)', marginBottom: 6 }}>
          Showing the built-in wording. The saved template still uses{' '}
          {staleVars.map(v => `{{${v}}}`).join(', ')}, which this step can no longer fill.
          Press “Save as default” after any edit to replace it.
        </div>
      )}

      {!tplLoading && (
        <>
          <div style={{ fontSize: 10, color: 'var(--color-ink-subtle)', marginBottom: 4 }}>
            From: VCycene Team &lt;support@lilacomposter.com&gt; · To:{' '}
            {recipient.loading ? 'checking the customer record…' : recipient.email ?? '<no email>'}
            {/* An address that is not on the order is still the right one to
                use, but the operator is told where it came from before they
                send — this is the only place they can catch a bad link. */}
            {recipient.source === 'directory' && ' (from the customer record — none on this order)'}
          </div>

          <label style={{ display: 'block', fontSize: 10, color: 'var(--color-ink-subtle)', marginBottom: 2 }}>
            Subject
            <input
              type="text"
              value={subject}
              onChange={e => { setSubjectEdit(e.target.value); setSaveState('idle'); }}
              style={{
                display: 'block', width: '100%', marginTop: 2, padding: '5px 7px',
                fontSize: 11, border: '1px solid var(--color-border)', borderRadius: 4,
              }}
            />
          </label>

          <label style={{ display: 'block', fontSize: 10, color: 'var(--color-ink-subtle)', margin: '6px 0 2px' }}>
            Body — edit before sending if you need to
            <textarea
              value={body}
              onChange={e => { setBodyEdit(e.target.value); setSaveState('idle'); }}
              // Sized to the body rather than fixed. At a flat 16 rows the
              // Lovely App section pushed everything from the install steps
              // down past the fold, and an operator checking the draft saw a
              // truncated email with no hint there was more below — the change
              // looked unshipped. Clamped so a pasted essay cannot run the
              // step off-screen; the box is still drag-resizable.
              rows={Math.min(48, Math.max(16, body.split('\n').length + 1))}
              style={{
                display: 'block', width: '100%', marginTop: 2,
                background: 'var(--color-surface)', border: '1px solid var(--color-border)',
                padding: 10, borderRadius: 4, fontSize: 10, lineHeight: 1.5,
                fontFamily: 'inherit', resize: 'vertical',
              }}
            />
          </label>

          {/* The textarea is plain text, so the install guide can only appear
              here as a URL. Without this line an operator would reasonably
              assume the customer gets a bare link and "fix" it by deleting it. */}
          <div style={{ fontSize: 10, color: 'var(--color-ink-subtle)', marginBottom: 4 }}>
            A line that is only an image URL is sent as the picture itself — that is how the
            Lovely install guide reaches the customer. Keep it on its own line.
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '4px 0 2px' }}>
            {dirty && (
              <>
                <button
                  type="button"
                  onClick={handleSaveDefault}
                  disabled={saveState === 'saving'}
                  style={{ fontSize: 10, padding: '3px 8px', cursor: 'pointer' }}
                >
                  {saveState === 'saving' ? 'Saving…'
                    : saveState === 'confirm' ? 'Overwrite it for everyone?'
                    : 'Save as default'}
                </button>
                <button
                  type="button"
                  onClick={handleReset}
                  style={{ fontSize: 10, padding: '3px 8px', cursor: 'pointer' }}
                >
                  Reset
                </button>
                <span style={{ fontSize: 10, color: 'var(--color-ink-subtle)' }}>
                  {saveState === 'confirm'
                    ? 'This replaces the stored template for every future shipment.'
                    : 'Edited — this send only, unless you save it as the default.'}
                </span>
              </>
            )}
            {saveState === 'saved' && !dirty && (
              <span style={{ fontSize: 10, color: 'var(--color-success, #2f855a)' }}>
                ✓ Saved as the default for future shipments.
              </span>
            )}
          </div>
        </>
      )}

      {alreadySent && (
        <div style={{ fontSize: 11, color: 'var(--color-success, #2f855a)', margin: '6px 0' }}>
          ✓ Email sent{row.email_sent_at
            ? ` at ${new Date(row.email_sent_at).toLocaleString()}`
            : ' — this order is now fulfilled'}.
        </div>
      )}
      <label className={styles.shippingCostLabel}>
        {/* Was labelled USD while every stored value was CAD — the carriers bill
            VCycene in Canadian dollars. Corrected so operators aren't told to
            enter one currency into a field that holds another. */}
        Actual shipping cost (CAD):&nbsp;
        <input
          type="number"
          step="0.01"
          min="0"
          value={shippingCost}
          onChange={e => { setShippingCost(e.target.value); setShipError(null); }}
          placeholder="42.75"
        />
      </label>
      {shipError && <p className={styles.error}>{shipError}</p>}
      <div className={styles.stepBar}>
        {/* No Resend: the edge function refuses a second send with 409 'email
            already sent', so a button offering one could only ever error. */}
        <button
          className={styles.confirmBtn}
          onClick={handleSend}
          disabled={!canSend || busy || alreadySent || shippingCost.trim() === ''}
        >
          {busy ? 'Sending…' : alreadySent ? '✓ Email sent' : '✉ Send email'}
        </button>
        {!alreadySent && <StepBlockers blockers={blockers} />}
      </div>
      {error && <div style={{ color: 'var(--color-error)', fontSize: 11, marginTop: 6 }}>{error}</div>}
    </div>
  );
}

/** Turn a rendered string back into a template by restoring {{placeholders}}.
 *
 *  Saving the preview verbatim would bake this order's name, carrier and
 *  tracking number into the default. Each variable's rendered value is swapped
 *  back for its placeholder; values too short or too generic to match safely
 *  (a one-letter first name, an empty carrier) are skipped, and if the result
 *  no longer contains a placeholder the stored template had, the operator
 *  deleted it deliberately — that is respected.
 *
 *  `original` is only used to keep the untouched case byte-identical. */
function unrender(rendered: string, vars: Record<string, string>, original: string): string {
  if (rendered === renderShipmentEmail(original, vars)) return original;
  let out = rendered;
  for (const [name, value] of Object.entries(vars)) {
    // Short values produce false hits ("Al" inside "Also"); the starter block
    // is structural text rather than a value worth re-placeholdering.
    if (name === 'starter_block' || !value || value.length < 3) continue;
    out = out.split(value).join(`{{${name}}}`);
  }
  return out;
}
