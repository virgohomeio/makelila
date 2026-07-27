import { useState } from 'react';
import styles from './Hiring.module.css';
import { useInterviews, createInterview, recordInterviewDecision, getCurrentUserId, type Interview, type InterviewDecision } from '../../lib/hiring';

const DECISION_LABEL: Record<InterviewDecision, string> = {
  advance: 'Advance', reject: 'Reject', hold: 'Hold', no_show: 'No-show',
};

export function InterviewsTab({ candidateId, candidateName }: { candidateId: string; candidateName: string }) {
  const { interviews: fetchedInterviews, loading } = useInterviews(candidateId);
  const [roundLabel, setRoundLabel] = useState('');
  const [calendlyUrl, setCalendlyUrl] = useState('');
  const [creating, setCreating] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);

  // useInterviews (lib/hiring.ts) fetches once and has no realtime
  // subscription (unlike useJobPostings/useCandidates) — track interviews
  // created/decided by this component locally and merge them into the
  // fetched list on render, so book()/DecisionForm reflect their own writes
  // immediately instead of requiring a remount to see them. Resets whenever
  // candidateId changes (React's "adjusting state when a prop changes"
  // pattern rather than an effect — https://react.dev/learn/you-might-not-need-an-effect).
  const [trackedCandidateId, setTrackedCandidateId] = useState(candidateId);
  const [createdInterviews, setCreatedInterviews] = useState<Interview[]>([]);
  const [decisionOverrides, setDecisionOverrides] = useState<Record<string, { decision: InterviewDecision; decision_notes: string }>>({});
  if (candidateId !== trackedCandidateId) {
    setTrackedCandidateId(candidateId);
    setCreatedInterviews([]);
    setDecisionOverrides({});
  }

  const interviews = [...fetchedInterviews, ...createdInterviews].map(iv =>
    decisionOverrides[iv.id] ? { ...iv, ...decisionOverrides[iv.id] } : iv
  );

  async function book() {
    if (!roundLabel.trim()) return;
    setCreating(true);
    setBookError(null);
    try {
      // interviewerId defaults to the current session user — the booking
      // operator is the interviewer unless reassigned later via the DB directly.
      // Goes through lib/hiring's getCurrentUserId() rather than importing
      // supabase directly (components never call supabase directly — AGENTS.md).
      const userId = await getCurrentUserId();
      if (!userId) {
        setBookError('Could not identify current user — please refresh and try again.');
        return;
      }
      const created = await createInterview({ candidateId, roundLabel, interviewerId: userId, calendlyUrl: calendlyUrl || undefined });
      setCreatedInterviews(prev => [...prev, created]);
      setRoundLabel(''); setCalendlyUrl('');
    } catch (e: unknown) {
      setBookError(e instanceof Error ? e.message : 'Book interview failed');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <h4>Interviews — {candidateName}</h4>
      {loading && <div>Loading…</div>}
      {interviews.map(iv => (
        <div key={iv.id} className={styles.candidateCard}>
          <strong>{iv.round_label}</strong>
          {iv.calendly_event_uri && (
            <a href={iv.calendly_event_uri} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 8, fontSize: 12 }}>
              Calendly link →
            </a>
          )}
          <div style={{ marginTop: 6 }}>
            {iv.decision ? (
              <span>Decision: <strong>{DECISION_LABEL[iv.decision]}</strong> — {iv.decision_notes}</span>
            ) : (
              <DecisionForm
                interviewId={iv.id}
                onDecided={(decision, notes) => {
                  setDecisionOverrides(prev => ({ ...prev, [iv.id]: { decision, decision_notes: notes } }));
                }}
              />
            )}
          </div>
        </div>
      ))}
      <div style={{ marginTop: 16 }}>
        <input placeholder="Round label (e.g. Technical screen)" value={roundLabel} onChange={e => setRoundLabel(e.target.value)} />
        <input placeholder="Calendly event URL (optional)" value={calendlyUrl} onChange={e => setCalendlyUrl(e.target.value)} style={{ marginLeft: 8 }} />
        <button onClick={book} disabled={creating} style={{ marginLeft: 8 }}>Book interview</button>
        {bookError && <div className={styles.formError}>{bookError}</div>}
      </div>
    </div>
  );
}

function DecisionForm({ interviewId, onDecided }: { interviewId: string; onDecided: (decision: InterviewDecision, notes: string) => void }) {
  const [decision, setDecision] = useState<InterviewDecision>('advance');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function submit() {
    setSaving(true);
    setSubmitError(null);
    try {
      await recordInterviewDecision(interviewId, decision, notes);
      onDecided(decision, notes);
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : 'Submit decision failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <select value={decision} onChange={e => setDecision(e.target.value as InterviewDecision)}>
        {Object.entries(DECISION_LABEL).map(([val, label]) => <option key={val} value={val}>{label}</option>)}
      </select>
      <input placeholder="Notes" value={notes} onChange={e => setNotes(e.target.value)} style={{ marginLeft: 8 }} />
      <button onClick={submit} disabled={saving} style={{ marginLeft: 8 }}>Submit decision</button>
      {submitError && <div className={styles.formError}>{submitError}</div>}
    </div>
  );
}
