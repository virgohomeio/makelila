import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { FormLayout } from './FormLayout';
import styles from './Forms.module.css';

const REASONS = [
  'Changed my mind',
  'Delivery too slow',
  'Found a better alternative',
  'Financial reason',
  'Ordered by mistake',
  'Address / shipping concern',
  'Other',
] as const;

export default function CancelOrderForm() {
  const [firstName, setFirstName]     = useState('');
  const [lastName,  setLastName]      = useState('');
  const [email,     setEmail]         = useState('');
  const [phone,     setPhone]         = useState('');
  const [orderRef,  setOrderRef]      = useState('');
  const [reason,    setReason]        = useState<typeof REASONS[number]>('Changed my mind');
  const [description, setDescription] = useState('');

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
    if (!orderRef.trim()) {
      setError('Please include your order number — it helps us find your order quickly.');
      return;
    }

    setSubmitting(true);
    try {
      const fullName = `${firstName.trim()} ${lastName.trim()}`;
      const ref = `CCR-${Math.floor(Math.random() * 90000 + 10000)}`;
      const { error: insErr } = await supabase.from('order_cancellations').insert({
        order_ref: orderRef.trim(),
        customer_name: fullName,
        customer_email: email.trim(),
        customer_phone: phone.trim() || null,
        reason,
        description: description.trim() || null,
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
            Our team will review your request and respond within 1–2 business days.<br /><br />
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
      title="Cancel your order"
      intro="If your order hasn't shipped yet, we can usually cancel it for a full refund. Please share a few details so our team can locate your order and respond quickly."
    >
      {error && <div className={styles.errorBanner}>{error}</div>}
      <form className={styles.form} onSubmit={submit}>
        <div className={styles.fieldGrid2}>
          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel}>First name<span className={styles.required}>*</span></label>
            <input value={firstName} onChange={e => setFirstName(e.target.value)}
                   className={styles.input} required />
          </div>
          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel}>Last name<span className={styles.required}>*</span></label>
            <input value={lastName} onChange={e => setLastName(e.target.value)}
                   className={styles.input} required />
          </div>
        </div>

        <div className={styles.fieldGrid2}>
          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel}>Email<span className={styles.required}>*</span></label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                   className={styles.input} required />
          </div>
          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel}>Phone</label>
            <input type="tel" value={phone} onChange={e => setPhone(e.target.value)}
                   className={styles.input} placeholder="(555) 123-4567" />
          </div>
        </div>

        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Order number<span className={styles.required}>*</span></label>
          <input value={orderRef} onChange={e => setOrderRef(e.target.value)}
                 className={styles.input} placeholder="#1107" required />
          <div className={styles.fieldHelp}>From your order confirmation email — usually starts with #.</div>
        </div>

        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Reason for cancellation<span className={styles.required}>*</span></label>
          <select value={reason} onChange={e => setReason(e.target.value as typeof REASONS[number])}
                  className={styles.select} required>
            {REASONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>

        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Additional details (optional)</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)}
                    className={styles.textarea}
                    placeholder="Anything else you'd like our team to know about this cancellation." />
        </div>

        <div className={styles.submitRow}>
          <button type="submit" className={styles.submitBtn} disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit cancellation request'}
          </button>
        </div>
      </form>
    </FormLayout>
  );
}
