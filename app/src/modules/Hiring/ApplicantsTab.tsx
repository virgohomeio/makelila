import { useState } from 'react';
import styles from './Hiring.module.css';
import { ResumeUploadPanel } from './ResumeUploadPanel';
import {
  useJobPostings, useCandidates, updateCandidateStage, recordCandidateScore, rejectCandidate, hireCandidate,
  getResumeObjectUrl, type Candidate, type CandidateSource,
} from '../../lib/hiring';

const SOURCE_LABEL: Record<CandidateSource, string> = {
  indeed: 'Indeed',
  linkedin: 'LinkedIn',
  referral: 'Referral',
  other: 'Other',
  university_of_waterloo: 'University of Waterloo',
  university_of_toronto: 'University of Toronto',
  york_university: 'York University',
};

const SOURCES = Object.keys(SOURCE_LABEL) as CandidateSource[];

export function ApplicantsTab({ onSelectCandidate }: { onSelectCandidate: (id: string) => void }) {
  const { postings, loading } = useJobPostings();

  if (loading) return <div>Loading postings…</div>;
  if (!postings.length) return <div className={styles.empty}>No job postings yet.</div>;

  return (
    <div className={styles.board}>
      {postings.map(p => (
        <PostingColumn
          key={p.id}
          postingId={p.id}
          title={p.title}
          pipelineStages={p.pipeline_stages}
          onSelectCandidate={onSelectCandidate}
        />
      ))}
    </div>
  );
}

function PostingColumn({ postingId, title, pipelineStages, onSelectCandidate }: {
  postingId: string; title: string; pipelineStages: string[]; onSelectCandidate: (id: string) => void;
}) {
  const { candidates, loading } = useCandidates(postingId);
  // Two separate source pickers, because they answer different questions: one
  // tags the resumes being uploaded, the other narrows the list on screen.
  // They used to be a single control, which read as a filter and did nothing.
  const [uploadSource, setUploadSource] = useState<CandidateSource>('indeed');
  const [sourceFilter, setSourceFilter] = useState<CandidateSource | 'all'>('all');
  const shown = sourceFilter === 'all' ? candidates : candidates.filter(c => c.source === sourceFilter);

  return (
    <div className={styles.column}>
      <div className={styles.columnHeader}>
        {title}
        <span className={styles.columnCount}>
          {sourceFilter === 'all' ? `· ${candidates.length}` : `· ${shown.length} of ${candidates.length}`}
        </span>
      </div>
      <label className={styles.selectLabel}>
        Source for uploaded resumes
        <select
          className={styles.stageSelect}
          value={uploadSource}
          onChange={e => setUploadSource(e.target.value as CandidateSource)}
        >
          {SOURCES.map(s => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
        </select>
      </label>
      <ResumeUploadPanel postingId={postingId} source={uploadSource} onUploaded={() => {}} />
      <h3 style={{ marginTop: 20 }}>Applicants</h3>
      <label className={styles.selectLabel}>
        Filter by source
        <select
          className={styles.stageSelect}
          value={sourceFilter}
          onChange={e => setSourceFilter(e.target.value as CandidateSource | 'all')}
        >
          <option value="all">All sources</option>
          {SOURCES.map(s => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
        </select>
      </label>
      {loading && <div>Loading…</div>}
      {!loading && !candidates.length && <div>No applicants yet.</div>}
      {!loading && !!candidates.length && !shown.length && sourceFilter !== 'all' && (
        <div>No applicants from {SOURCE_LABEL[sourceFilter]}.</div>
      )}
      {shown.map(c => (
        <CandidateCard key={c.id} candidate={c} pipelineStages={pipelineStages} onSelectCandidate={onSelectCandidate} />
      ))}
    </div>
  );
}

export function CandidateCard({ candidate, pipelineStages, onSelectCandidate }: {
  candidate: Candidate; pipelineStages: string[]; onSelectCandidate: (id: string) => void;
}) {
  const [scores, setScores] = useState<Record<string, number>>({ ...(candidate.suggested_scores ?? {}), ...candidate.scores });
  const [resumeError, setResumeError] = useState<string | null>(null);
  const isStub = candidate.enrichment_status === 'stub';
  // hired_at wins if a legacy row has both — the mutations clear the opposing column.
  const decision = candidate.hired_at ? 'shortlisted' : candidate.rejected_at ? 'rejected' : null;

  /** hiring-resumes is a private bucket, so the file needs a signed URL before
   *  it can be shown, and that round trip is what made this button feel dead.
   *  Two separate causes, both now handled:
   *
   *  1. Opening the tab *after* the await left it to the popup blocker, and
   *     window.open's return value was ignored, so a blocked tab meant nothing
   *     on screen. The tab is opened during the click instead.
   *  2. Pointing that tab at the signed URL let the browser decide what to do
   *     with the response; Firefox saved it and left the tab blank. It now gets
   *     a blob: URL of the file itself (see getResumeObjectUrl). */
  async function viewResume() {
    if (!candidate.resume_url) return;
    setResumeError(null);

    const tab = window.open('', '_blank');
    if (!tab) {
      setResumeError('Your browser blocked the resume tab — allow pop-ups for this site and try again.');
      return;
    }
    // Opened without 'noopener' because that makes window.open return null and
    // there'd be no handle to navigate; severing the link here instead.
    tab.opener = null;

    try {
      tab.location.href = await getResumeObjectUrl(candidate.resume_url);
    } catch (e: unknown) {
      // The real reason, not a generic retry: "Object not found" (the file was
      // purged) and an auth failure need different responses from the operator.
      tab.close();
      setResumeError(`Could not open resume: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div className={styles.candidateCard}>
      <div>
        <strong>{candidate.full_name}</strong>
        {isStub && <span className={styles.stubBadge}>Stub — no resume yet</span>}
        {decision === 'shortlisted' && <span className={styles.decisionShortlisted}>Shortlisted</span>}
        {/* Legacy rows rejected before rejection_stage existed carry null —
            those all came from this board, so they read as resume screen. */}
        {decision === 'rejected' && (
          <span className={styles.decisionRejected}>
            {candidate.rejection_stage === 'interview' ? 'Rejected — interview' : 'Rejected — resume screen'}
          </span>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--color-ink-subtle)' }}>
        {candidate.email ?? candidate.indeed_relay_email ?? '—'} · {candidate.phone ?? '—'}
      </div>
      {isStub && candidate.indeed_dashboard_url && (
        <a href={candidate.indeed_dashboard_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>
          View on Indeed →
        </a>
      )}
      {!isStub && candidate.resume_url && (
        <div>
          <button onClick={viewResume} style={{ fontSize: 12 }}>View resume</button>
          {resumeError && <span style={{ fontSize: 11, color: 'var(--color-error)', marginLeft: 8 }}>{resumeError}</span>}
        </div>
      )}
      {!isStub && (
        <>
          <select
            className={styles.stageSelect}
            value={candidate.stage_index}
            onChange={e => void updateCandidateStage(candidate.id, Number(e.target.value))}
          >
            {pipelineStages.map((s, i) => <option key={i} value={i}>{s}</option>)}
          </select>
          {candidate.suggested_scores && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--color-ink-subtle)' }}>Claude's suggested scores (edit as needed):</div>
              {Object.entries(candidate.suggested_scores).map(([dim, val]) => (
                <div key={dim} className={styles.scoreRow}>
                  <span>{dim}</span>
                  <input
                    type="number" min={1} max={5} style={{ width: 40 }}
                    value={scores[dim] ?? val}
                    onChange={e => setScores(prev => ({ ...prev, [dim]: Number(e.target.value) }))}
                  />
                </div>
              ))}
              <button onClick={() => void recordCandidateScore(candidate.id, scores)}>Save scores</button>
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <button onClick={() => void hireCandidate(candidate.id)}>Shortlist</button>
            <button onClick={() => void rejectCandidate(candidate.id, 'resume_screening')} style={{ marginLeft: 8 }}>Reject</button>
            {/* The Interviews board lists shortlisted candidates only — jumping
                there before a shortlist decision would land on a board this
                candidate isn't on. */}
            <button
              onClick={() => onSelectCandidate(candidate.id)}
              disabled={decision !== 'shortlisted'}
              title={decision === 'shortlisted' ? undefined : 'Shortlist this candidate to schedule interviews'}
              style={{ marginLeft: 8 }}
            >
              Interviews →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
