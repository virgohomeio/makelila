import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { FormLayout } from './FormLayout';
import styles from './Forms.module.css';

const CANCEL_REASONS = [
  'Ordered by mistake',
  'Found a better price',
  'Product no longer needed',
  'Shipping time too long',
  'Other',
] as const;

const PURCHASE_CHANNELS = [
  'Online Store',
  'In-person',
  'Phone',
  'Other',
] as const;

const RESOLUTIONS = [
  'Full cancellation before shipment',
  'Cancel remaining items',
  'Return for refund',
  'Exchange',
  'Other',
] as const;

export default function CancelOrderForm() {
  // 1. Name
  const [firstName, setFirstName] = useState('');
  const [lastName,  setLastName]  = useState('');
  // 2. Email
  const [email,     setEmail]     = useState('');
  // 3. Phone
  const [phone,     setPhone]     = useState('');
  // 4. Preferred contact method
  const [preferredContact, setPreferredContact] = useState<'email' | 'phone'>('email');
  // 5. Order number
  const [orderRef,  setOrderRef]  = useState('');
  // 6. Order date
  const [orderDate, setOrderDate] = useState('');
  // 7. Product / Service Name
  const [productName, setProductName] = useState('LILA Pro Composter');
  // 8. Order Amount
  const [orderAmount, setOrderAmount] = useState('');
  // 9. Purchase Channel
  const [channel,   setChannel]   = useState<string>('Online Store');
  // 10. Reason
  const [reason,    setReason]    = useState<string>('');
  // 11. Other reason
  const [reasonOther, setReasonOther] = useState('');
  // 12. Detailed explanation
  const [description, setDescription] = useState('');
  // 13. Received product yet?
  const [received,  setReceived]  = useState<'Yes' | 'No' | ''>('');
  // 14. Desired resolution
  const [resolution, setResolution] = useState<string>('');
  // 15. Other resolution value
  const [resolutionOther, setResolutionOther] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [requestRef, setRequestRef] = useState<string | null>(null);
  const [error,      setError]      = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    if (!firstName.trim() || !lastName.trim() || !email.trim()) {
      setError('Please fill in your name and email.');
      return;
    }
    if (!orderRef.trim()) { setError('Please include your order number.'); return; }
    if (!reason)          { setError('Please select a reason for cancellation.'); return; }
    if (reason === 'Other' && !reasonOther.trim()) { setError('Please describe the "other" reason.'); return; }
    if (!received)        { setError('Please tell us whether you\'ve received the product.'); return; }
    if (!resolution)      { setError('Please select a desired resolution.'); return; }
    if (resolution === 'Other' && !resolutionOther.trim()) { setError('Please describe the "other" resolution.'); return; }

    setSubmitting(true);
    try {
      const fullName = `${firstName.trim()} ${lastName.trim()}`;
      const ref = `CCR-${Math.floor(Math.random() * 90000 + 10000)}`;
      const finalReason = reason === 'Other' ? `Other: ${reasonOther.trim()}` : reason;
      const finalResolution = resolution === 'Other' ? `Other: ${resolutionOther.trim()}` : resolution;
      const amountNum = orderAmount.trim() ? Number(orderAmount.replace(/[^0-9.]/g, '')) : null;

      const { error: insErr } = await supabase.from('order_cancellations').insert({
        order_ref: orderRef.trim(),
        customer_name: fullName,
        customer_email: email.trim(),
        customer_phone: phone.trim() || null,
        preferred_contact: preferredContact,
        order_date: orderDate || null,
        product_name: productName.trim() || null,
        order_amount_usd: Number.isFinite(amountNum) ? amountNum : null,
        purchase_channel: channel,
        reason: finalReason,
        description: description.trim() || null,
        product_received: received === 'Yes',
        desired_resolution: finalResolution,
        ops_notes: `Customer reference: ${ref}`,
        status: 'submitted',
      });
      if (insErr) throw insErr;
      setRequestRef(ref);
    } catch (err) {
      setError(`Could not submit: ${(err as Error).message}. Please email support@lilacomposter.com if this persists.`);
    } finally {
      setSubmitting(false);
    }
  };

  if (requestRef) {
    return (
      <FormLayout title="Cancellation request received" intro="">
        <div className={styles.successCard}>
          <div className={styles.successIcon}>✓</div>
          <div className={styles.successTitle}>Thanks — we've received your cancellation request.</div>
          <div className={styles.successSub}>
            Our team will review your request and respond within 1–2 business days via your preferred contact method.<br /><br />
            <strong>Please note:</strong> if your order has already shipped, we may not be able to cancel it.
            In that case we'll guide you through our return process instead.<br /><br />
            Save your reference number for follow-up emails:
          </div>
          <div className={styles.successRef}>{requestRef}</div>
          <div>
            <a href="https://lilacomposter.com" className={styles.successAction}>← Back to lilacomposter.com</a>
          </div>
        </div>
      </FormLayout>
    );
  }

  return (
    <FormLayout
      title="LILA Order Cancellation Form"
      intro="If your order hasn't shipped yet, we can usually cancel it for a full refund. Please share a few details so our team can locate your order and respond quickly. Required fields are marked with *."
    >
      {error && <div className={styles.errorBanner}>{error}</div>}
      <form className={styles.form} onSubmit={submit}>

        {/* 1-4. Contact info */}
        <SectionHeader text="About you" />
        <div className={styles.fieldGrid2}>
          <Field label="First name" required>
            <input value={firstName} onChange={e => setFirstName(e.target.value)}
                   className={styles.input} required />
          </Field>
          <Field label="Last name" required>
            <input value={lastName} onChange={e => setLastName(e.target.value)}
                   className={styles.input} required />
          </Field>
        </div>
        <div className={styles.fieldGrid2}>
          <Field label="Email address" required>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                   className={styles.input} required />
          </Field>
          <Field label="Phone number">
            <input type="tel" value={phone} onChange={e => setPhone(e.target.value)}
                   className={styles.input} placeholder="(000) 000-0000" />
          </Field>
        </div>
        <Field label="Preferred contact method" required>
          <RadioGroup
            options={['Email', 'Phone']}
            value={preferredContact === 'email' ? 'Email' : 'Phone'}
            onChange={v => setPreferredContact(v === 'Email' ? 'email' : 'phone')}
          />
        </Field>

        {/* 5-9. Order details */}
        <SectionHeader text="About your order" />
        <div className={styles.fieldGrid2}>
          <Field label="Order number" required>
            <input value={orderRef} onChange={e => setOrderRef(e.target.value)}
                   className={styles.input} placeholder="#1107" required />
          </Field>
          <Field label="Order date">
            <input type="date" value={orderDate} onChange={e => setOrderDate(e.target.value)}
                   className={styles.input} />
          </Field>
        </div>
        <Field label="Product / Service name">
          <input value={productName} onChange={e => setProductName(e.target.value)}
                 className={styles.input} placeholder="LILA Pro Composter" />
        </Field>
        <div className={styles.fieldGrid2}>
          <Field label="Order amount">
            <input value={orderAmount} onChange={e => setOrderAmount(e.target.value)}
                   className={styles.input} placeholder="$1,049" />
          </Field>
          <Field label="Purchase channel">
            <select value={channel} onChange={e => setChannel(e.target.value)} className={styles.select}>
              {PURCHASE_CHANNELS.map(c => <option key={c}>{c}</option>)}
            </select>
          </Field>
        </div>

        {/* 10-12. Why cancelling */}
        <SectionHeader text="Why you're cancelling" />
        <Field label="Reason for cancellation" required>
          <RadioGroup options={CANCEL_REASONS} value={reason} onChange={setReason} stacked />
        </Field>
        {reason === 'Other' && (
          <Field label="Other reason — please specify" required>
            <input value={reasonOther} onChange={e => setReasonOther(e.target.value)}
                   className={styles.input} required />
          </Field>
        )}
        <Field label="Detailed explanation">
          <textarea value={description} onChange={e => setDescription(e.target.value)}
                    className={styles.textarea} rows={3}
                    placeholder="Anything else you'd like our team to know about this cancellation." />
        </Field>

        {/* 13-15. Status + resolution */}
        <SectionHeader text="Current status" />
        <Field label="Have you received the product yet?" required>
          <RadioGroup options={['Yes', 'No']} value={received} onChange={v => setReceived(v as 'Yes' | 'No')} />
        </Field>
        <Field label="Desired resolution" required>
          <RadioGroup options={RESOLUTIONS} value={resolution} onChange={setResolution} stacked />
        </Field>
        {resolution === 'Other' && (
          <Field label="Other resolution — please specify" required>
            <input value={resolutionOther} onChange={e => setResolutionOther(e.target.value)}
                   className={styles.input} required />
          </Field>
        )}

        <div className={styles.submitRow}>
          <button type="submit" className={styles.submitBtn} disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit cancellation request'}
          </button>
        </div>
      </form>
    </FormLayout>
  );
}

// ============================================================================
// Field building blocks (duplicated locally — small, avoids cross-file coupling)
// ============================================================================
function SectionHeader({ text }: { text: string }) {
  return <div className={styles.sectionHeader}>{text}</div>;
}

function Field({
  label, required, help, children,
}: { label: string; required?: boolean; help?: string; children: React.ReactNode }) {
  return (
    <div className={styles.fieldRow}>
      <label className={styles.fieldLabel}>
        {label}{required && <span className={styles.required}>*</span>}
      </label>
      {children}
      {help && <div className={styles.fieldHelp}>{help}</div>}
    </div>
  );
}

function RadioGroup({
  options, value, onChange, stacked,
}: { options: readonly string[]; value: string; onChange: (v: string) => void; stacked?: boolean }) {
  return (
    <div className={stacked ? styles.radioStack : styles.radioGroup}>
      {options.map(opt => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`${styles.radioBtn} ${value === opt ? styles.radioBtnActive : ''}`}
        >{opt}</button>
      ))}
    </div>
  );
}
