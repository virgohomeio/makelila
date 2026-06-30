import { useEffect, useState } from 'react';
import {
  recordFollowUp, setReviewStatus, computeFuState, FU_STATE_META,
  updateCustomerProfile, type Customer, type CustomerProfilePatch,
} from '../../lib/customers';
import { markDiagnosisFollowupDone, type ServiceTicket, priorityMeta } from '../../lib/service';
import { useReplacementQueue } from '../../lib/postShipment';
import {
  useActionItems, useCustomerNotes, addActionItem, toggleActionItem, deleteActionItem,
  addCustomerNote, deleteCustomerNote, setCustomerManualTags, MANUAL_TAGS,
} from '../../lib/followups';
import { STATUS_FILTERS, type FollowUpStatusKey } from '../../lib/followupStatus';
import styles from './FollowUps.module.css';

const labelOf = (k: FollowUpStatusKey) => STATUS_FILTERS.find(f => f.key === k)?.label ?? k;

const REPL_STATUS_LABEL: Record<string, string> = {
  queued: 'Pending', assigned: 'Assigned', shipped: 'Shipped', closed: 'Closed',
};

export function FollowUpDetailPanel({
  customer, openTickets, isPaused, diagnosisTicketId, onClose, onChanged,
}: {
  customer: Customer;
  openTickets: ServiceTicket[];
  isPaused: boolean;
  diagnosisTicketId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { items, refresh: refreshItems } = useActionItems(customer.id);
  const { notes, refresh: refreshNotes } = useCustomerNotes(customer.id);
  const { queue } = useReplacementQueue();
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

  const saveProfile = (patch: CustomerProfilePatch) => void run(() => updateCustomerProfile(customer.id, patch));

  const lcEmail = (customer.email ?? '').toLowerCase();
  const replacements = queue.filter(r =>
    (r.customer_email && r.customer_email.toLowerCase() === lcEmail)
    || r.customer_name === customer.full_name,
  );

  const availableTags = MANUAL_TAGS.filter(k => !tags.includes(k));

  const pausedNote = 'Paused because of an open HubSpot ticket. Will resume 14/28 days after the ticket is resolved.';

  return (
    <div className={styles.selectedPanel}>
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className={styles.profHeader}>
        <div className={styles.profHeaderTop}>
          <strong className={styles.profName}>{customer.full_name}</strong>
          <button className={styles.closeBtn} onClick={onClose} title="Close">×</button>
        </div>
        <div className={styles.profHeaderRow}>
          {customer.email && <span>{customer.email}</span>}
          {customer.hubspot_id && (
            <a className={styles.profHubspot} target="_blank" rel="noreferrer"
               href={`https://app.hubspot.com/contacts/_/contact/${customer.hubspot_id}`}>HubSpot ↗</a>
          )}
        </div>
        {customer.phone && <div className={styles.profHeaderRow}><span className={styles.profQuo}>Quo</span> {customer.phone}</div>}
      </div>

      {/* ── Status tags ────────────────────────────────────────── */}
      <div className={styles.profCard}>
        <div className={styles.profCardLabel}>Status Tags</div>
        <div className={styles.detailTags}>
          {tags.length === 0 && <span className={styles.profMuted}>No tags yet</span>}
          {tags.map(k => (
            <button key={k} disabled={busy} className={`${styles.detailTag} ${styles.detailTagOn}`}
              onClick={() => toggleTag(k as FollowUpStatusKey)} title="Remove tag">
              {labelOf(k as FollowUpStatusKey)} ✕
            </button>
          ))}
        </div>
        {availableTags.length > 0 && (
          <select className={styles.profSelect} disabled={busy} value=""
            onChange={e => { if (e.target.value) toggleTag(e.target.value as FollowUpStatusKey); }}>
            <option value="">+ Add another status tag…</option>
            {availableTags.map(k => <option key={k} value={k}>{labelOf(k)}</option>)}
          </select>
        )}
      </div>

      {/* ── Profile (all fields editable) ──────────────────────── */}
      <div className={styles.profCard}>
        <div className={styles.profCardLabel}>Profile <span className={styles.profMuted}>— click any field to edit</span></div>
        <EditableRow label="Serial"    value={customer.serials?.[0] ?? ''} placeholder="LL01-…" onSave={v => saveProfile({ serial: v })} />
        <EditableRow label="Color"     value={customer.color ?? ''}        placeholder="White / Black" onSave={v => saveProfile({ color: v })} />
        <EditableRow label="Shipped"   value={customer.shipped_on ?? ''}   type="date" onSave={v => saveProfile({ shipped_on: v })} />
        <EditableRow label="Received"  value={customer.received_on ?? ''}  type="date" onSave={v => saveProfile({ received_on: v })} />
        <EditableRow label="Onboarded" value={customer.onboard_date ?? ''} type="date" onSave={v => saveProfile({ onboard_date: v })} />
        <EditableRow label="Diagnosis" value={customer.diagnosis_on ?? ''} type="date" onSave={v => saveProfile({ diagnosis_on: v })} />
        <EditableRow label="Dashboard" value={customer.dashboard ?? ''}    placeholder="yes / no / etc." onSave={v => saveProfile({ dashboard: v })} />
        <EditableRow label="Software"  value={customer.software ?? ''}     placeholder="V17 / V18 / …" onSave={v => saveProfile({ software: v })} />
        <EditableRow label="Timezone"  value={customer.timezone ?? ''}     placeholder="EST / PST / …" onSave={v => saveProfile({ timezone: v })} />
        <EditableRow label="Address"   value={customer.address_line ?? ''} placeholder="Street, City, State" onSave={v => saveProfile({ address_line: v })} />
      </div>

      {/* ── Open HubSpot tickets + pause banner ────────────────── */}
      {openTickets.length > 0 && (
        <div className={`${styles.profCard} ${styles.profCardWarn}`}>
          <div className={styles.profCardLabel}>⚠ Open HubSpot Tickets ({openTickets.length})</div>
          {isPaused && (
            <div className={styles.profPauseBanner}>
              <strong>⏸ Follow-ups paused</strong> — pending follow-ups for this customer are on hold until the
              ticket is resolved. They'll auto-reschedule to 14/28 days after the ticket close date.
            </div>
          )}
          {openTickets.map(t => (
            <div key={t.id} className={styles.profTicket}>
              <div className={styles.profTicketTop}>
                <span className={styles.profTicketNo}>{t.ticket_number}</span>
                <span className={styles.profTicketStatus}>{t.status.replace(/_/g, ' ')}</span>
              </div>
              <div className={styles.profTicketSubj}>{t.subject}</div>
              <div className={styles.profMuted}>
                Priority: <strong>{priorityMeta(t.priority).label}</strong>
                {t.hubspot_ticket_id && (
                  <> · <a target="_blank" rel="noreferrer"
                    href={`https://app.hubspot.com/contacts/_/tickets/${t.hubspot_ticket_id}`}>Open in HubSpot →</a></>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Replacements ───────────────────────────────────────── */}
      {replacements.length > 0 && (
        <div className={`${styles.profCard} ${styles.profCardRepl}`}>
          <div className={styles.profCardLabel}>🔧 Replacements ({replacements.length})</div>
          {replacements.map(r => (
            <div key={r.id} className={styles.profTicket}>
              <div className={styles.profTicketTop}>
                <span className={styles.profTicketSubj}>{r.notes || r.original_unit_serial || 'Replacement'}</span>
                <span className={styles.profTicketStatus}>{REPL_STATUS_LABEL[r.status] ?? r.status}</span>
              </div>
              <div className={styles.profMuted}>
                {r.assigned_serial ? `Assigned ${r.assigned_serial}` : 'No tracking yet — pending'}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Connect to dashboard (static) ──────────────────────── */}
      <div className={styles.profCard}>
        <div className={styles.profCardLabel}>📊 Connect to Dashboard</div>
        <ol className={styles.profSteps}>
          <li>Ensure power is on — light should be <strong>Solid Green</strong></li>
          <li>On phone WiFi → connect to <strong>"LL01-[Serial#]"</strong> → password <strong>"12345678"</strong> → "Connect without Internet"</li>
          <li>Open browser → go to <strong>192.168.4.1</strong></li>
          <li>Enter home WiFi name in SSID + password → click <strong>Connect</strong></li>
        </ol>
        <div className={styles.profMuted}>
          After connect: wait for STA state "Connected" → click "Start Update" → wait 30-35 min for green light → power cycle
        </div>
      </div>

      {/* ── Trustpilot (static) ────────────────────────────────── */}
      <div className={styles.profCard}>
        <div className={styles.profCardLabel}>★ Trustpilot Review Link</div>
        <a target="_blank" rel="noreferrer" href="https://trustpilot.com/review/lilacomposter.com">
          trustpilot.com/review/lilacomposter.com
        </a>
        <div className={styles.profMuted}>Send when compost is good — mark status "Review Done" once submitted.</div>
      </div>

      {/* ── Action items (FU1/FU2 + manual), pause-aware ───────── */}
      <div className={styles.profCard}>
        <div className={styles.profCardLabel}>🗒 Action Items</div>

        <FollowUpItem
          label="1st follow-up (2 weeks after onboarding)" tag="1ST FU"
          done={!!customer.fu1_status} doneLabel={customer.fu1_status}
          paused={isPaused} pausedNote={pausedNote} busy={busy}
          onAction={(m) => void run(() => recordFollowUp(customer.id, 'fu1', m))}
        />
        <FollowUpItem
          label="2nd follow-up (2 weeks after 1st follow-up)" tag="2ND FU"
          done={!!customer.fu2_status} doneLabel={customer.fu2_status}
          paused={isPaused} pausedNote={pausedNote} busy={busy}
          locked={!customer.fu1_status}
          onAction={(m) => void run(() => recordFollowUp(customer.id, 'fu2', m))}
        />

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
          <input className={styles.addInput} placeholder="+ Add new action item…" value={newItem}
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

      {/* ── Notes + review actions ─────────────────────────────── */}
      <div className={styles.profCard}>
        <div className={styles.profCardLabel}>Notes</div>
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
              <span className={styles.noteDate}>{new Date(n.created_at).toLocaleDateString()}</span>
              <span className={styles.noteBody}>{n.body}</span>
              <button className={styles.checkDelete} disabled={busy} title="Delete note"
                onClick={() => void run(() => deleteCustomerNote(n.id, customer.id), refreshNotes)}>×</button>
            </div>
          ))}
          {customer.fu_notes && <div className={`${styles.noteRow} ${styles.noteLegacy}`}>{customer.fu_notes}</div>}
        </div>
      </div>

      <div className={styles.selectedActions}>
        <span className={styles.selectedKind} style={{ color: FU_STATE_META[fu].color, background: FU_STATE_META[fu].bg }}>
          {FU_STATE_META[fu].label}
        </span>
        <button className={styles.actionBtn} disabled={busy}
          onClick={() => void run(() => setReviewStatus(customer.id, 'requested'))}>Mark review requested</button>
        <button className={styles.actionBtn} disabled={busy}
          onClick={() => void run(() => setReviewStatus(customer.id, 'received'))}>Mark review received</button>
      </div>
    </div>
  );
}

function EditableRow({
  label, value, type, placeholder, onSave,
}: {
  label: string; value: string; type?: 'text' | 'date'; placeholder?: string; onSave: (v: string) => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  return (
    <div className={styles.profRow}>
      <span className={styles.profRowLabel}>{label}</span>
      <input
        className={styles.profEditInput}
        type={type ?? 'text'}
        value={v}
        placeholder={placeholder}
        onChange={e => setV(e.target.value)}
        onBlur={() => { if (v !== value) onSave(v); }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    </div>
  );
}

function FollowUpItem({
  label, tag, done, doneLabel, paused, pausedNote, locked, busy, onAction,
}: {
  label: string; tag: string; done: boolean; doneLabel: string | null;
  paused: boolean; pausedNote: string; locked?: boolean; busy: boolean;
  onAction: (method: 'called' | 'messaged' | 'reviewed') => void;
}) {
  return (
    <div className={`${styles.fuItem} ${paused && !done ? styles.fuItemPaused : ''}`}>
      <div className={styles.fuItemTop}>
        <span>{done ? '☑' : '☐'} {label} {done && doneLabel ? `(${doneLabel})` : ''}</span>
        <span className={styles.fuItemTags}>
          <span className={styles.fuTag}>{tag}</span>
          {paused && !done && <span className={styles.fuOnHold}>⏸ ON HOLD</span>}
        </span>
      </div>
      {paused && !done && <div className={styles.profMuted}>{pausedNote}</div>}
      {!done && !locked && !paused && (
        <span className={styles.checkBtns}>
          <button disabled={busy} onClick={() => onAction('called')}>Called</button>
          <button disabled={busy} onClick={() => onAction('messaged')}>Messaged</button>
          <button disabled={busy} onClick={() => onAction('reviewed')}>Reviewed</button>
        </span>
      )}
    </div>
  );
}
