import { useEffect, useState } from 'react';
import {
  recordFollowUp, setReviewStatus, computeFuState, FU_STATE_META, type Customer,
} from '../../lib/customers';
import { markDiagnosisFollowupDone } from '../../lib/service';
import {
  useActionItems, useCustomerNotes, addActionItem, toggleActionItem, deleteActionItem,
  addCustomerNote, setCustomerManualTags, MANUAL_TAGS,
} from '../../lib/followups';
import { STATUS_FILTERS, type FollowUpStatusKey } from '../../lib/followupStatus';
import styles from './FollowUps.module.css';

const labelOf = (k: FollowUpStatusKey) => STATUS_FILTERS.find(f => f.key === k)?.label ?? k;

export function FollowUpDetailPanel({
  customer, diagnosisTicketId, onClose, onChanged,
}: {
  customer: Customer;
  diagnosisTicketId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { items, refresh: refreshItems } = useActionItems(customer.id);
  const { notes, refresh: refreshNotes } = useCustomerNotes(customer.id);
  const [busy, setBusy] = useState(false);
  const [tags, setTags] = useState<string[]>(customer.manual_status_tags ?? []);
  const [newItem, setNewItem] = useState('');
  const [newItemDue, setNewItemDue] = useState('');
  const [newNote, setNewNote] = useState('');
  const fu = computeFuState(customer);

  useEffect(() => { setTags(customer.manual_status_tags ?? []); }, [customer.id, customer.manual_status_tags]);

  const run = async (fn: () => Promise<void>, after?: () => void) => {
    setBusy(true);
    try { await fn(); after?.(); onChanged(); } finally { setBusy(false); }
  };

  const toggleTag = (k: FollowUpStatusKey) => {
    const next = tags.includes(k) ? tags.filter(t => t !== k) : [...tags, k];
    setTags(next);
    void run(() => setCustomerManualTags(customer.id, next));
  };

  return (
    <div className={styles.selectedPanel}>
      <div className={styles.selectedHeader}>
        <strong>{customer.full_name}</strong>
        <span className={styles.selectedKind} style={{ color: FU_STATE_META[fu].color, background: FU_STATE_META[fu].bg }}>
          {FU_STATE_META[fu].label}
        </span>
        <button className={styles.closeBtn} onClick={onClose}>×</button>
      </div>

      <div className={styles.selectedMeta}>
        {customer.email && <span>{customer.email}</span>}
        {customer.phone && <span>{customer.phone}</span>}
        {customer.onboard_date && (
          <span>Onboarded {new Date(customer.onboard_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
        )}
      </div>

      {/* Manual status tags (additive to the auto-derived ones in the directory). */}
      <div className={styles.detailSection}>
        <div className={styles.detailLabel}>Tags</div>
        <div className={styles.detailTags}>
          {MANUAL_TAGS.map(k => (
            <button key={k} disabled={busy}
              className={`${styles.detailTag} ${tags.includes(k) ? styles.detailTagOn : ''}`}
              onClick={() => toggleTag(k)}>
              {labelOf(k)}
            </button>
          ))}
        </div>
      </div>

      {/* Checklist: FU1/FU2, diagnosis follow-up, manual action items. */}
      <div className={styles.detailSection}>
        <div className={styles.detailLabel}>Checklist</div>
        <div className={styles.checkRow}>
          <span>{customer.fu1_status ? '☑' : '☐'} FU1 · 2-week check-in {customer.fu1_status ? `(${customer.fu1_status})` : ''}</span>
          {!customer.fu1_status && (
            <span className={styles.checkBtns}>
              <button disabled={busy} onClick={() => void run(() => recordFollowUp(customer.id, 'fu1', 'called'))}>Called</button>
              <button disabled={busy} onClick={() => void run(() => recordFollowUp(customer.id, 'fu1', 'messaged'))}>Messaged</button>
              <button disabled={busy} onClick={() => void run(() => recordFollowUp(customer.id, 'fu1', 'reviewed'))}>Reviewed</button>
            </span>
          )}
        </div>
        <div className={styles.checkRow}>
          <span>{customer.fu2_status ? '☑' : '☐'} FU2 · 4-week check-in {customer.fu2_status ? `(${customer.fu2_status})` : ''}</span>
          {customer.fu1_status && !customer.fu2_status && (
            <span className={styles.checkBtns}>
              <button disabled={busy} onClick={() => void run(() => recordFollowUp(customer.id, 'fu2', 'called'))}>Called</button>
              <button disabled={busy} onClick={() => void run(() => recordFollowUp(customer.id, 'fu2', 'messaged'))}>Messaged</button>
              <button disabled={busy} onClick={() => void run(() => recordFollowUp(customer.id, 'fu2', 'reviewed'))}>Reviewed</button>
            </span>
          )}
        </div>
        {diagnosisTicketId && (
          <div className={styles.checkRow}>
            <span>☐ Diagnosis follow-up (2 weeks after call)</span>
            <span className={styles.checkBtns}>
              <button disabled={busy} onClick={() => void run(() => markDiagnosisFollowupDone(diagnosisTicketId))}>Mark done</button>
            </span>
          </div>
        )}
        {items.map(it => (
          <div key={it.id} className={styles.checkRow}>
            <label className={it.done ? styles.checkDone : ''}>
              <input type="checkbox" checked={it.done} disabled={busy}
                onChange={e => void run(() => toggleActionItem(it.id, e.target.checked), refreshItems)} />
              {' '}{it.text}{it.due_date ? ` · due ${it.due_date}` : ''}
            </label>
            <button className={styles.checkDelete} disabled={busy}
              onClick={() => void run(() => deleteActionItem(it.id), refreshItems)} title="Delete">×</button>
          </div>
        ))}
        <div className={styles.addRow}>
          <input className={styles.addInput} placeholder="New action item…" value={newItem}
            onChange={e => setNewItem(e.target.value)} />
          <input className={styles.addDate} type="date" value={newItemDue}
            onChange={e => setNewItemDue(e.target.value)} />
          <button disabled={busy || !newItem.trim()}
            onClick={() => void run(
              () => addActionItem(customer.id, newItem, newItemDue || null),
              () => { setNewItem(''); setNewItemDue(''); refreshItems(); },
            )}>Add</button>
        </div>
      </div>

      {/* Notes log. */}
      <div className={styles.detailSection}>
        <div className={styles.detailLabel}>Notes</div>
        <div className={styles.addRow}>
          <input className={styles.addInput} placeholder="Add a note…" value={newNote}
            onChange={e => setNewNote(e.target.value)} />
          <button disabled={busy || !newNote.trim()}
            onClick={() => void run(
              () => addCustomerNote(customer.id, newNote),
              () => { setNewNote(''); refreshNotes(); },
            )}>Add note</button>
        </div>
        <div className={styles.notesLog}>
          {notes.map(n => (
            <div key={n.id} className={styles.noteRow}>
              <span className={styles.noteDate}>{new Date(n.created_at).toLocaleDateString()}</span> {n.body}
            </div>
          ))}
          {customer.fu_notes && (
            <div className={`${styles.noteRow} ${styles.noteLegacy}`}>{customer.fu_notes}</div>
          )}
        </div>
      </div>

      <div className={styles.selectedActions}>
        <button className={styles.actionBtn} disabled={busy}
          onClick={() => void run(() => setReviewStatus(customer.id, 'requested'))}>Mark review requested</button>
        <button className={styles.actionBtn} disabled={busy}
          onClick={() => void run(() => setReviewStatus(customer.id, 'received'))}>Mark review received</button>
      </div>
    </div>
  );
}
