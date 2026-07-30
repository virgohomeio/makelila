import { useState } from 'react';
import styles from './Hiring.module.css';
import { ResumeUploadPanel } from './ResumeUploadPanel';
import {
  useJobPostings, useCandidates, updateCandidateStage, recordCandidateScore, rejectCandidate, hireCandidate,
  getResumeSignedUrl, computeOverallScore, type Candidate, type CandidateSource, type RubricDimension,
} from '../../lib/hiring';

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
          rubric={p.screening_rubric}
          onSelectCandidate={onSelectCandidate}
        />
      ))}
    </div>
  );
}

function PostingColumn({ postingId, title, pipelineStages, rubric, onSelectCandidate }: {
  postingId: string; title: string; pipelineStages: string[]; rubric: RubricDimension[]; onSelectCandidate: (id: string) => void;
}) {
  const { candidates, loading } = useCandidates(postingId);
  const [uploadSource, setUploadSource] = useState<CandidateSource>('indeed');

  // Rank scored candidates by descending composite score; stub candidates
  // (no scores recorded yet) have nothing meaningful to rank by, so they're
  // kept out of the sort and rendered after, in their existing order.
  const scored = candidates
    .filter(c => c.enrichment_status !== 'stub')
    .map(c => ({ candidate: c, overallScore: computeOverallScore(c.scores && Object.keys(c.scores).length ? c.scores : (c.suggested_scores ?? {}), rubric) }))
    .sort((a, b) => b.overallScore - a.overallScore);
  const stubs = candidates.filter(c => c.enrichment_status === 'stub');

  return (
    <div className={styles.column}>
      <div className={styles.columnHeader}>
        {title} <span className={styles.columnCount}>· {candidates.length}</span>
      </div>
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
        <option value="university_of_waterloo">University of Waterloo</option>
        <option value="university_of_toronto">University of Toronto</option>
        <option value="york_university">York University</option>
      </select>
      <ResumeUploadPanel postingId={postingId} source={uploadSource} onUploaded={() => {}} />
      <h3 style={{ marginTop: 20 }}>Applicants</h3>
      {loading && <div>Loading…</div>}
      {!loading && !candidates.length && <div>No applicants yet.</div>}
      {scored.map(({ candidate: c, overallScore }, i) => (
        <CandidateCard
          key={c.id} candidate={c} pipelineStages={pipelineStages} onSelectCandidate={onSelectCandidate}
          overallScore={overallScore} rank={i + 1}
        />
      ))}
      {stubs.map(c => (
        <CandidateCard key={c.id} candidate={c} pipelineStages={pipelineStages} onSelectCandidate={onSelectCandidate} />
      ))}
    </div>
  );
}

function scoreTier(overallScore: number): { key: 'strong' | 'consider' | 'weak'; label: string } {
  if (overallScore >= 4.0) return { key: 'strong', label: 'Strong fit' };
  if (overallScore >= 3.0) return { key: 'consider', label: 'Consider' };
  return { key: 'weak', label: 'Lower fit' };
}

/** First letter of the first token + first letter of the last token of
 *  full_name. Single-word names just use that one letter. */
function initialsOf(fullName: string): string {
  const tokens = fullName.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return '?';
  if (tokens.length === 1) return tokens[0][0].toUpperCase();
  return (tokens[0][0] + tokens[tokens.length - 1][0]).toUpperCase();
}

function CandidateCard({ candidate, pipelineStages, onSelectCandidate, overallScore, rank }: {
  candidate: Candidate; pipelineStages: string[]; onSelectCandidate: (id: string) => void;
  overallScore?: number; rank?: number;
}) {
  const [scores, setScores] = useState<Record<string, number>>({ ...(candidate.suggested_scores ?? {}), ...candidate.scores });
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

  const tier = overallScore !== undefined ? scoreTier(overallScore) : null;
  const tierClass = tier && { strong: styles.tierStrong, consider: styles.tierConsider, weak: styles.tierWeak }[tier.key];
  const avatarClass = tier && { strong: styles.avatarStrong, consider: styles.avatarConsider, weak: styles.avatarWeak }[tier.key];

  return (
    <div className={styles.candidateCard}>
      {!isStub && tier && overallScore !== undefined && (
        <div className={styles.scorecardHeader}>
          <span className={`${styles.avatar} ${avatarClass}`}>{initialsOf(candidate.full_name)}</span>
          <div className={styles.scorecardMeta}>
            <div>
              {rank !== undefined && <span className={styles.rankBadge}>#{rank}</span>}
              <span className={`${styles.tierLabel} ${tierClass}`}>{tier.label}</span>
              <span className={styles.overallScoreText}> · {overallScore.toFixed(1)} / 5</span>
            </div>
            <div className={styles.overallScoreBar}>
              <div className={styles.overallScoreFill} style={{ width: `${Math.min(100, (overallScore / 5) * 100)}%` }} />
            </div>
          </div>
        </div>
      )}
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
            <button onClick={() => onSelectCandidate(candidate.id)} style={{ marginLeft: 8 }}>Interviews →</button>
          </div>
        </>
      )}
    </div>
  );
}
