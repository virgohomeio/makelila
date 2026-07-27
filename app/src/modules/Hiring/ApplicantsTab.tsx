import { useState } from 'react';
import styles from './Hiring.module.css';
import { ResumeUploadPanel } from './ResumeUploadPanel';
import {
  useCandidates, updateCandidateStage, recordCandidateScore, rejectCandidate, hireCandidate,
  getResumeSignedUrl, type Candidate, type CandidateSource,
} from '../../lib/hiring';

export function ApplicantsTab({ postingId, pipelineStages }: { postingId: string; pipelineStages: string[] }) {
  const { candidates, loading } = useCandidates(postingId);
  const [uploadSource, setUploadSource] = useState<CandidateSource>('indeed');

  return (
    <div>
      <select
        className={styles.stageSelect}
        value={uploadSource}
        onChange={e => setUploadSource(e.target.value as CandidateSource)}
        style={{ marginBottom: 8 }}
      >
        <option value="indeed">Indeed</option>
        <option value="linkedin">LinkedIn</option>
        <option value="referral">Referral</option>
        <option value="other">Other</option>
      </select>
      <ResumeUploadPanel postingId={postingId} source={uploadSource} onUploaded={() => {}} />
      <h3 style={{ marginTop: 20 }}>Applicants</h3>
      {loading && <div>Loading…</div>}
      {!loading && !candidates.length && <div>No applicants yet.</div>}
      {candidates.map(c => (
        <CandidateCard key={c.id} candidate={c} pipelineStages={pipelineStages} />
      ))}
    </div>
  );
}

function CandidateCard({ candidate, pipelineStages }: { candidate: Candidate; pipelineStages: string[] }) {
  const [scores, setScores] = useState<Record<string, number>>(candidate.scores);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const isStub = candidate.enrichment_status === 'stub';

  async function viewResume() {
    if (!candidate.resume_url) return;
    setResumeError(null);
    try {
      const signedUrl = await getResumeSignedUrl(candidate.resume_url);
      window.open(signedUrl, '_blank', 'noopener,noreferrer');
    } catch {
      setResumeError('Could not open resume — try again.');
    }
  }

  return (
    <div className={styles.candidateCard}>
      <div>
        <strong>{candidate.full_name}</strong>
        {isStub && <span className={styles.stubBadge}>Stub — no resume yet</span>}
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
            <button onClick={() => void hireCandidate(candidate.id)}>Hire</button>
            <button onClick={() => void rejectCandidate(candidate.id)} style={{ marginLeft: 8 }}>Reject</button>
          </div>
        </>
      )}
    </div>
  );
}
