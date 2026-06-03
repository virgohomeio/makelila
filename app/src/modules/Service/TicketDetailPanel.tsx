import { useState } from 'react';
import {
  type ServiceTicket, type TicketStatus,
  STATUS_META, CATEGORY_META, PRIORITY_META, SOURCE_LABEL, TOPIC_LABEL, NEXT_STATUSES,
  updateTicketStatus, assignTicketOwner, setTicketPriority,
  updateTicketNotes, setRepairFields, reclassifyTicket,
  useCustomerLifecycle, warrantyState,
  useTicketMessages, useClassificationLog,
} from '../../lib/service';
import { AttachmentStrip } from './AttachmentStrip';
import styles from './Service.module.css';

const OPS_OWNERS = [
  'george@virgohome.io',
  'julie@virgohome.io',
  'junaid@virgohome.io',
  'raymond@virgohome.io',
  'reina@virgohome.io',
  'huayi@virgohome.io',
];

type Props = {
  ticket: ServiceTicket;
  onClose: () => void;
};

export function TicketDetailPanel({ ticket, onClose }: Props) {
  const [notes, setNotes] = useState(ticket.internal_notes ?? '');
  const [defectCat, setDefectCat] = useState(ticket.defect_category ?? '');
  const [parts, setParts] = useState(ticket.parts_needed ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { rows: lifecycle } = useCustomerLifecycle();
  const lifecycleRow = ticket.unit_serial ? lifecycle.find(l => l.unit_serial === ticket.unit_serial) : null;
  const warranty = warrantyState(lifecycleRow ?? null);
  const { messages } = useTicketMessages(ticket.source === 'gmail' ? ticket.id : null);
  const { entries: classifyLog } = useClassificationLog(
    (ticket.source === 'gmail' || ticket.topic) ? ticket.id : null,
  );

  const cat = CATEGORY_META[ticket.category];
  const status = STATUS_META[ticket.status];
  const prio = PRIORITY_META[ticket.priority];

  async function run<T>(p: Promise<T>) {
    setBusy(true); setError(null);
    try { await p; }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className={styles.detailOverlay}>
      <div className={styles.detailHead}>
        <div>
          <div className={styles.detailTicketNum}>{ticket.ticket_number}</div>
          <h3 className={styles.detailSubject}>{ticket.subject}</h3>
          <div className={styles.detailMetaRow}>
            <span className={styles.pill} style={{ background: cat.bg, color: cat.color }}>{cat.label}</span>
            <span className={styles.pill} style={{ background: status.bg, color: status.color }}>{status.label}</span>
            <span className={styles.pill} style={{ background: '#f7fafc', color: prio.color }}>{prio.label}</span>
            <span className={styles.pill} style={{ background: '#edf2f7', color: '#4a5568' }}>
              {SOURCE_LABEL[ticket.source]}
            </span>
            <span
              className={`${styles.warrantyPill} ${
                warranty.state === 'active'  ? styles.warrantyActive  :
                warranty.state === 'expired' ? styles.warrantyExpired :
                                               styles.warrantyNa
              }`}
              title={lifecycleRow ? `Expires ${new Date(lifecycleRow.warranty_expires_at).toLocaleDateString()}` : ''}
            >
              {warranty.state === 'active'  && `Warranty • ${warranty.daysFromNow}d left`}
              {warranty.state === 'expired' && `Warranty expired ${Math.abs(warranty.daysFromNow)}d ago`}
              {warranty.state === 'na'      && 'No unit linked'}
            </span>
          </div>
        </div>
        <button className={styles.detailClose} onClick={onClose}>✕</button>
      </div>

      <div className={styles.detailBody}>
        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Customer</div>
          <div className={styles.detailFieldGrid}>
            <span className={styles.detailFieldLabel}>Name</span>
            <span className={styles.detailFieldValue}>{ticket.customer_name ?? '—'}</span>
            <span className={styles.detailFieldLabel}>Email</span>
            <span className={styles.detailFieldValue}>{ticket.customer_email ?? '—'}</span>
            <span className={styles.detailFieldLabel}>Phone</span>
            <span className={styles.detailFieldValue}>{ticket.customer_phone ?? '—'}</span>
            <span className={styles.detailFieldLabel}>Unit serial</span>
            <span className={styles.detailFieldValue}>{ticket.unit_serial ?? '—'}</span>
            <span className={styles.detailFieldLabel}>Order ref</span>
            <span className={styles.detailFieldValue}>{ticket.order_ref ?? '—'}</span>
            <span className={styles.detailFieldLabel}>Created</span>
            <span className={styles.detailFieldValue}>{new Date(ticket.created_at).toLocaleString()}</span>
          </div>
        </div>

        {(ticket.topic || ticket.summary || ticket.suggested_next_action) && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionLabel}>
              Classification
              {ticket.is_manually_overridden && (
                <span style={{ marginLeft: 8, fontSize: 9, color: '#c05621', fontWeight: 800 }}>
                  • MANUAL OVERRIDE
                </span>
              )}
            </div>
            <div className={styles.detailFieldGrid}>
              <span className={styles.detailFieldLabel}>Topic</span>
              <span className={styles.detailFieldValue}>{ticket.topic ? TOPIC_LABEL[ticket.topic] : '—'}</span>
              <span className={styles.detailFieldLabel}>Summary</span>
              <span className={styles.detailFieldValue}>{ticket.summary ?? '—'}</span>
              <span className={styles.detailFieldLabel}>Suggested action</span>
              <span className={styles.detailFieldValue}>{ticket.suggested_next_action ?? '—'}</span>
            </div>
            <div className={styles.actionsRow}>
              <button
                className={styles.btnSecondary}
                disabled={busy}
                onClick={() => run(reclassifyTicket(ticket.id))}
              >🔄 Reclassify</button>
            </div>
          </div>
        )}

        {ticket.description && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionLabel}>Description</div>
            <div className={styles.detailValue}>{ticket.description}</div>
          </div>
        )}

        {messages.length > 0 && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionLabel}>Conversation ({messages.length})</div>
            <div className={styles.threadList}>
              {messages.map(m => (
                <div
                  key={m.id}
                  className={`${styles.threadMsg} ${m.direction === 'outbound' ? styles.threadMsgOut : styles.threadMsgIn}`}
                >
                  <div className={styles.threadMsgMeta}>
                    {m.direction === 'outbound' ? 'Staff' : 'Customer'}
                    {m.sender ? ` · ${m.sender}` : ''}
                    {m.sent_at ? ` · ${new Date(m.sent_at).toLocaleString()}` : ''}
                  </div>
                  <div className={styles.threadMsgBody}>
                    {m.body_text || m.snippet || '—'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {classifyLog.length > 0 && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionLabel}>Classification history ({classifyLog.length})</div>
            <div className={styles.classifyList}>
              {classifyLog.map(e => (
                <div key={e.id} className={styles.classifyEntry}>
                  <span className={styles.classifyTime}>{new Date(e.created_at).toLocaleString()}</span>
                  <span>
                    <strong>{e.priority ?? '—'}</strong> / {e.category ?? '—'}
                    <span className={styles.classifyRule}> · {e.method}{e.rule_id ? ` · ${e.rule_id}` : ''}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Attachments</div>
          <AttachmentStrip ticketId={ticket.id} />
        </div>

        {ticket.category === 'repair' && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionLabel}>Repair details</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <select className={styles.select} value={defectCat} onChange={e => setDefectCat(e.target.value)}>
                <option value="">— Defect category —</option>
                <option value="Door">Door</option>
                <option value="Auger">Auger</option>
                <option value="Heater">Heater</option>
                <option value="Sensor">Sensor</option>
                <option value="Wiring">Wiring</option>
                <option value="Other">Other</option>
              </select>
              <textarea
                className={styles.textarea}
                placeholder="Parts needed (free-text)"
                value={parts}
                onChange={e => setParts(e.target.value)}
              />
              <button
                className={styles.btnSecondary}
                disabled={busy}
                onClick={() => run(setRepairFields(ticket.id, { defect_category: defectCat || null, parts_needed: parts || null }))}
              >Save repair details</button>
            </div>
          </div>
        )}

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Status — transition</div>
          <div className={styles.actionsRow}>
            {NEXT_STATUSES[ticket.status].map(next => (
              <button
                key={next}
                className={styles.btnPrimary}
                disabled={busy}
                onClick={() => run(updateTicketStatus(ticket.id, next as TicketStatus))}
              >→ {STATUS_META[next].label}</button>
            ))}
          </div>
        </div>

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Owner</div>
          <select
            className={styles.select}
            value={ticket.owner_email ?? ''}
            disabled={busy}
            onChange={(e) => void run(assignTicketOwner(ticket.id, e.target.value || null))}
          >
            <option value="">— Unassigned —</option>
            {OPS_OWNERS.map(e => <option key={e} value={e}>{e}</option>)}
          </select>
        </div>

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Priority</div>
          <div className={styles.actionsRow}>
            {(['low','normal','high','urgent'] as const).map(p => (
              <button
                key={p}
                className={ticket.priority === p ? styles.btnPrimary : styles.btnSecondary}
                disabled={busy}
                onClick={() => run(setTicketPriority(ticket.id, p))}
              >{PRIORITY_META[p].label}</button>
            ))}
          </div>
        </div>

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Internal notes</div>
          <textarea
            className={styles.textarea}
            placeholder="Internal notes (ops only)"
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />
          <div className={styles.actionsRow}>
            <button
              className={styles.btnSecondary}
              disabled={busy}
              onClick={() => run(updateTicketNotes(ticket.id, notes))}
            >Save notes</button>
          </div>
        </div>

        {ticket.hubspot_ticket_id && (
          <div className={styles.detailSection}>
            <a
              className={styles.btnGhost}
              href={`https://app.hubspot.com/contacts/_/tickets/${ticket.hubspot_ticket_id}`}
              target="_blank"
              rel="noreferrer"
            >Open in HubSpot ↗</a>
          </div>
        )}

        {error && <div style={{ color: 'var(--color-error)', fontSize: 11 }}>{error}</div>}
      </div>
    </div>
  );
}
