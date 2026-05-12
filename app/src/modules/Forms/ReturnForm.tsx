import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { FormLayout } from './FormLayout';
import styles from './Forms.module.css';

const REASONS = [
  'Product Defect',
  'Shipping Damage',
  'Software Issue',
  'Financing Issue',
  'Changed Mind',
  'Other',
] as const;

const CONDITIONS = ['unused', 'used', 'damaged'] as const;

export default function ReturnForm() {
  const [firstName, setFirstName]   = useState('');
  const [lastName,  setLastName]    = useState('');
  const [email,     setEmail]       = useState('');
  const [phone,     setPhone]       = useState('');
  const [country,   setCountry]     = useState<'Canada' | 'USA'>('Canada');
  const [orderRef,  setOrderRef]    = useState('');
  const [serial,    setSerial]      = useState('');
  const [reason,    setReason]      = useState<typeof REASONS[number]>('Product Defect');
  const [condition, setCondition]   = useState<typeof CONDITIONS[number]>('unused');
  const [description, setDescription] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [returnRef,  setReturnRef]  = useState<string | null>(null);
  const [error,      setError]      = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    if (!firstName.trim() || !lastName.trim() || !email.trim()) {
      setError('Please fill in your name and email.');
      return;
    }
    if (!description.trim()) {
      setError('Please describe the issue so we can help.');
      return;
    }

    setSubmitting(true);
    try {
      const fullName = `${firstName.trim()} ${lastName.trim()}`;
      // Generate a customer-visible reference. Real RTN-#### will be
      // assigned by ops on triage; this client-side one is a hint so the
      // customer has something to quote in follow-up emails.
      const ref = `CRT-${Math.floor(Math.random() * 90000 + 10000)}`;
      const { error: insErr } = await supabase.from('returns').insert({
        customer_name: fullName,
        customer_email: email.trim(),
        customer_phone: phone.trim() || null,
        channel: country,
        unit_serial: serial.trim() || null,
        original_order_ref: orderRef.trim() || null,
        condition,
        reason,
        description: description.trim(),
        notes: `Customer reference: ${ref}`,
        status: 'created',
        source: 'customer_form',
      });
      if (insErr) throw insErr;
      setReturnRef(ref);
    } catch (err) {
      setError(`Could not submit: ${(err as Error).message}. Please email support@lilacomposter.com if this persists.`);
    } finally {
      setSubmitting(false);
    }
  };

  if (returnRef) {
    return (
      <FormLayout title="Return request received" intro="">
        <div className={styles.successCard}>
          <div className={styles.successIcon}>✓</div>
          <div className={styles.successTitle}>Thanks — we've received your return request.</div>
          <div className={styles.successSub}>
            Our team will review your request and get back to you within 1–2 business days with next steps,
            including pickup scheduling and refund eligibility.<br /><br />
            Save your reference number for follow-up emails:
          </div>
          <div className={styles.successRef}>{returnRef}</div>
          <div>
            <a href="https://lilacomposter.com" className={styles.successAction}>← Back to lilacomposter.com</a>
          </div>
        </div>
      </FormLayout>
    );
  }

  return (
    <FormLayout
      title="Return your LILA composter"
      intro="Sorry to hear it didn't work out. Please share a few details so our team can process your return. Most requests are reviewed within 1–2 business days."
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
          <label className={styles.fieldLabel}>Country<span className={styles.required}>*</span></label>
          <div className={styles.radioGroup}>
            {(['Canada', 'USA'] as const).map(c => (
              <button
                key={c}
                type="button"
                onClick={() => setCountry(c)}
                className={`${styles.radioBtn} ${country === c ? styles.radioBtnActive : ''}`}
              >{c}</button>
            ))}
          </div>
        </div>

        <div className={styles.fieldGrid2}>
          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel}>Order number</label>
            <input value={orderRef} onChange={e => setOrderRef(e.target.value)}
                   className={styles.input} placeholder="#1107" />
            <div className={styles.fieldHelp}>From your order confirmation email.</div>
          </div>
          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel}>Unit serial number</label>
            <input value={serial} onChange={e => setSerial(e.target.value)}
                   className={styles.input} placeholder="LL01-00000000123" />
            <div className={styles.fieldHelp}>Stamped on the bottom of your unit.</div>
          </div>
        </div>

        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Reason for return<span className={styles.required}>*</span></label>
          <select value={reason} onChange={e => setReason(e.target.value as typeof REASONS[number])}
                  className={styles.select} required>
            {REASONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>

        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Condition of the unit<span className={styles.required}>*</span></label>
          <div className={styles.radioGroup}>
            {CONDITIONS.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => setCondition(c)}
                className={`${styles.radioBtn} ${condition === c ? styles.radioBtnActive : ''}`}
              >{c.charAt(0).toUpperCase() + c.slice(1)}</button>
            ))}
          </div>
        </div>

        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Description<span className={styles.required}>*</span></label>
          <textarea value={description} onChange={e => setDescription(e.target.value)}
                    className={styles.textarea} required
                    placeholder="Please tell us what happened. Include dates, what you've tried, and any photos you can email to support@lilacomposter.com." />
        </div>

        <div className={styles.submitRow}>
          <button type="submit" className={styles.submitBtn} disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit return request'}
          </button>
        </div>
      </form>
    </FormLayout>
  );
}
