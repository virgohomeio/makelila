import { useState } from 'react';
import { submitShippingDamageClaim } from '../../lib/claims';
import { FormLayout } from './FormLayout';
import styles from './Forms.module.css';

const ACCEPT_MIME = 'image/jpeg,image/png,image/webp,image/heic,image/heif';
const MAX_FILE_SIZE = 26214400; // 25 MB
const MAX_FILES = 8;

type FormState = {
  customer_name: string;
  tracking_number: string;
  customer_email: string;
  customer_phone: string;
  description: string;
};

const INITIAL: FormState = {
  customer_name: '', tracking_number: '', customer_email: '', customer_phone: '', description: '',
};

export default function ShippingDamageForm() {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimRef, setClaimRef] = useState<string | null>(null);

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm(prev => ({ ...prev, [k]: v }));
  }

  function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    const valid: File[] = [];
    for (const f of picked) {
      if (f.size > MAX_FILE_SIZE) { setError(`${f.name} exceeds 25 MB limit.`); continue; }
      valid.push(f);
    }
    setError(null);
    setFiles(prev => prev.concat(valid).slice(0, MAX_FILES));
  }

  function removeFile(i: number) {
    setFiles(prev => prev.filter((_, idx) => idx !== i));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (!form.customer_name.trim() || !form.tracking_number.trim() || !form.description.trim()) {
        throw new Error('Name, tracking number, and a description of the damage are required.');
      }
      if (files.length === 0) {
        throw new Error('Please attach at least one photo of the damage.');
      }
      const ref = await submitShippingDamageClaim(
        {
          customer_name: form.customer_name,
          customer_email: form.customer_email,
          customer_phone: form.customer_phone,
          tracking_number: form.tracking_number,
          description: form.description,
        },
        files,
      );
      setClaimRef(ref);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (claimRef) {
    return (
      <FormLayout title="Claim received" intro="">
        <div className={styles.successCard}>
          <div className={styles.successIcon}>✓</div>
          <div className={styles.successTitle}>Thanks — we've received your shipping damage claim.</div>
          <div className={styles.successSub}>
            Our logistics team will review your photos and follow up. Save your reference number:
          </div>
          <div className={styles.successRef}>{claimRef}</div>
          <div>
            <a href="https://lilacomposter.com" className={styles.successAction}>← Back to lilacomposter.com</a>
          </div>
        </div>
      </FormLayout>
    );
  }

  return (
    <FormLayout
      title="LILA Shipping Damage Form"
      intro="Received your LILA Pro damaged in shipping? Tell us what happened and attach photos so we can make it right. Required fields are marked with *."
    >
      {error && <div className={styles.errorBanner}>{error}</div>}
      <form onSubmit={submit} className={styles.form}>
        <div className={styles.sectionHeader}>Your info</div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Name <span className={styles.required}>*</span></label>
          <input className={styles.input} required value={form.customer_name}
            onChange={e => set('customer_name', e.target.value)} />
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Tracking number <span className={styles.required}>*</span></label>
          <input className={styles.input} required value={form.tracking_number}
            onChange={e => set('tracking_number', e.target.value)} />
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Email</label>
          <input className={styles.input} type="email" value={form.customer_email}
            onChange={e => set('customer_email', e.target.value)} />
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Phone</label>
          <input className={styles.input} value={form.customer_phone}
            onChange={e => set('customer_phone', e.target.value)} />
        </div>

        <div className={styles.sectionHeader}>The damage</div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Describe the damage <span className={styles.required}>*</span></label>
          <textarea className={styles.textarea} rows={6} required value={form.description}
            onChange={e => set('description', e.target.value)} />
        </div>

        <div className={styles.sectionHeader}>Photos of the damage <span className={styles.required}>*</span></div>
        <div className={styles.fieldRow}>
          <input type="file" multiple accept={ACCEPT_MIME} onChange={onFiles} />
          <div className={styles.fieldHelp}>
            At least one photo required. Up to {MAX_FILES} images (jpg/png/webp/heic), 25 MB each.
          </div>
          {files.length > 0 && (
            <ul style={{ marginTop: 8, paddingLeft: 18 }}>
              {files.map((f, i) => (
                <li key={i} style={{ fontSize: 12 }}>
                  {f.name} ({Math.round(f.size / 1000)} KB){' '}
                  <button type="button" onClick={() => removeFile(i)} style={{ color: 'crimson', border: 'none', background: 'none', cursor: 'pointer' }}>remove</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={styles.submitRow}>
          <button type="submit" className={styles.submitBtn} disabled={busy}>
            {busy ? 'Submitting…' : 'Submit claim'}
          </button>
        </div>
      </form>
    </FormLayout>
  );
}
