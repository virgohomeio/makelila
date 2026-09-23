import { useMemo, useState } from 'react';
import {
  sendFulfillmentEmail,
  shipmentEmailVars,
  renderShipmentEmail,
  type FulfillmentQueueRow,
} from '../../../lib/fulfillment';
import { markOrderShipped } from '../../../lib/orders';
import { useEmailTemplate, updateTemplate } from '../../../lib/templates';
import { StepBlockers } from './StepBlockers';
import styles from '../Fulfillment.module.css';

/** The Step-5 body is no longer hardcoded here. It is rendered from the
 *  'shipment_confirmation' row in email_templates — the same row the
 *  send-fulfillment-email edge function renders — so the preview and the
 *  email that actually goes out cannot drift apart.
 *
 *  The operator can edit the rendered subject/body in place. An edit applies to
 *  that one send unless they also press "Save as default", which writes the
 *  edit back to the template for every shipment after it. */
const TEMPLATE_KEY = 'shipment_confirmation';

export function StepEmail({
  row,
  order,
}: {
  row: FulfillmentQueueRow;
  order: { id: string; customer_name: string; customer_email: string | null; order_ref: string; country: 'US'|'CA' };
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shippingCost, setShippingCost] = useState('');
  const [shipError, setShipError] = useState<string | null>(null);

  const { template, loading: tplLoading, refresh: refreshTemplate } = useEmailTemplate(TEMPLATE_KEY);

  const vars = useMemo(() => shipmentEmailVars(row, order), [row, order]);
  const baseSubject = template ? renderShipmentEmail(template.subject, vars) : '';
  const baseBody = template ? renderShipmentEmail(template.body, vars) : '';

  // null = untouched, so the fields keep tracking the template as it loads or
  // changes underneath. A string means the operator has typed something.
  const [subjectEdit, setSubjectEdit] = useState<string | null>(null);
  const [bodyEdit, setBodyEdit] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'confirm' | 'saving' | 'saved'>('idle');

  const subject = subjectEdit ?? baseSubject;
  const body = bodyEdit ?? baseBody;
  const dirty = (subjectEdit !== null && subjectEdit !== baseSubject)
    || (bodyEdit !== null && bodyEdit !== baseBody);

  const canSend = !!order.customer_email && !!template;
  // A customer with no email on file blocks this step with nothing on screen
  // to say so — the operator has to go add one in Customers first.
  const blockers: string[] = [];
  if (!order.customer_email) blockers.push('an email address on this customer');
  if (!template && !tplLoading) blockers.push(`the '${TEMPLATE_KEY}' email template (missing from the database)`);
  if (shippingCost.trim() === '') blockers.push('the actual shipping cost');
  const alreadySent = !!row.email_sent_at;

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
      // Only send overrides when the operator actually changed something, so
      // an untouched send stays a pure render of the stored template.
      await sendFulfillmentEmail(row.id, dirty ? { subject, body } : undefined);
    }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  /** Write the edit back to the template. The rendered values are swapped back
   *  out for their {{placeholders}} first — saving "Hi Juanita," as the default
   *  would greet every future customer by this one's name. */
  const handleSaveDefault = async () => {
    if (!template) return;
    if (saveState !== 'confirm') { setSaveState('confirm'); return; }
    setSaveState('saving'); setError(null);
    try {
      await updateTemplate(template.id, {
        subject: unrender(subject, vars, template.subject),
        body: unrender(body, vars, template.body),
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

      {tplLoading && <div style={{ fontSize: 11, color: 'var(--color-ink-subtle)' }}>Loading the template…</div>}
      {!tplLoading && !template && (
        <div style={{ fontSize: 11, color: 'var(--color-error)', marginBottom: 6 }}>
          The '{TEMPLATE_KEY}' email template is missing from the database — migration
          20260923120000 has not been applied. Nothing can be sent until it is.
        </div>
      )}

      {template && (
        <>
          <div style={{ fontSize: 10, color: 'var(--color-ink-subtle)', marginBottom: 4 }}>
            From: VCycene Team &lt;support@lilacomposter.com&gt; · To: {order.customer_email ?? '<no email>'}
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
              rows={16}
              style={{
                display: 'block', width: '100%', marginTop: 2,
                background: 'var(--color-surface)', border: '1px solid var(--color-border)',
                padding: 10, borderRadius: 4, fontSize: 10, lineHeight: 1.5,
                fontFamily: 'inherit', resize: 'vertical',
              }}
            />
          </label>

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
          ✓ Email sent{row.email_sent_at && ` at ${new Date(row.email_sent_at).toLocaleString()}`}.
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
        <button
          className={styles.confirmBtn}
          onClick={handleSend}
          disabled={!canSend || busy || shippingCost.trim() === ''}
        >
          {busy ? 'Sending…' : alreadySent ? '✉ Resend email' : '✉ Send email'}
        </button>
        <StepBlockers blockers={blockers} />
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
