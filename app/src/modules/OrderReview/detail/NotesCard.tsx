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

  // Reset draft if selected order changes or external update comes in
  useEffect(() => {
    setDraft(order.notes);
    setStatus('idle');
  }, [order.id, order.notes]);

  const handleBlur = async () => {
    if (draft === order.notes) return;
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
          onChange={e => setDraft(e.target.value)}
          onBlur={handleBlur}
          placeholder="Internal notes (visible to the whole team; saves when you click out)"
        />
        <div className={styles.notesStatus}>
          {status === 'saving' && 'Saving…'}
          {status === 'saved'  && 'Saved ✓'}
          {status === 'error'  && 'Save failed — try again'}
        </div>
      </div>
    </div>
  );
}
