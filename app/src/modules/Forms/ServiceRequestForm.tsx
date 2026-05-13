import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { FormLayout } from './FormLayout';
import styles from './Forms.module.css';

const ACCEPT_MIME = 'image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime,video/webm';
const MAX_FILE_SIZE = 26214400; // 25 MB
const MAX_FILES = 5;

type FormState = {
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  order_ref: string;
  unit_serial: string;
  category: 'support' | 'repair';
  subject: string;
  description: string;
};

const INITIAL: FormState = {
  customer_name: '',
  customer_email: '',
  customer_phone: '',
  order_ref: '',
  unit_serial: '',
  category: 'support',
  subject: '',
  description: '',
};

export default function ServiceRequestForm() {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticketNumber, setTicketNumber] = useState<string | null>(null);

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm(prev => ({ ...prev, [k]: v }));
  }

  function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    const valid: File[] = [];
    for (const f of picked) {
      if (f.size > MAX_FILE_SIZE) {
        setError(`${f.name} exceeds 25 MB limit.`);
        continue;
      }
      valid.push(f);
    }
    if (valid.length + files.length > MAX_FILES) {
      setError(`Max ${MAX_FILES} files total.`);
      setFiles(valid.concat(files).slice(0, MAX_FILES));
      return;
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
      if (!form.customer_name || !form.customer_email || !form.subject) {
        throw new Error('Name, email, and subject are required.');
      }
      // 1. Insert ticket, return id + ticket_number
      const { data: row, error: insErr } = await supabase
        .from('service_tickets')
        .insert({
          category:       form.category,
          source:         'customer_form',
          customer_name:  form.customer_name,
          customer_email: form.customer_email.toLowerCase(),
          customer_phone: form.customer_phone || null,
          order_ref:      form.order_ref || null,
          unit_serial:    form.unit_serial || null,
          subject:        form.subject,
          description:    form.description || null,
        })
        .select('id, ticket_number')
        .single();
      if (insErr || !row) throw new Error(insErr?.message ?? 'Failed to create ticket');
      const ticketId = row.id as string;

      // 2. Upload each file
      for (const f of files) {
        const path = `${ticketId}/${crypto.randomUUID()}-${f.name}`;
        const { error: upErr } = await supabase.storage
          .from('ticket-attachments')
          .upload(path, f, { contentType: f.type, upsert: false });
        if (upErr) throw new Error(`Upload failed (${f.name}): ${upErr.message}`);

        const { error: attErr } = await supabase
          .from('service_ticket_attachments')
          .insert({
            ticket_id:  ticketId,
            file_path:  path,
            file_name:  f.name,
            mime_type:  f.type,
            size_bytes: f.size,
          });
        if (attErr) throw new Error(`Attachment record failed (${f.name}): ${attErr.message}`);
      }

      setTicketNumber(row.ticket_number as string);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (ticketNumber) {
    return (
      <FormLayout title="Request received" intro="">
        <div className={styles.successCard}>
          <div className={styles.successIcon}>✓</div>
          <div className={styles.successTitle}>Thanks — we've received your service request.</div>
          <div className={styles.successSub}>
            Our team will get back to you within 1 business day. Save your reference number for follow-up:
          </div>
          <div className={styles.successRef}>{ticketNumber}</div>
          <div>
            <a href="https://lilacomposter.com" className={styles.successAction}>← Back to lilacomposter.com</a>
          </div>
        </div>
      </FormLayout>
    );
  }

  return (
    <FormLayout
      title="Service request"
      intro="Tell us what's going on with your LILA Pro and we'll get back to you within 1 business day. Required fields are marked with *."
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
          <label className={styles.fieldLabel}>Email <span className={styles.required}>*</span></label>
          <input className={styles.input} type="email" required value={form.customer_email}
            onChange={e => set('customer_email', e.target.value)} />
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Phone</label>
          <input className={styles.input} value={form.customer_phone}
            onChange={e => set('customer_phone', e.target.value)} />
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Order # (if known)</label>
          <input className={styles.input} value={form.order_ref}
            onChange={e => set('order_ref', e.target.value)} />
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Unit serial (if known)</label>
          <input className={styles.input} placeholder="LL01-..." value={form.unit_serial}
            onChange={e => set('unit_serial', e.target.value)} />
        </div>

        <div className={styles.sectionHeader}>What can we help with?</div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Request type <span className={styles.required}>*</span></label>
          <div className={styles.radioStack}>
            <button
              type="button"
              className={`${styles.radioBtn} ${form.category === 'support' ? styles.radioBtnActive : ''}`}
              onClick={() => set('category', 'support')}
            >General support / question</button>
            <button
              type="button"
              className={`${styles.radioBtn} ${form.category === 'repair' ? styles.radioBtnActive : ''}`}
              onClick={() => set('category', 'repair')}
            >Repair / hardware issue</button>
          </div>
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Subject <span className={styles.required}>*</span></label>
          <input className={styles.input} required value={form.subject}
            onChange={e => set('subject', e.target.value)} />
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Details</label>
          <textarea className={styles.textarea} rows={6} value={form.description}
            onChange={e => set('description', e.target.value)} />
        </div>

        <div className={styles.sectionHeader}>Photos / videos (optional)</div>
        <div className={styles.fieldRow}>
          <input type="file" multiple accept={ACCEPT_MIME} onChange={onFiles} />
          <div className={styles.fieldHelp}>
            Up to {MAX_FILES} files, 25 MB each. Images (jpg/png/webp/heic) and videos (mp4/mov/webm).
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
            {busy ? 'Submitting…' : 'Submit request'}
          </button>
        </div>
      </form>
    </FormLayout>
  );
}
