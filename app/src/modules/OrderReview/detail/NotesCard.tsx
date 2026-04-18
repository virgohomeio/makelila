import { useEffect, useState } from 'react';
import type { Order } from '../../../lib/orders';
import { updateNotes } from '../../../lib/orders';
import styles from '../OrderReview.module.css';

export function NotesCard({
  order,
  saveNotes = updateNotes,
}: {
  order: Order;
  saveNotes?: (id: string, notes: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(order.notes);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    setDraft(order.notes);
    setStatus('idle');
  }, [order.id, order.notes]);

  const dirty = draft !== order.notes;

  const handleSave = async () => {
    if (!dirty) return;
    setStatus('saving');
    try {
      await saveNotes(order.id, draft);
      setStatus('saved');
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
          onChange={e => { setDraft(e.target.value); if (status === 'saved') setStatus('idle'); }}
          placeholder="Internal notes (visible to the whole team)"
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
          <button
            onClick={handleSave}
            disabled={!dirty || status === 'saving'}
            className={styles.notesSaveBtn}
          >
            {status === 'saving' ? 'Saving…' : 'Save notes'}
          </button>
          <div className={styles.notesStatus}>
            {status === 'saved' && 'Saved ✓'}
            {status === 'error' && 'Save failed — try again'}
          </div>
        </div>
      </div>
    </div>
  );
}
