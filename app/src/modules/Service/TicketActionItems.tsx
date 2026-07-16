import { useState } from 'react';
import {
  useTicketActionItems, addTicketActionItem, setTicketActionItemDone, deleteTicketActionItem,
  type TicketActionItem,
} from '../../lib/service';
import styles from './Service.module.css';

type Props = { ticketId: string };

// A running, checkable to-do list per ticket — mirrors TicketNotes (internal,
// realtime, timestamped) but each item can be checked off when complete.
export function TicketActionItems({ ticketId }: Props) {
  const { items, loading } = useTicketActionItems(ticketId);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    const body = draft.trim();
    if (!body) return;
    setBusy(true); setError(null);
    try {
      await addTicketActionItem(ticketId, body);
      setDraft('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const openCount = items.filter(i => !i.done).length;

  return (
    <div>
      <div className={styles.noteComposer}>
        <input
          className={styles.input}
          placeholder="Add an action item…"
          value={draft}
          disabled={busy}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }}
        />
        <div className={styles.actionsRow}>
          <button
            className={styles.btnPrimary}
            disabled={busy || !draft.trim()}
            onClick={() => void add()}
          >{busy ? 'Adding…' : 'Add action item'}</button>
        </div>
      </div>

      {error && <div className={styles.noteError}>{error}</div>}

      {loading ? (
        <div className={styles.loading}>Loading action items…</div>
      ) : items.length === 0 ? (
        <div className={styles.noteEmpty}>No action items yet.</div>
      ) : (
        <>
          <div className={styles.noteMeta} style={{ marginBottom: 6 }}>
            {openCount} open · {items.length - openCount} done
          </div>
          <div className={styles.noteList}>
            {items.map(it => <ActionItemRow key={it.id} item={it} />)}
          </div>
        </>
      )}
    </div>
  );
}

function ActionItemRow({ item }: { item: TicketActionItem }) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true); setError(null);
    try {
      await setTicketActionItemDone(item.id, !item.done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true); setError(null);
    try {
      await deleteTicketActionItem(item.id);
      // Row disappears via the realtime DELETE event.
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  return (
    <div className={styles.noteItem}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <input
          type="checkbox"
          checked={item.done}
          disabled={busy}
          onChange={() => void toggle()}
          title={item.done ? 'Mark as not done' : 'Mark as done'}
          style={{ marginTop: 3, cursor: busy ? 'wait' : 'pointer', flex: '0 0 auto' }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className={styles.noteBody}
            style={item.done ? { textDecoration: 'line-through', color: '#a0aec0' } : undefined}
          >{item.body}</div>
          <div className={styles.noteMeta}>
            <span className={styles.noteAuthor}>{item.author_email ? item.author_email.split('@')[0] : 'unknown'}</span>
            <span className={styles.noteTime}>
              Created {new Date(item.created_at).toLocaleString()}
              {item.done && item.done_at && (
                <> · ✓ done {new Date(item.done_at).toLocaleString()}{item.done_by ? ` by ${item.done_by.split('@')[0]}` : ''}</>
              )}
            </span>
            {!confirmDelete && (
              <button
                className={styles.noteDeleteBtn}
                title="Delete action item"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >🗑</button>
            )}
          </div>
          {confirmDelete && (
            <div className={styles.noteConfirm}>
              <span>Delete this action item?</span>
              <button className={styles.btnDanger} disabled={busy} onClick={() => void remove()}>
                {busy ? 'Deleting…' : 'Delete'}
              </button>
              <button className={styles.btnSecondary} disabled={busy} onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </div>
          )}
          {error && <div className={styles.noteError}>{error}</div>}
        </div>
      </div>
    </div>
  );
}
