import { useState } from 'react';
import styles from './Hiring.module.css';
import {
  useJobPostings, updatePostingRubric, createJobPosting, addPostingInterviewer, searchInternalProfiles,
  suggestScreeningRubric, type RubricDimension, type PostingStatus, type InternalProfile,
} from '../../lib/hiring';

const STATUS_CLASS: Record<PostingStatus, string> = {
  open: styles.statusOpen, on_hold: styles.statusOnHold, closed: styles.statusClosed,
};
const STATUS_LABEL: Record<PostingStatus, string> = {
  open: 'Open', on_hold: 'On Hold', closed: 'Closed',
};

export function PostingsTab({ onSelectPosting }: { onSelectPosting: (id: string) => void }) {
  const { postings, loading } = useJobPostings();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);

  return (
    <div>
      <button onClick={() => setShowNewForm(v => !v)} style={{ marginBottom: 12 }}>
        {showNewForm ? 'Cancel' : '+ New Posting'}
      </button>
      {showNewForm && <NewPostingForm onCreated={() => setShowNewForm(false)} />}

      {loading && <div>Loading postings…</div>}
      {!loading && !postings.length && <div className={styles.empty}>No job postings yet.</div>}

      <div className={styles.postingsGrid}>
        {postings.map(p => (
          <div key={p.id} className={styles.postingCard}>
            <div className={styles.postingTitle} onClick={() => onSelectPosting(p.id)}>{p.title}</div>
            <div className={styles.postingMeta}>{p.department ?? '—'} · {p.location ?? '—'} · {p.comp_range ?? '—'}</div>
            <span className={`${styles.postingStatus} ${STATUS_CLASS[p.status]}`}>{STATUS_LABEL[p.status]}</span>
            <button
              style={{ marginLeft: 8, fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-ink-subtle)' }}
              onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
            >
              {expandedId === p.id ? 'Hide rubric ▲' : 'Edit rubric ▼'}
            </button>
            {expandedId === p.id && (
              <>
                <RubricEditor
                  postingId={p.id}
                  jobDescription={p.job_description}
                  rubric={p.screening_rubric}
                />
                <InterviewerAssignment postingId={p.id} />
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function NewPostingForm({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [department, setDepartment] = useState('');
  const [location, setLocation] = useState('');
  const [compRange, setCompRange] = useState('');
  const [indeedUrl, setIndeedUrl] = useState('');
  const [jobDescription, setJobDescription] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await createJobPosting({
        title: title.trim(),
        department: department.trim() || undefined,
        location: location.trim() || undefined,
        comp_range: compRange.trim() || undefined,
        indeed_url: indeedUrl.trim() || undefined,
        job_description: jobDescription.trim() || undefined,
      });
      onCreated();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.newPostingForm}>
      <input placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} />
      <input placeholder="Department" value={department} onChange={e => setDepartment(e.target.value)} />
      <input placeholder="Location" value={location} onChange={e => setLocation(e.target.value)} />
      <input placeholder="Comp range (e.g. $60-70k)" value={compRange} onChange={e => setCompRange(e.target.value)} />
      <input placeholder="Indeed posting URL" value={indeedUrl} onChange={e => setIndeedUrl(e.target.value)} />
      <textarea
        className={styles.jdTextarea}
        placeholder="Job description"
        value={jobDescription}
        onChange={e => setJobDescription(e.target.value)}
      />
      <button onClick={submit} disabled={saving || !title.trim()}>{saving ? 'Creating…' : 'Create posting'}</button>
    </div>
  );
}

function InterviewerAssignment({ postingId }: { postingId: string }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<InternalProfile[]>([]);
  const [searching, setSearching] = useState(false);
  const [added, setAdded] = useState<string[]>([]);

  async function search() {
    if (!query.trim()) return;
    setSearching(true);
    try { setResults(await searchInternalProfiles(query.trim())); }
    finally { setSearching(false); }
  }

  async function assign(profile: InternalProfile) {
    await addPostingInterviewer(postingId, profile.id);
    setAdded(prev => [...prev, profile.display_name]);
    setResults([]);
    setQuery('');
  }

  return (
    <div className={styles.interviewerWidget}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Assign interviewer</div>
      <input placeholder="Search by name…" value={query} onChange={e => setQuery(e.target.value)} style={{ fontSize: 12, padding: '4px 8px' }} />
      <button onClick={search} disabled={searching || !query.trim()} style={{ marginLeft: 6 }}>Search</button>
      {results.map(r => (
        <div key={r.id} className={styles.interviewerResult}>
          <span>{r.display_name}</span>
          <button onClick={() => assign(r)}>Add</button>
        </div>
      ))}
      {added.length > 0 && <div className={styles.interviewerList}>Assigned this session: {added.join(', ')}</div>}
    </div>
  );
}

function RubricEditor({ postingId, jobDescription, rubric }: {
  postingId: string; jobDescription: string | null; rubric: RubricDimension[];
}) {
  const [rows, setRows] = useState<RubricDimension[]>(rubric.length ? rubric : [{ dimension: '', weight_pct: 0 }]);
  const [suggesting, setSuggesting] = useState(false);
  const [saving, setSaving] = useState(false);

  async function suggestFromJd() {
    if (!jobDescription?.trim()) return;
    setSuggesting(true);
    try {
      const suggested = await suggestScreeningRubric(jobDescription);
      setRows(suggested);
    } finally {
      setSuggesting(false);
    }
  }

  async function save() {
    setSaving(true);
    try { await updatePostingRubric(postingId, rows.filter(r => r.dimension.trim())); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <button className={styles.suggestButton} onClick={suggestFromJd} disabled={suggesting || !jobDescription?.trim()}>
        {suggesting ? 'Suggesting…' : 'Suggest from JD'}
      </button>
      {rows.map((r, i) => (
        <div key={i} className={styles.rubricRow}>
          <input
            className={styles.rubricInput}
            placeholder="Dimension"
            value={r.dimension}
            onChange={e => setRows(prev => prev.map((row, idx) => idx === i ? { ...row, dimension: e.target.value } : row))}
          />
          <input
            className={styles.weightInput}
            type="number"
            placeholder="%"
            value={r.weight_pct || ''}
            onChange={e => setRows(prev => prev.map((row, idx) => idx === i ? { ...row, weight_pct: Number(e.target.value) } : row))}
          />
        </div>
      ))}
      <button onClick={() => setRows(prev => [...prev, { dimension: '', weight_pct: 0 }])}>+ Add dimension</button>
      <button onClick={save} disabled={saving} style={{ marginLeft: 8 }}>{saving ? 'Saving…' : 'Save rubric'}</button>
    </div>
  );
}
