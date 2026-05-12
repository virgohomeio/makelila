import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { FormLayout } from './FormLayout';
import styles from './Forms.module.css';

const USAGE_OPTIONS = [
  'Less than 1 week',
  '1–4 weeks',
  '1–3 months',
  '3–6 months',
  '6+ months',
] as const;

const RETURN_REASONS = [
  "It doesn't actually compost — just dehydrates",
  'Odor issues',
  'Too noisy',
  'Too large for my kitchen',
  'Difficult to use or maintain',
  'Compost output quality not as expected',
  'Device malfunction or hardware issue',
  'Ongoing costs too high (filters, starter, energy)',
  'Not worth the price overall',
  'Lifestyle change — no longer need it',
  'Other',
] as const;

const SUPPORT_OPTIONS = [
  "Yes — they tried to help but the issue wasn't resolved",
  'Yes — but response was too slow',
  "No — I didn't try",
  "No — I didn't know how to reach support",
] as const;

const FUTURE_OPTIONS = [
  'Definitely',
  'Probably',
  'Maybe / Unsure',
  'Probably Not',
  'Definitely Not',
] as const;

const CONDITION_OPTIONS = [
  { value: 'like-new', label: 'Like new — minimal use, no damage' },
  { value: 'good',     label: 'Good — normal wear from regular use' },
  { value: 'fair',     label: 'Fair — some cosmetic wear or minor issues' },
  { value: 'damaged',  label: 'Damaged — hardware defect or physical damage' },
] as const;

const PACKAGING_OPTIONS = [
  'Yes — complete original packaging',
  'Partial — some packaging materials',
  'No — packaging was discarded',
] as const;

const ALTERNATIVE_OPTIONS = [
  'Green bin / city compost',
  'Outdoor compost bin',
  'Other electric composter',
  'None — not composting anymore',
] as const;

const REFUND_METHOD_OPTIONS = [
  'Email (E-Transfer)',
  'Credit Card (Enter phone number below, we will call you)',
] as const;

export default function ReturnForm() {
  // 1. Name
  const [firstName, setFirstName] = useState('');
  const [lastName,  setLastName]  = useState('');
  // 2-3. Email + Phone
  const [email,     setEmail]     = useState('');
  const [phone,     setPhone]     = useState('');
  // 4. Order number
  const [orderRef,  setOrderRef]  = useState('');
  // 5. Usage duration
  const [usage,     setUsage]     = useState<string>('');
  // 6. Return reasons (multi-select)
  const [reasons,   setReasons]   = useState<string[]>([]);
  // 7. Description
  const [description, setDescription] = useState('');
  // 8. Support contacted
  const [support,   setSupport]   = useState<string>('');
  // 9. Star rating
  const [rating,    setRating]    = useState<number>(0);
  // 10. Would have changed
  const [wouldChange, setWouldChange] = useState('');
  // 11. Future likelihood
  const [future,    setFuture]    = useState<string>('');
  // 12. Condition
  const [condition, setCondition] = useState<string>('');
  // 13. Packaging
  const [packaging, setPackaging] = useState<string>('');
  // 14. Alternative
  const [alternative, setAlternative] = useState<string>('');
  // 15. Refund method
  const [refundMethod, setRefundMethod] = useState<string>('');
  // 16. Refund contact (e-transfer email / callback phone)
  const [refundContact, setRefundContact] = useState('');
  // 17. Anything else
  const [additional, setAdditional] = useState('');

  // Hidden / inferred
  const [country, setCountry] = useState<'Canada' | 'USA'>('Canada');
  const [serial,  setSerial]  = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [returnRef,  setReturnRef]  = useState<string | null>(null);
  const [error,      setError]      = useState<string | null>(null);

  const toggleReason = (r: string) => {
    setReasons(prev => prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r]);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    // Required-field validation matching Jotform's red asterisks
    if (!firstName.trim() || !lastName.trim() || !email.trim()) {
      setError('Please fill in your name and email.');
      return;
    }
    if (!orderRef.trim()) { setError('Please include your order number.'); return; }
    if (!usage)     { setError('Please tell us how long you\'ve been using the unit.'); return; }
    if (reasons.length === 0) { setError('Please select at least one return reason.'); return; }
    if (!description.trim())  { setError('Please describe the issue in more detail.'); return; }
    if (!support)   { setError('Please tell us whether you contacted support.'); return; }
    if (!rating)    { setError('Please rate your overall experience.'); return; }
    if (!future)    { setError('Please tell us how likely you are to consider LILA again.'); return; }
    if (!condition) { setError('Please select the unit condition.'); return; }
    if (!packaging) { setError('Please tell us about the packaging.'); return; }
    if (!alternative) { setError('Please select an alternative composting plan.'); return; }
    if (!refundMethod) { setError('Please select a refund method.'); return; }

    setSubmitting(true);
    try {
      const fullName = `${firstName.trim()} ${lastName.trim()}`;
      const ref = `CRT-${Math.floor(Math.random() * 90000 + 10000)}`;
      const { error: insErr } = await supabase.from('returns').insert({
        customer_name: fullName,
        customer_email: email.trim(),
        customer_phone: phone.trim() || null,
        channel: country,
        unit_serial: serial.trim() || null,
        original_order_ref: orderRef.trim(),
        condition,
        reason: reasons[0] ?? null,           // primary reason for the legacy reason column
        description: description.trim(),
        notes: `Customer reference: ${ref}`,
        status: 'created',
        source: 'customer_form',
        // Extended fields
        usage_duration: usage,
        return_reasons: reasons,
        support_contacted: support,
        experience_rating: rating,
        would_change_decision: wouldChange.trim() || null,
        future_likelihood: future,
        packaging_status: packaging,
        alternative_composting: alternative,
        refund_method_preference: refundMethod,
        refund_contact: refundContact.trim() || null,
        additional_comments: additional.trim() || null,
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
      title="LILA Pro Return Form"
      intro="Sorry it didn't work out. Please share a few details so our team can process your return. Required fields are marked with *."
    >
      {error && <div className={styles.errorBanner}>{error}</div>}
      <form className={styles.form} onSubmit={submit}>

        {/* 1. Name */}
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

        {/* 2-3. Email + Phone */}
        <div className={styles.fieldGrid2}>
          <Field label="Email" required>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                   className={styles.input} placeholder="example@example.com" required />
          </Field>
          <Field label="Phone number">
            <input type="tel" value={phone} onChange={e => setPhone(e.target.value)}
                   className={styles.input} placeholder="(000) 000-0000" />
          </Field>
        </div>

        <Field label="Country">
          <RadioGroup options={['Canada', 'USA']} value={country} onChange={(v) => setCountry(v as 'Canada' | 'USA')} />
        </Field>

        {/* 4. Order */}
        <SectionHeader text="About your order" />
        <div className={styles.fieldGrid2}>
          <Field label="Order number" required>
            <input value={orderRef} onChange={e => setOrderRef(e.target.value)}
                   className={styles.input} placeholder="#1107" required />
          </Field>
          <Field label="Unit serial number" help="Stamped on the bottom of your unit. Optional.">
            <input value={serial} onChange={e => setSerial(e.target.value)}
                   className={styles.input} placeholder="LL01-00000000123" />
          </Field>
        </div>

        {/* 5. Usage duration */}
        <Field label="How long have you been using your LILA Pro?" required>
          <RadioGroup options={USAGE_OPTIONS} value={usage} onChange={setUsage} />
        </Field>

        {/* 6. Return reasons (multi-select) */}
        <SectionHeader text="Why you're returning" />
        <Field label="Why are you returning your LILA Pro? (Select all that apply)" required>
          <CheckboxGroup options={RETURN_REASONS} values={reasons} onToggle={toggleReason} />
        </Field>

        {/* 7. Description */}
        <Field label="Please describe the issue(s) in more detail" required>
          <textarea value={description} onChange={e => setDescription(e.target.value)}
                    className={styles.textarea} required
                    placeholder="Include dates, what you've tried, and any context that helps us respond quickly." />
        </Field>

        {/* 8. Support contacted */}
        <Field label="Did you contact our support team before deciding to return?" required>
          <RadioGroup options={SUPPORT_OPTIONS} value={support} onChange={setSupport} stacked />
        </Field>

        {/* 9. Star rating */}
        <SectionHeader text="Your experience" />
        <Field label="How would you rate your overall experience with LILA Pro?" required>
          <StarRating value={rating} onChange={setRating} />
        </Field>

        {/* 10. Would have changed */}
        <Field label="What (if anything) would have changed your decision to return?">
          <textarea value={wouldChange} onChange={e => setWouldChange(e.target.value)}
                    className={styles.textarea}
                    placeholder="Optional. Helps us improve the product." />
        </Field>

        {/* 11. Future likelihood */}
        <Field label="How likely are you to consider LILA again in the future (e.g. next-gen model)?" required>
          <RadioGroup options={FUTURE_OPTIONS} value={future} onChange={setFuture} />
        </Field>

        {/* 12. Condition */}
        <SectionHeader text="About the unit" />
        <Field label="What is the condition of your LILA Pro unit?" required>
          <RadioGroup
            options={CONDITION_OPTIONS.map(c => c.label)}
            value={CONDITION_OPTIONS.find(c => c.value === condition)?.label ?? ''}
            onChange={(label) => setCondition(CONDITION_OPTIONS.find(c => c.label === label)?.value ?? '')}
            stacked
          />
        </Field>

        {/* 13. Packaging */}
        <Field label="Do you still have the original packaging?" required>
          <RadioGroup options={PACKAGING_OPTIONS} value={packaging} onChange={setPackaging} stacked />
        </Field>

        {/* 14. Alternative composting */}
        <Field label="Which composting alternative will you use instead?" required>
          <RadioGroup options={ALTERNATIVE_OPTIONS} value={alternative} onChange={setAlternative} stacked />
        </Field>

        {/* 15. Refund method */}
        <SectionHeader text="Refund preference" />
        <Field label="How would you like your refund?" required>
          <RadioGroup options={REFUND_METHOD_OPTIONS} value={refundMethod} onChange={setRefundMethod} stacked />
        </Field>

        {/* 16. Refund contact (conditional shown if refundMethod is set) */}
        {refundMethod && (
          <Field
            label={refundMethod.startsWith('Email') ? 'E-Transfer email' : 'Callback phone number'}
            help={refundMethod.startsWith('Email')
              ? 'Where to send the e-transfer.'
              : 'We will call this number to take your card details.'}
          >
            <input value={refundContact} onChange={e => setRefundContact(e.target.value)}
                   className={styles.input}
                   placeholder={refundMethod.startsWith('Email') ? 'you@example.com' : '(000) 000-0000'} />
          </Field>
        )}

        {/* 17. Anything else */}
        <Field label="Is there anything else you would like to share with us?">
          <textarea value={additional} onChange={e => setAdditional(e.target.value)}
                    className={styles.textarea} rows={3} />
        </Field>

        <div className={styles.submitRow}>
          <button type="submit" className={styles.submitBtn} disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit return request'}
          </button>
        </div>
      </form>
    </FormLayout>
  );
}

// ============================================================================
// Field building blocks
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

function CheckboxGroup({
  options, values, onToggle,
}: { options: readonly string[]; values: string[]; onToggle: (v: string) => void }) {
  return (
    <div className={styles.checkboxStack}>
      {options.map(opt => {
        const checked = values.includes(opt);
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onToggle(opt)}
            className={`${styles.checkboxRow} ${checked ? styles.checkboxRowActive : ''}`}
          >
            <span className={styles.checkboxBox}>{checked ? '✓' : ''}</span>
            <span>{opt}</span>
          </button>
        );
      })}
    </div>
  );
}

function StarRating({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className={styles.starRow}>
      {[1, 2, 3, 4, 5].map(n => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          className={`${styles.starBtn} ${n <= value ? styles.starBtnActive : ''}`}
          aria-label={`${n} star${n === 1 ? '' : 's'}`}
        >★</button>
      ))}
      <span className={styles.starLabel}>
        {value === 0 ? 'Select rating' :
         value === 1 ? 'Terrible' :
         value === 2 ? 'Below expectations' :
         value === 3 ? 'Average' :
         value === 4 ? 'Good' : 'Excellent'}
      </span>
    </div>
  );
}
