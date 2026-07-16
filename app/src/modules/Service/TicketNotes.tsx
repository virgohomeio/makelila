import { useState } from 'react';
import { useTicketNotes, addTicketNote, updateTicketNote, deleteTicketNote, type TicketNote } from '../../lib/service';
import styles from './Service.module.css';

type Props = { ticketId: string };

export function TicketNotes({ ticketId }: Props) {
  const { notes, loading } = useTicketNotes(ticketId);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    const body = draft.trim();
    if (!body) return;
    setBusy(true); setError(null);
    try {
      await addTicketNote(ticketId, body);
      setDraft('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className={styles.noteComposer}>
        <textarea
          className={styles.textarea}
          placeholder="Add a note… (ops only)"
          value={draft}
          disabled={busy}
          onChange={e => setDraft(e.target.value)}
        />
        <div className={styles.actionsRow}>
          <button
            className={styles.btnPrimary}
            disabled={busy || !draft.trim()}
            onClick={() => void add()}
          >{busy ? 'Adding…' : 'Add note'}</button>
        </div>
      </div>

      {error && <div className={styles.noteError}>{error}</div>}

      {loading ? (
        <div className={styles.loading}>Loading notes…</div>
      ) : notes.length === 0 ? (
        <div className={styles.noteEmpty}>No notes yet.</div>
      ) : (
        <div className={styles.noteList}>
          {[...notes].reverse().map(n => (
            <NoteItem key={n.id} note={n} />
          ))}
        </div>
      )}
    </div>
  );
}

function NoteItem({ note }: { note: TicketNote }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const edited = new Date(note.updated_at).getTime() - new Date(note.created_at).getTime() > 1000;

  async function save() {
    const body = draft.trim();
    if (!body || body === note.body) { setEditing(false); return; }
    setBusy(true); setError(null);
    try {
      await updateTicketNote(note.id, body);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function remove() {
    // Optimistic: hide the note immediately instead of waiting on the DB
    // round-trip + realtime DELETE echo. Restore it if the delete fails.
    setHidden(true); setError(null);
    deleteTicketNote(note.id).catch((e: Error) => {
      setHidden(false); setConfirmDelete(false); setError(e.message);
    });
  }

  if (hidden) return null;

  return (
    <div className={styles.noteItem}>
      <div className={styles.noteMeta}>
        <span className={styles.noteAuthor}>{note.author_email ? note.author_email.split('@')[0] : 'unknown'}</span>
        <span className={styles.noteTime}>
          {new Date(note.created_at).toLocaleString()}
          {edited && <span className={styles.noteEdited}> · edited {new Date(note.updated_at).toLocaleString()}</span>}
        </span>
        {!editing && !confirmDelete && (
          <>
            <button
              className={styles.noteEditBtn}
              title="Edit note"
              onClick={() => { setDraft(note.body); setEditing(true); }}
            >✎</button>
            <button
              className={styles.noteDeleteBtn}
              title="Delete note"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >🗑</button>
          </>
        )}
      </div>

      {confirmDelete && (
        <>
          <div className={styles.noteConfirm}>
            <span>Delete this note?</span>
            <button className={styles.btnDanger} onClick={remove}>Delete</button>
            <button className={styles.btnSecondary} onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
          {error && <div className={styles.noteError}>{error}</div>}
        </>
      )}
      {editing ? (
        <div>
          <textarea
            className={styles.textarea}
            value={draft}
            autoFocus
            disabled={busy}
            onChange={e => setDraft(e.target.value)}
          />
          <div className={styles.actionsRow}>
            <button className={styles.btnPrimary} disabled={busy} onClick={() => void save()}>Save</button>
            <button
              className={styles.btnSecondary}
              disabled={busy}
              onClick={() => { setDraft(note.body); setEditing(false); }}
            >Cancel</button>
          </div>
          {error && <div className={styles.noteError}>{error}</div>}
        </div>
      ) : (
        <div className={styles.noteBody}>{note.body}</div>
      )}
    </div>
  );
}
