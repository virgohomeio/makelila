import { useState } from 'react';
import { promoteToTicket, type TicketCategory } from '../../lib/service';
import { useAuth } from '../../lib/auth';
import styles from './Service.module.css';

type Props = { conversationId: string; onClose: () => void };

export function PromoteToTicketModal({ conversationId, onClose }: Props) {
  const { user } = useAuth();
  const [category, setCategory] = useState<TicketCategory>('support');
  const [owner, setOwner] = useState(user?.email ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      await promoteToTicket(conversationId, { category, owner_email: owner });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to promote conversation');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <span>Promote to ticket</span>
          <button className={styles.modalClose} onClick={onClose}>×</button>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.modalRow}>
            <label htmlFor="promote-category">Category</label>
            <select
              id="promote-category"
              className={styles.modalSelect}
              value={category}
              onChange={e => setCategory(e.target.value as TicketCategory)}
              autoFocus
            >
              <option value="support">Support</option>
              <option value="onboarding">Onboarding</option>
              <option value="repair">Repair</option>
            </select>
          </div>
          <div className={styles.modalRow}>
            <label htmlFor="promote-owner">Owner</label>
            <input
              id="promote-owner"
              type="email"
              className={styles.modalInput}
              value={owner}
              onChange={e => setOwner(e.target.value)}
            />
          </div>
          {error && <div className={styles.modalError}>{error}</div>}
        </div>
        <div className={styles.modalFoot}>
          <button className={styles.modalSecondary} onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button className={styles.modalPrimary} onClick={handleSubmit} disabled={submitting || !owner}>
            {submitting ? 'Promoting…' : 'Promote'}
          </button>
        </div>
      </div>
    </div>
  );
}
