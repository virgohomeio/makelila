import { useState } from 'react';
import styles from './Hiring.module.css';
import { PostingsTab } from './PostingsTab';
import { ApplicantsTab } from './ApplicantsTab';
import { InterviewsTab } from './InterviewsTab';

type View = 'postings' | 'applicants' | 'interviews';

export default function Hiring() {
  const [view, setView] = useState<View>('postings');
  const [expandCandidateId, setExpandCandidateId] = useState<string | undefined>(undefined);

  return (
    <div className={styles.hiring}>
      <div className={styles.tabBar}>
        <button onClick={() => setView('postings')} className={view === 'postings' ? styles.activeTab : ''}>Postings</button>
        <button onClick={() => setView('applicants')} className={view === 'applicants' ? styles.activeTab : ''}>Applicants</button>
        <button onClick={() => setView('interviews')} className={view === 'interviews' ? styles.activeTab : ''}>Interviews</button>
      </div>

      {view === 'postings' && (
        <PostingsTab onSelectPosting={() => setView('applicants')} />
      )}
      {view === 'applicants' && (
        <ApplicantsTab
          onSelectCandidate={id => { setExpandCandidateId(id); setView('interviews'); }}
        />
      )}
      {view === 'interviews' && (
        <InterviewsTab initialExpandedCandidateId={expandCandidateId} />
      )}
    </div>
  );
}
