import { useState } from 'react';
import type { Order } from '../../../lib/orders';
import { addOrderNote, useOrderNotes } from '../../../lib/orders';
import { useAuth } from '../../../lib/auth';
import styles from '../OrderReview.module.css';

export function NotesCard({
  order,
  save = addOrderNote,
}: {
  order: Order;
  save?: (orderId: string, authorName: string, body: string) => Promise<void>;
}) {
  const { profile, user } = useAuth();
  const { notes, loading } = useOrderNotes(order.id);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');

  const authorName = profile?.display_name ?? user?.email ?? 'Unknown';
  const canSubmit = draft.trim().length > 0 && status !== 'saving';

  const handleAdd = async () => {
    if (!canSubmit) return;
    setStatus('saving');
    try {
      await save(order.id, authorName, draft.trim());
      setDraft('');
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>Review Notes</div>
      <div className={styles.cardBody}>
        <textarea
          className={styles.notesArea}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="Add a review note (visible to the whole team)"
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
          <button
            onClick={handleAdd}
            disabled={!canSubmit}
            className={styles.notesSaveBtn}
          >
            {status === 'saving' ? 'Saving…' : 'Add note'}
          </button>
          <div className={styles.notesStatus}>
            {status === 'error' && 'Save failed — try again'}
          </div>
        </div>

        <div className={styles.notesLog}>
          {loading && notes.length === 0 ? (
            <div className={styles.notesLogEmpty}>Loading notes…</div>
          ) : notes.length === 0 ? (
            <div className={styles.notesLogEmpty}>No notes yet.</div>
          ) : (
            notes.map(n => (
              <div key={n.id} className={styles.notesLogEntry}>
                <div className={styles.notesLogMeta}>
                  <strong>{n.author_name}</strong>
                  <span className={styles.notesLogTs}>
                    {new Date(n.created_at).toLocaleString()}
                  </span>
                </div>
                <div className={styles.notesLogBody}>{n.body}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
