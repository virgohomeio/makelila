import { useState } from 'react';
import styles from './Hiring.module.css';
import { PostingsTab } from './PostingsTab';
import { ApplicantsTab } from './ApplicantsTab';
import { InterviewsTab } from './InterviewsTab';
import { useJobPostings, useCandidates } from '../../lib/hiring';

type View = 'postings' | 'applicants' | 'interviews';

export default function Hiring() {
  const [view, setView] = useState<View>('postings');
  const [selectedPostingId, setSelectedPostingId] = useState<string | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const { postings } = useJobPostings();
  const { candidates } = useCandidates(selectedPostingId);

  const selectedPosting = postings.find(p => p.id === selectedPostingId);
  const selectedCandidate = candidates.find(c => c.id === selectedCandidateId);

  return (
    <div className={styles.hiring}>
      <div className={styles.tabBar}>
        <button onClick={() => setView('postings')} className={view === 'postings' ? styles.activeTab : ''}>Postings</button>
        <button onClick={() => setView('applicants')} disabled={!selectedPostingId} className={view === 'applicants' ? styles.activeTab : ''}>Applicants</button>
        <button onClick={() => setView('interviews')} disabled={!selectedCandidateId} className={view === 'interviews' ? styles.activeTab : ''}>Interviews</button>
      </div>

      {view === 'postings' && (
        <PostingsTab onSelectPosting={id => { setSelectedPostingId(id); setView('applicants'); }} />
      )}
      {view === 'applicants' && selectedPosting && (
        <ApplicantsTab
          postingId={selectedPosting.id}
          pipelineStages={selectedPosting.pipeline_stages}
          onSelectCandidate={id => { setSelectedCandidateId(id); setView('interviews'); }}
        />
      )}
      {view === 'interviews' && selectedCandidate && (
        // useInterviews (lib/hiring.ts) doesn't reset its loading/interviews
        // state when candidateId changes post-mount (its effect re-fetches
        // but never resets `loading` to true or clears stale rows first) —
        // remount on candidate change via key so switching candidates always
        // starts from a clean loading state instead of briefly showing the
        // previous candidate's interviews.
        <InterviewsTab key={selectedCandidate.id} candidateId={selectedCandidate.id} candidateName={selectedCandidate.full_name} />
      )}
    </div>
  );
}
