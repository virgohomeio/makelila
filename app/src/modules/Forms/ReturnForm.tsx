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

const RETURN_CATEGORY_OPTIONS = [
  { value: 'product_defect',      label: 'Product Defect — hardware or mechanical problem' },
  { value: 'software_issue',      label: 'Software Issue — app, firmware, or connectivity' },
  { value: 'shipping_damage',     label: 'Shipping Damage — arrived damaged in transit' },
  { value: 'customer_service',    label: 'Customer Service Issue — unresolved support experience' },
  { value: 'financing',           label: 'Financing Issue — payment, financing, or billing problem' },
  { value: 'other',               label: 'Other' },
] as const;

function normalizeOrderRef(raw: string): string {
  const t = raw.trim();
  return t && !t.startsWith('#') ? `#${t}` : t;
}

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
  // 6. Return reasons (multi-select) + structured category
  const [reasons,       setReasons]       = useState<string[]>([]);
  const [reasonOther,   setReasonOther]   = useState('');   // mandatory when 'Other' reason checked
  const [returnCategory, setReturnCategory] = useState<string>('');
  const [categoryOther, setCategoryOther] = useState('');   // mandatory when category = 'other'
  // 7. Description
  const [description, setDescription] = useState('');
  // Purchaser: was the person filing the return the actual buyer?
  const [isPurchaser,    setIsPurchaser]    = useState<'' | 'yes' | 'no'>('');
  const [purchaserName,  setPurchaserName]  = useState('');
  const [purchaserEmail, setPurchaserEmail] = useState('');
  const [purchaserPhone, setPurchaserPhone] = useState('');
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
  // 18. Purchase proof file upload
  const [purchaseProofFile, setPurchaseProofFile] = useState<File | null>(null);
  // Order number validation
  const [orderValidating, setOrderValidating] = useState(false);
  const [orderFound, setOrderFound] = useState<boolean | null>(null);

  // Hidden / inferred
  const [country, setCountry] = useState<'Canada' | 'USA'>('Canada');
  const [serial,  setSerial]  = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [returnRef,  setReturnRef]  = useState<string | null>(null);
  const [error,      setError]      = useState<string | null>(null);

  const toggleReason = (r: string) => {
    setReasons(prev => prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r]);
  };

  // Confirm the order number exists. This public form runs as the anon role,
  // which has no SELECT on orders (RLS is authenticated + is_internal_user
  // only) — a direct .from('orders').select() returns null for every order and
  // wrongly reports "not found". Instead we call the return_form_order_exists
  // SECURITY DEFINER function, which anon may execute and which returns only a
  // boolean (no order rows / PII). On any error we leave orderFound null so the
  // submit path fails open rather than blocking a real customer.
  const validateOrderRef = async () => {
    const normalized = normalizeOrderRef(orderRef);
    if (!normalized) return;
    setOrderRef(normalized);
    setOrderValidating(true);
    setOrderFound(null);
    try {
      const { data, error } = await supabase.rpc('return_form_order_exists', { p_order_ref: normalized });
      setOrderFound(error ? null : data === true);
    } catch {
      setOrderFound(null);
    } finally {
      setOrderValidating(false);
    }
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
    if (orderFound !== true) {
      const normalized = normalizeOrderRef(orderRef);
      setOrderRef(normalized);
      setOrderValidating(true);
      try {
        const { data, error } = await supabase.rpc('return_form_order_exists', { p_order_ref: normalized });
        // Fail open on a validation-service error — never block a real customer
        // because the lookup itself failed.
        if (!error) {
          setOrderFound(data === true);
          if (data !== true) {
            setError(`${normalized} was not found in our system — please check the number (e.g. #1107). If you received the unit as a gift or have a different reference, contact us at support@lilacomposter.com.`);
            return;
          }
        }
      } catch {
        // Network error — don't block.
      } finally {
        setOrderValidating(false);
      }
    }
    if (!usage)     { setError('Please tell us how long you\'ve been using the unit.'); return; }
    if (reasons.length === 0) { setError('Please select at least one return reason.'); return; }
    if (reasons.includes('Other') && !reasonOther.trim()) {
      setError('Please describe your "Other" return reason.'); return;
    }
    if (!returnCategory) { setError('Please select the primary category for your return.'); return; }
    if (returnCategory === 'other' && !categoryOther.trim()) {
      setError('Please describe your "Other" primary reason.'); return;
    }
    if (!description.trim())  { setError('Please describe the issue in more detail.'); return; }
    if (!isPurchaser) { setError('Please tell us whether you were the purchaser of this unit.'); return; }
    if (isPurchaser === 'no' && (!purchaserName.trim() || !purchaserEmail.trim() || !purchaserPhone.trim())) {
      setError('Please provide the purchaser\'s full name, email, and phone number.'); return;
    }
    if (!support)   { setError('Please tell us whether you contacted support.'); return; }
    if (!rating)    { setError('Please rate your overall experience.'); return; }
    if (!future)    { setError('Please tell us how likely you are to consider LILA again.'); return; }
    if (!condition) { setError('Please select the unit condition.'); return; }
    if (!packaging) { setError('Please tell us about the packaging.'); return; }
    if (!alternative) { setError('Please select an alternative composting plan.'); return; }
    if (!refundMethod) { setError('Please select a refund method.'); return; }
    if (!purchaseProofFile) { setError('Please upload your proof of purchase (receipt, invoice, or order confirmation as PDF or image).'); return; }

    setSubmitting(true);
    try {
      const normalizedRef = normalizeOrderRef(orderRef);
      const filePath = `${normalizedRef.replace('#', '')}/${Date.now()}-${purchaseProofFile.name}`;
      const { error: uploadErr } = await supabase.storage.from('return-documents').upload(filePath, purchaseProofFile);
      if (uploadErr) throw uploadErr;

      const fullName = `${firstName.trim()} ${lastName.trim()}`;
      // Fold the free-text into the "Other" reason so it shows in the reasons list.
      const reasonsForInsert = reasons.map(r =>
        r === 'Other' && reasonOther.trim() ? `Other — ${reasonOther.trim()}` : r);
      const ref = `CRT-${Math.floor(Math.random() * 90000 + 10000)}`;
      // Generate the id client-side so we don't read the row back with
      // .select() — customers submit anonymously (anon role), which has INSERT
      // but no SELECT policy on `returns`, so insert().select() would fail for
      // them even though the insert is allowed.
      const returnId = crypto.randomUUID();
      const { error: insErr } = await supabase.from('returns').insert({
        id: returnId,
        customer_name: fullName,
        customer_email: email.trim(),
        customer_phone: phone.trim() || null,
        channel: country,
        unit_serial: serial.trim() || null,
        original_order_ref: normalizedRef,
        condition,
        reason: reasonsForInsert[0] ?? null,  // primary reason for the legacy reason column
        return_category: returnCategory || null,
        category_other: returnCategory === 'other' ? categoryOther.trim() : null,
        description: description.trim(),
        // Purchaser identity — when the filer isn't the buyer, the refund
        // workflow uses the purchaser as the customer on the card.
        is_purchaser: isPurchaser === 'yes',
        purchaser_name:  isPurchaser === 'no' ? purchaserName.trim() : null,
        purchaser_email: isPurchaser === 'no' ? purchaserEmail.trim() : null,
        purchaser_phone: isPurchaser === 'no' ? purchaserPhone.trim() : null,
        notes: `Customer reference: ${ref}`,
        status: 'created',
        source: 'customer_form',
        // Extended fields
        usage_duration: usage,
        return_reasons: reasonsForInsert,
        support_contacted: support,
        experience_rating: rating,
        would_change_decision: wouldChange.trim() || null,
        future_likelihood: future,
        packaging_status: packaging,
        alternative_composting: alternative,
        refund_method_preference: refundMethod,
        refund_contact: refundContact.trim() || null,
        additional_comments: additional.trim() || null,
        purchase_proof: filePath,
      });
      if (insErr) throw insErr;

      // Fire-and-forget: send confirmation to customer + review email to Reina/George
      supabase.functions.invoke('send-return-emails', { body: { return_id: returnId } }).catch(() => {});

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
      title="LILA Pro Return Application"
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
            <input value={orderRef}
                   onChange={e => { setOrderRef(e.target.value); setOrderFound(null); }}
                   onBlur={validateOrderRef}
                   className={styles.input} placeholder="#1107" required />
            {orderValidating && <div className={styles.fieldHelp} style={{color:'#718096'}}>Checking…</div>}
            {!orderValidating && orderFound === true && <div className={styles.fieldHelp} style={{color:'#276749'}}>✓ Order found</div>}
            {!orderValidating && orderFound === false && <div className={styles.fieldHelp} style={{color:'#c53030'}}>Order not found — please check the number (e.g. #1107).</div>}
          </Field>
          <Field label="Unit serial number" help="Stamped on the bottom of your unit. Optional.">
            <input value={serial} onChange={e => setSerial(e.target.value)}
                   className={styles.input} placeholder="LL01-00000000123" />
          </Field>
        </div>

        {/* Purchaser check */}
        <Field label="Were you the purchaser of this unit?" required>
          <RadioGroup
            options={['Yes', 'No']}
            value={isPurchaser === 'yes' ? 'Yes' : isPurchaser === 'no' ? 'No' : ''}
            onChange={(v) => setIsPurchaser(v === 'Yes' ? 'yes' : 'no')}
          />
        </Field>
        {isPurchaser === 'no' && (
          <div className={styles.fieldGrid2}>
            <Field label="Purchaser's full name" required>
              <input value={purchaserName} onChange={e => setPurchaserName(e.target.value)}
                     className={styles.input} required placeholder="Full name of the person who bought it" />
            </Field>
            <Field label="Purchaser's email" required>
              <input type="email" value={purchaserEmail} onChange={e => setPurchaserEmail(e.target.value)}
                     className={styles.input} required placeholder="purchaser@example.com" />
            </Field>
            <Field label="Purchaser's phone number" required>
              <input type="tel" value={purchaserPhone} onChange={e => setPurchaserPhone(e.target.value)}
                     className={styles.input} required placeholder="(000) 000-0000" />
            </Field>
          </div>
        )}

        {/* 5. Usage duration */}
        <Field label="How long have you been using your LILA Pro?" required>
          <RadioGroup options={USAGE_OPTIONS} value={usage} onChange={setUsage} />
        </Field>

        {/* 6. Return reasons (multi-select) */}
        <SectionHeader text="Why you're returning" />
        <Field label="Why are you returning your LILA Pro? (Select all that apply)" required>
          <CheckboxGroup options={RETURN_REASONS} values={reasons} onToggle={toggleReason} />
          {reasons.includes('Other') && (
            <div style={{ marginTop: 10 }}>
              <label className={styles.fieldLabel}>
                Please describe your "Other" reason<span className={styles.required}>*</span>
              </label>
              <textarea value={reasonOther} onChange={e => setReasonOther(e.target.value)}
                        className={styles.textarea} required
                        placeholder="Tell us what issue you faced." />
            </div>
          )}
        </Field>

        <Field label="What best describes the primary reason for your return?" required>
          <select
            value={returnCategory}
            onChange={e => setReturnCategory(e.target.value)}
            className={styles.input}
          >
            <option value="">Select a category…</option>
            {RETURN_CATEGORY_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {returnCategory === 'other' && (
            <div style={{ marginTop: 10 }}>
              <label className={styles.fieldLabel}>
                Please describe your "Other" primary reason<span className={styles.required}>*</span>
              </label>
              <textarea value={categoryOther} onChange={e => setCategoryOther(e.target.value)}
                        className={styles.textarea} required
                        placeholder="Tell us what issue you faced." />
            </div>
          )}
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

        {/* 18. Purchase proof */}
        <Field label="Proof of purchase" required help="Upload a PDF or photo of your receipt, invoice, or order confirmation (max 10 MB). If the unit was a gift, upload the original purchaser's receipt or order confirmation.">
          <input
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp,image/gif,image/heic"
            className={styles.input}
            onChange={e => setPurchaseProofFile(e.target.files?.[0] ?? null)}
          />
          {purchaseProofFile && (
            <div className={styles.fieldHelp}>
              Selected: {purchaseProofFile.name} ({(purchaseProofFile.size / 1024).toFixed(0)} KB)
            </div>
          )}
        </Field>

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
