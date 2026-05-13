import { useMemo, useState } from 'react';
import {
  useEmailTemplates, useEmailMessages, updateTemplate, sendTemplate, renderTemplate,
  CATEGORY_META,
  type EmailTemplate, type TemplateCategory,
} from '../../lib/templates';
import styles from './Templates.module.css';

const CATEGORIES: TemplateCategory[] = [
  'order_review','fulfillment','post_shipment',
  'returns_refunds','replacements','support',
];

export default function Templates() {
  const { templates, loading } = useEmailTemplates();
  const { messages } = useEmailMessages();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | TemplateCategory>('all');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return templates.filter(t => {
      if (filter !== 'all' && t.category !== filter) return false;
      if (q && !(
        t.key.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.description?.toLowerCase().includes(q) ||
        t.subject.toLowerCase().includes(q)
      )) return false;
      return true;
    });
  }, [templates, filter, search]);

  const grouped = useMemo(() => {
    const m = new Map<TemplateCategory, EmailTemplate[]>();
    for (const t of filtered) {
      if (!m.has(t.category)) m.set(t.category, []);
      m.get(t.category)!.push(t);
    }
    return m;
  }, [filtered]);

  const selected = useMemo(
    () => templates.find(t => t.id === selectedId) ?? null,
    [templates, selectedId],
  );

  const recentSendsForSelected = useMemo(
    () => selected ? messages.filter(m => m.template_key === selected.key).slice(0, 10) : [],
    [selected, messages],
  );

  if (loading) return <div className={styles.loading}>Loading templates…</div>;

  return (
    <div className={styles.layout}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHead}>
          <div className={styles.sidebarTitle}>Email Templates</div>
          <div className={styles.sidebarSub}>{templates.length} templates · {messages.length} sends</div>
        </div>
        <div className={styles.filters}>
          <button
            className={`${styles.chip} ${filter === 'all' ? styles.chipActive : ''}`}
            onClick={() => setFilter('all')}
          >All</button>
          {CATEGORIES.map(c => (
            <button
              key={c}
              className={`${styles.chip} ${filter === c ? styles.chipActive : ''}`}
              onClick={() => setFilter(c)}
            >{CATEGORY_META[c].label}</button>
          ))}
        </div>
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search key, name, subject…"
          className={styles.search}
        />
        <div className={styles.tmplList}>
          {CATEGORIES.map(cat => {
            const rows = grouped.get(cat);
            if (!rows || rows.length === 0) return null;
            return (
              <div key={cat} className={styles.tmplGroup}>
                <div className={styles.tmplGroupHead}
                     style={{ color: CATEGORY_META[cat].color }}>
                  {CATEGORY_META[cat].label}
                </div>
                {rows.map(t => (
                  <button
                    key={t.id}
                    onClick={() => setSelectedId(t.id)}
                    className={`${styles.tmplRow} ${selectedId === t.id ? styles.tmplRowActive : ''}`}
                  >
                    <div className={styles.tmplRowName}>{t.name}</div>
                    <div className={styles.tmplRowKey}>{t.key}</div>
                    {!t.active && <span className={styles.inactivePill}>inactive</span>}
                  </button>
                ))}
              </div>
            );
          })}
          {filtered.length === 0 && <div className={styles.empty}>No templates match.</div>}
        </div>
      </aside>

      <section className={styles.detail}>
        {!selected ? (
          <div className={styles.placeholder}>
            <div className={styles.placeholderIcon}>📧</div>
            <div>Select a template to view, edit, or send.</div>
          </div>
        ) : (
          <TemplateDetail
            template={selected}
            recentSends={recentSendsForSelected}
            onError={setError}
          />
        )}
        {error && <div className={styles.errorBar}>{error}</div>}
      </section>
    </div>
  );
}

// ============================================================================
// Detail panel — edit + preview + send
// ============================================================================
function TemplateDetail({
  template, recentSends, onError,
}: {
  template: EmailTemplate;
  recentSends: Array<{ id: string; recipient_email: string; sent_at: string | null; status: string; subject: string }>;
  onError: (msg: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [name,        setName]        = useState(template.name);
  const [description, setDescription] = useState(template.description ?? '');
  const [subject,     setSubject]     = useState(template.subject);
  const [body,        setBody]        = useState(template.body);
  const [saving,      setSaving]      = useState(false);

  // Sync local state if user selects a different template
  const tplKey = template.id;
  useResetOnChange(tplKey, () => {
    setName(template.name);
    setDescription(template.description ?? '');
    setSubject(template.subject);
    setBody(template.body);
    setEditing(false);
    setShowSend(false);
  });

  const meta = CATEGORY_META[template.category];

  const save = async () => {
    setSaving(true); onError(null);
    try {
      await updateTemplate(template.id, {
        name: name.trim(),
        description: description.trim() || undefined,
        subject,
        body,
      });
      setEditing(false);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.detailInner}>
      <div className={styles.detailHead}>
        <div>
          <div className={styles.detailTitleRow}>
            <h2 className={styles.detailTitle}>{template.name}</h2>
            <span className={styles.catTag} style={{ color: meta.color, background: meta.bg }}>
              {meta.label}
            </span>
            {!template.active && <span className={styles.inactivePill}>inactive</span>}
          </div>
          <div className={styles.detailKey}>{template.key}</div>
          {template.description && !editing && (
            <div className={styles.detailDesc}>{template.description}</div>
          )}
        </div>
        <div className={styles.detailActions}>
          {!editing && (
            <>
              <button onClick={() => setEditing(true)} className={styles.btnSecondary}>Edit</button>
              <button onClick={() => setShowSend(true)} className={styles.btnPrimary}>Send →</button>
            </>
          )}
          {editing && (
            <>
              <button onClick={() => { setEditing(false); setName(template.name); setSubject(template.subject); setBody(template.body); setDescription(template.description ?? ''); }}
                      className={styles.btnSecondary}>Cancel</button>
              <button onClick={() => void save()} disabled={saving} className={styles.btnPrimary}>
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </>
          )}
        </div>
      </div>

      {editing ? (
        <EditView
          name={name} setName={setName}
          description={description} setDescription={setDescription}
          subject={subject} setSubject={setSubject}
          body={body} setBody={setBody}
          variables={template.variables}
        />
      ) : showSend ? (
        <SendView template={template} onClose={() => setShowSend(false)} onError={onError} />
      ) : (
        <PreviewView template={template} />
      )}

      {!editing && !showSend && recentSends.length > 0 && (
        <div className={styles.recentSends}>
          <div className={styles.recentSendsHead}>Recent sends</div>
          <table className={styles.recentSendsTable}>
            <thead>
              <tr><th>Recipient</th><th>Status</th><th>Sent</th></tr>
            </thead>
            <tbody>
              {recentSends.map(m => (
                <tr key={m.id}>
                  <td>{m.recipient_email}</td>
                  <td><span className={`${styles.msgStatus} ${styles[`msgStatus_${m.status}`]}`}>{m.status}</span></td>
                  <td className={styles.mono}>{m.sent_at ? new Date(m.sent_at).toLocaleString('en-US') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PreviewView({ template }: { template: EmailTemplate }) {
  return (
    <div className={styles.previewCard}>
      <div className={styles.previewHeadRow}>
        <span className={styles.previewLabel}>Subject:</span>
        <span className={styles.previewSubject}>{template.subject}</span>
      </div>
      <div className={styles.previewBody}>{template.body}</div>
      {template.variables.length > 0 && (
        <div className={styles.varHint}>
          <span className={styles.varHintLabel}>Variables:</span>
          {template.variables.map(v => (
            <code key={v} className={styles.varTag}>{`{{${v}}}`}</code>
          ))}
        </div>
      )}
    </div>
  );
}

function EditView({
  name, setName, description, setDescription, subject, setSubject, body, setBody, variables,
}: {
  name: string; setName: (v: string) => void;
  description: string; setDescription: (v: string) => void;
  subject: string; setSubject: (v: string) => void;
  body: string; setBody: (v: string) => void;
  variables: string[];
}) {
  return (
    <div className={styles.editCard}>
      <Field label="Display name">
        <input value={name} onChange={e => setName(e.target.value)} className={styles.input} />
      </Field>
      <Field label="Description (when to use this template)">
        <textarea value={description} onChange={e => setDescription(e.target.value)}
                  className={styles.textarea} rows={2} />
      </Field>
      <Field label="Subject line">
        <input value={subject} onChange={e => setSubject(e.target.value)} className={styles.input} />
      </Field>
      <Field label="Body">
        <textarea value={body} onChange={e => setBody(e.target.value)}
                  className={styles.textarea} rows={16} />
      </Field>
      <div className={styles.varHint}>
        <span className={styles.varHintLabel}>Available variables:</span>
        {variables.map(v => (
          <code key={v} className={styles.varTag}>{`{{${v}}}`}</code>
        ))}
      </div>
    </div>
  );
}

function SendView({
  template, onClose, onError,
}: {
  template: EmailTemplate;
  onClose: () => void;
  onError: (m: string | null) => void;
}) {
  const [to, setTo] = useState('');
  const [toName, setToName] = useState('');
  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  // Live preview
  const previewSubject = useMemo(
    () => renderTemplate(template.subject, varValues),
    [template.subject, varValues],
  );
  const previewBody = useMemo(
    () => renderTemplate(template.body, varValues),
    [template.body, varValues],
  );

  const run = async () => {
    if (!to.trim()) { onError('Recipient email is required.'); return; }
    setSending(true); onError(null); setSuccess(null);
    try {
      const r = await sendTemplate({
        template_key: template.key,
        to: to.trim(),
        to_name: toName.trim() || undefined,
        variables: varValues,
      });
      setSuccess(`Sent! Message id: ${r.message_id} · Resend id: ${r.resend_id}`);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={styles.sendGrid}>
      <div className={styles.sendForm}>
        <Field label="To (email)">
          <input value={to} onChange={e => setTo(e.target.value)} type="email" className={styles.input}
                 placeholder="customer@example.com" />
        </Field>
        <Field label="Recipient name (optional)">
          <input value={toName} onChange={e => setToName(e.target.value)} className={styles.input}
                 placeholder="Ron Russell" />
        </Field>
        {template.variables.length > 0 && (
          <div className={styles.varInputs}>
            <div className={styles.varInputsHead}>Variables</div>
            {template.variables.map(v => (
              <Field key={v} label={v}>
                <input
                  value={varValues[v] ?? ''}
                  onChange={e => setVarValues(prev => ({ ...prev, [v]: e.target.value }))}
                  className={styles.input}
                  placeholder={`Value for {{${v}}}`}
                />
              </Field>
            ))}
          </div>
        )}
        <div className={styles.sendActions}>
          <button onClick={onClose} className={styles.btnSecondary} disabled={sending}>Cancel</button>
          <button onClick={() => void run()} className={styles.btnPrimary} disabled={sending}>
            {sending ? 'Sending…' : `Send to ${to || '…'}`}
          </button>
        </div>
        {success && <div className={styles.successBar}>✓ {success}</div>}
      </div>
      <div className={styles.sendPreview}>
        <div className={styles.previewHeadRow}>
          <span className={styles.previewLabel}>Subject:</span>
          <span className={styles.previewSubject}>{previewSubject}</span>
        </div>
        <div className={styles.previewBody}>{previewBody}</div>
        <div className={styles.previewFooter}>
          From: VCycene Team &lt;support@lilacomposter.com&gt;
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.fieldRow}>
      <label className={styles.fieldLabel}>{label}</label>
      {children}
    </div>
  );
}

// Reset local state when the dependency changes (typical "useEffect on key" trick).
function useResetOnChange<T>(key: T, reset: () => void) {
  const [prev, setPrev] = useState<T>(key);
  if (prev !== key) {
    setPrev(key);
    reset();
  }
}
