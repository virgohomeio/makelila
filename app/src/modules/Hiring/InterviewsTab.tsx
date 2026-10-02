import { useEffect, useRef, useState } from 'react';
import styles from './Hiring.module.css';
import {
  useJobPostings, useCandidates, useInterviews, createInterview, recordInterviewDecision,
  getCurrentUserId, markScreeningInviteSent, rejectCandidate, recordProjectScores, PROJECT_QUESTIONS,
  type Candidate, type Interview, type InterviewDecision,
} from '../../lib/hiring';
import { useEmailTemplate, useSchedulingUrl } from '../../lib/templates';
import { OutreachPanel } from './OutreachPanel';
import { SCREENING_TEMPLATE_KEY, candidateEmail, renderScreeningInvite } from './screeningInvite';

const DECISION_LABEL: Record<InterviewDecision, string> = {
  advance: 'Advance', reject: 'Reject', hold: 'Hold', no_show: 'No-show',
};

/** Screening scores as one inline string, e.g. "Communication 4 · Reliability 5".
 *  Saved operator scores win over Claude's suggestions — the same merge the
 *  Applicants board uses to seed its editable score inputs. */
function scoreSummary(candidate: Candidate): string {
  const entries = Object.entries({ ...(candidate.suggested_scores ?? {}), ...candidate.scores });
  if (!entries.length) return 'No scores yet';
  return entries.map(([dimension, value]) => `${dimension} ${value}`).join(' · ');
}

export function InterviewsTab({ initialExpandedCandidateId }: { initialExpandedCandidateId?: string }) {
  const { postings, loading } = useJobPostings();

  if (loading) return <div>Loading postings…</div>;
  if (!postings.length) return <div className={styles.empty}>No job postings yet.</div>;

  return (
    <>
      <OutreachPanel />
      <div className={styles.board}>
        {postings.map(p => (
          <InterviewColumn
            key={p.id}
            postingId={p.id}
            title={p.title}
            initialExpandedCandidateId={initialExpandedCandidateId}
          />
        ))}
      </div>
    </>
  );
}

function InterviewColumn({ postingId, title, initialExpandedCandidateId }: {
  postingId: string; title: string; initialExpandedCandidateId?: string;
}) {
  const { candidates, loading } = useCandidates(postingId);
  // Interviews only make sense for a real, resume-attached candidate the team
  // has shortlisted. `hired_at` is the shortlist marker (see the decision-tags
  // design doc) and wins over `rejected_at` on a legacy row carrying both —
  // same derivation as CandidateCard on the Applicants board.
  const interviewable = candidates.filter(c => c.enrichment_status !== 'stub' && c.hired_at);
  const [expandedCandidateId, setExpandedCandidateId] = useState<string | undefined>(undefined);
  const rowRef = useRef<HTMLDivElement>(null);
  const autoExpandedRef = useRef(false);
  const hasInitialCandidate = interviewable.some(c => c.id === initialExpandedCandidateId);

  useEffect(() => {
    if (autoExpandedRef.current || !initialExpandedCandidateId || !hasInitialCandidate) return;
    autoExpandedRef.current = true;
    setExpandedCandidateId(initialExpandedCandidateId);
    rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [initialExpandedCandidateId, hasInitialCandidate]);

  return (
    <div className={styles.column}>
      <div className={styles.columnHeader}>
        {title} <span className={styles.columnCount}>· {interviewable.length}</span>
      </div>
      {loading && <div>Loading…</div>}
      {!loading && !interviewable.length && <div>No shortlisted candidates yet.</div>}
      {interviewable.map(c => (
        <div key={c.id} ref={c.id === initialExpandedCandidateId ? rowRef : undefined}>
          <div
            className={styles.candidateCard}
            style={{ cursor: 'pointer' }}
            onClick={() => setExpandedCandidateId(expandedCandidateId === c.id ? undefined : c.id)}
          >
            <strong>{c.full_name}</strong>
            <span className={styles.candidateEmail}>{candidateEmail(c) ?? 'No email on file'}</span>
            {c.screening_invite_sent_at
              ? <span className={styles.sentChip}>Emailed</span>
              : <span className={styles.unsentChip}>Not emailed</span>}
            <span className={styles.scoreSummary}>{scoreSummary(c)}</span>
          </div>
          {expandedCandidateId === c.id && (
            <CandidateInterviewPanel key={c.id} candidate={c} postingTitle={title} />
          )}
        </div>
      ))}
    </div>
  );
}

function CandidateInterviewPanel({ candidate, postingTitle }: { candidate: Candidate; postingTitle: string }) {
  const candidateId = candidate.id;
  const candidateName = candidate.full_name;
  const { interviews: fetchedInterviews, loading } = useInterviews(candidateId);
  const [roundLabel, setRoundLabel] = useState('');
  const [calendlyUrl, setCalendlyUrl] = useState('');
  const [creating, setCreating] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);

  // useInterviews (lib/hiring.ts) fetches once and has no realtime
  // subscription (unlike useJobPostings/useCandidates) — track interviews
  // created/decided by this component locally and merge them into the
  // fetched list on render, so book()/DecisionForm reflect their own writes
  // immediately instead of requiring a remount to see them.
  //
  // This panel is now mounted only while its candidate's row is expanded,
  // with `key={candidateId}` at the call site (InterviewColumn) — so a
  // fresh component instance is created whenever the expanded candidate
  // changes, and candidateId never changes within one mounted instance's
  // lifetime. That makes the old "adjust tracked candidate id during
  // render" reset trick unnecessary: there is no stale local state to
  // clear, because this instance never renders for a second candidateId.
  // Dropped in favor of the plain `key`-driven remount.
  const [createdInterviews, setCreatedInterviews] = useState<Interview[]>([]);
  const [decisionOverrides, setDecisionOverrides] = useState<Record<string, { decision: InterviewDecision; decision_notes: string }>>({});

  // De-dup by id: if useInterviews ever gains a realtime subscription, a row
  // inserted by book() could land in fetchedInterviews while already present
  // in createdInterviews. Fetched copy wins so it stays authoritative.
  const fetchedIds = new Set(fetchedInterviews.map(iv => iv.id));
  const interviews = [...fetchedInterviews, ...createdInterviews.filter(iv => !fetchedIds.has(iv.id))].map(iv =>
    decisionOverrides[iv.id] ? { ...iv, ...decisionOverrides[iv.id] } : iv
  );

  // Screening invite draft — makeLILA renders the copy and hands it over as
  // text; the operator pastes it into their own mail client and sends it.
  // Nothing here touches Resend, email_messages, or a mail client.
  const { template: screeningTemplate, loading: templateLoading } = useEmailTemplate(SCREENING_TEMPLATE_KEY);
  const { schedulingUrl } = useSchedulingUrl();
  const [copied, setCopied] = useState<'email' | 'address' | null>(null);
  const to = candidateEmail(candidate);
  // Local echo of the sent marker, same override shape as decisionOverrides
  // above: this panel's own write shows immediately, without waiting on
  // useCandidates' realtime refetch. Until it makes one, the row wins — so a
  // mark made from the outreach panel above the board reaches this view too.
  const [sentOverride, setSentOverride] = useState<string | null | undefined>(undefined);
  const sentAt = sentOverride !== undefined ? sentOverride : candidate.screening_invite_sent_at;
  const [sendError, setSendError] = useState<string | null>(null);
  const draft = screeningTemplate && renderScreeningInvite(screeningTemplate, {
    candidateName, postingTitle, schedulingUrl,
  });

  /** Copying is all makeLILA does with the invite — the operator pastes it and
   *  sends it themselves, so this deliberately leaves the sent marker alone.
   *  "Mark emailed" below records that separately, once it has actually gone.
   *
   *  Address and message copy separately because they land in different fields
   *  of a compose window — this one is the message only. */
  async function copyDraft() {
    if (!draft) return;
    await navigator.clipboard.writeText(`Subject: ${draft.subject}\n\n${draft.body}`);
    setCopied('email');
  }

  async function copyAddress() {
    if (!to) return;
    await navigator.clipboard.writeText(to);
    setCopied('address');
  }

  async function toggleSent() {
    setSendError(null);
    const next = !sentAt;
    try {
      await markScreeningInviteSent(candidateId, next);
      setSentOverride(next ? new Date().toISOString() : null);
    } catch (e: unknown) {
      setSendError(e instanceof Error ? e.message : 'Could not update the outreach status');
    }
  }

  // Candidate-level rejection at the interview gate. Clearing hired_at (inside
  // rejectCandidate) drops the candidate off this board via useCandidates'
  // realtime refetch; the Applicants board then tags them Rejected — interview,
  // apart from the resume-screen rejections.
  const [rejecting, setRejecting] = useState(false);
  const [rejectError, setRejectError] = useState<string | null>(null);

  async function reject() {
    setRejecting(true);
    setRejectError(null);
    try {
      await rejectCandidate(candidateId, 'interview');
    } catch (e: unknown) {
      setRejectError(e instanceof Error ? e.message : 'Reject failed');
    } finally {
      setRejecting(false);
    }
  }

  // Take-home project — two fixed questions, scored 1–5 like the screening
  // rubric. Seeded from the row; Saved hint clears on the next edit.
  const [projectScores, setProjectScores] = useState<Record<string, number>>({ ...candidate.project_scores });
  const [projectSaved, setProjectSaved] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);

  function setProjectScore(question: string, raw: string) {
    setProjectSaved(false);
    setProjectScores(prev => {
      if (raw === '') {
        const { [question]: _removed, ...rest } = prev;
        return rest;
      }
      return { ...prev, [question]: Number(raw) };
    });
  }

  async function saveProjectScores() {
    setProjectError(null);
    try {
      await recordProjectScores(candidateId, projectScores);
      setProjectSaved(true);
    } catch (e: unknown) {
      setProjectError(e instanceof Error ? e.message : 'Save project scores failed');
    }
  }

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
    <div style={{ marginBottom: 10 }}>
      <h4>Interviews — {candidateName}</h4>
      <div style={{ marginBottom: 10 }}>
        <button onClick={reject} disabled={rejecting}>Reject</button>
        <span className={styles.inviteHint}>
          Marks the candidate rejected after interview and removes them from this board.
        </span>
        {rejectError && <div className={styles.formError}>{rejectError}</div>}
      </div>
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
      <div className={styles.inviteBlock}>
        <div className={styles.inviteTitle}>Screening interview invite</div>
        {templateLoading && <div className={styles.inviteHint}>Loading template…</div>}
        {!templateLoading && !draft && (
          <div className={styles.inviteHint}>
            Screening interview invite template not found in the template library.
          </div>
        )}
        {draft && (
          <>
            {to && <div className={styles.inviteSubject}>To: {to}</div>}
            <div className={styles.inviteSubject}>Subject: {draft.subject}</div>
            <pre className={styles.inviteBody}>{draft.body}</pre>
            <button onClick={copyDraft}>Copy email</button>
            <button
              onClick={copyAddress}
              disabled={!to}
              title={to ? 'Copies just the address, for the To: field' : 'No email address on file for this candidate'}
              style={{ marginLeft: 8 }}
            >
              Copy address
            </button>
            <button className={styles.linkButton} onClick={toggleSent}>
              {sentAt ? 'Mark not emailed' : 'Mark emailed'}
            </button>
            {copied && (
              <span className={styles.inviteHint}>
                {copied === 'address' ? 'Address copied' : 'Email copied'}
              </span>
            )}
            <div className={styles.inviteHint} style={{ marginLeft: 0, marginTop: 6 }}>
              {sentAt
                ? `Invite marked as emailed ${new Date(sentAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}.`
                : 'Copy this, paste it into your mail client, and mark it emailed once it has gone.'}
            </div>
            {sendError && <div className={styles.formError}>{sendError}</div>}
          </>
        )}
      </div>
      <div className={styles.inviteBlock}>
        <div className={styles.inviteTitle}>Project — 2 questions</div>
        {PROJECT_QUESTIONS.map(question => (
          <div key={question} className={styles.scoreRow}>
            <span>{question}</span>
            <input
              type="number" min={1} max={5} style={{ width: 40 }}
              aria-label={question}
              value={projectScores[question] ?? ''}
              onChange={e => setProjectScore(question, e.target.value)}
            />
          </div>
        ))}
        <button onClick={() => void saveProjectScores()}>Save project scores</button>
        {projectSaved && <span className={styles.inviteHint}>Saved</span>}
        {projectError && <div className={styles.formError}>{projectError}</div>}
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
