import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import ReplacementPickerModal from './ReplacementPickerModal';
import { useCustomers, sendFollowupSms } from '../../lib/customers';
import {
  type ServiceTicket, type TicketStatus, type IssueArea, type TicketCategory,
  STATUS_META, CATEGORY_META, PRIORITY_META, NEXT_STATUSES, TICKET_STATUSES,
  statusMeta, priorityMeta, sourceLabel, topicLabel, slaChip,
  ISSUE_AREAS, ISSUE_AREA_LABEL,
  updateTicketStatus, assignTicketOwner, setTicketPriority, setTicketIssueArea, setTicketCategory,
  setRepairFields, reclassifyTicket, deleteTicket, updateTicketSubject, setTicketDescription,
  markDiagnosisLinkSent, setLinearIssueUrl, setGitHubIssueUrl,
  useCustomerLifecycle, warrantyState,
  useTicketMessages, useClassificationLog,
  autoTicketDescription,
} from '../../lib/service';
import { CANNED_SMS_TEMPLATES } from '../../lib/cannedSms';
import { createLinearIssue, createGitHubIssue } from '../../lib/githubLinear';
import { useReplacementSummary } from '../../lib/orders';
import { AttachmentStrip } from './AttachmentStrip';
import { TicketNotes } from './TicketNotes';
import { DeviceContextHeader } from '../../components/DeviceContextHeader';
import styles from './Service.module.css';

// Backlog #39 — keep in sync with public.team_invite_list. Aaron/Ashwini
// were removed earlier (left the company); Lezhong + Pedrum added
// 2026-06-04 matching the invite list. Julie rejoined 2026-06-07 under
// yueli@virgohome.io (her actual account — the prior julie@ guess never
// existed). Long-term this should query the invite list directly instead
// of hard-coding (see also #72 — central template / config store).
const OPS_OWNERS = [
  'george@virgohome.io',
  'huayi@virgohome.io',
  'junaid@virgohome.io',
  'lezhong@virgohome.io',
  'pedrum@virgohome.io',
  'raymond@virgohome.io',
  'reina@virgohome.io',
  'yueli@virgohome.io',
];

type Props = {
  ticket: ServiceTicket;
  onClose: () => void;
};

// Shows what the customer is queued up for on the linked replacement order —
// the items (units/parts) and the batch/fulfillment state — right in the
// ticket, so an operator doesn't have to click through to Order Review.
function QueuedReplacementDetails({ orderId }: { orderId: string }) {
  const { summary, loading } = useReplacementSummary(orderId);
  if (loading || !summary) return null;

  const items = (summary.line_items ?? [])
    .map(li => li?.name)
    .filter((n): n is string => !!n);
  // Batch-blocked orders can carry the batch in awaiting_batch_id with empty
  // line_items (e.g. a straight "awaiting P100X / LILA-Mini" queue).
  if (items.length === 0 && summary.awaiting_batch_id) {
    items.push(`LILA (${summary.awaiting_batch_id})`);
  }

  const shipped = !!(summary.shipped_at || summary.delivered_at);
  const status = shipped
    ? { label: 'Shipped', color: '#2b6cb0' }
    : summary.awaiting_batch_id
      ? { label: `Awaiting batch · ${summary.awaiting_batch_id}`, color: '#c05621' }
      : summary.replacement_state === 'awaiting'
        ? { label: 'Awaiting stock', color: '#c05621' }
        : summary.replacement_state === 'held'
          ? { label: 'Held', color: '#9b2c2c' }
          : { label: 'Ready to ship', color: '#276749' };

  return (
    <div className={styles.queuedRepl}>
      <div className={styles.queuedReplHead}>
        <span className={styles.queuedReplLabel}>
          Queued for{summary.order_ref ? ` · ${summary.order_ref}` : ''}
        </span>
        <span className={styles.queuedReplStatus} style={{ color: status.color }}>{status.label}</span>
      </div>
      {items.length > 0 ? (
        <div className={styles.queuedReplItems}>
          {items.map((name, i) => (
            <span key={i} className={styles.queuedReplChip}>{name}</span>
          ))}
        </div>
      ) : (
        <div className={styles.queuedReplEmpty}>No items recorded on this replacement.</div>
      )}
    </div>
  );
}

export function TicketDetailPanel({ ticket, onClose }: Props) {
  const navigate = useNavigate();
  const [defectCat, setDefectCat] = useState(ticket.defect_category ?? '');
  const [parts, setParts] = useState(ticket.parts_needed ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingSubject, setEditingSubject] = useState(false);
  const [subjectDraft, setSubjectDraft] = useState(ticket.subject);
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState(ticket.description ?? '');
  const [pickerOpen, setPickerOpen] = useState(false);
  // Backlog #75 — diagnosis-link send dialog state.
  const [diagOpen, setDiagOpen] = useState(false);
  const [diagSending, setDiagSending] = useState(false);
  const { customers } = useCustomers();
  const linkedCustomer = useMemo(() =>
    ticket.customer_id ? customers.find(c => c.id === ticket.customer_id) : null,
    [customers, ticket.customer_id]);
  const pickerAddress = useMemo(() => ({
    address_line: linkedCustomer?.address_line ?? null,
    city: linkedCustomer?.city ?? '',
    region_state: linkedCustomer?.region ?? null,
    country: (linkedCustomer?.country === 'US' ? 'US' : 'CA') as 'US' | 'CA',
    postal_code: linkedCustomer?.postal_code ?? null,
  }), [linkedCustomer]);

  async function saveSubject() {
    const next = subjectDraft.trim();
    if (!next || next === ticket.subject) { setEditingSubject(false); return; }
    setBusy(true); setError(null);
    try {
      await updateTicketSubject(ticket.id, next);
      setEditingSubject(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveDescription() {
    const next = descriptionDraft.trim();
    if (next === (ticket.description ?? '')) { setEditingDescription(false); return; }
    setBusy(true); setError(null);
    try {
      await setTicketDescription(ticket.id, next);
      setEditingDescription(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Backlog #75 — default body interpolates the customer's first name
  // from customer_name; falls back to "there" when name is missing so
  // the message still reads naturally. Operator can edit before sending.
  const diagDefaultBody = useMemo(() => {
    const fn = (ticket.customer_name ?? '').trim().split(/\s+/)[0] || 'there';
    return CANNED_SMS_TEMPLATES.diagnosis_call_request.body(fn);
  }, [ticket.customer_name]);
  const [diagBody, setDiagBody] = useState(diagDefaultBody);

  // Feature 3 — "Link to engineering" dialog state.
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkTarget, setLinkTarget] = useState<'linear' | 'github'>('linear');
  const [linkTeamKey, setLinkTeamKey] = useState('VCY');
  const [linkRepo, setLinkRepo] = useState('virgohomeio/lila-firmware');
  const [linkTitle, setLinkTitle] = useState('');
  const [linkBody, setLinkBody] = useState('');
  const [linkSubmitting, setLinkSubmitting] = useState(false);

  async function onOpenLinkDialog() {
    setLinkTitle(ticket.subject);
    setLinkBody(ticket.description ?? '');
    setLinkOpen(true);
  }

  async function onSubmitLink() {
    setLinkSubmitting(true); setError(null);
    try {
      if (linkTarget === 'linear') {
        const { url } = await createLinearIssue(ticket, {
          teamKey: linkTeamKey.trim(),
          title: linkTitle.trim(),
          description: linkBody.trim(),
        });
        await setLinearIssueUrl(ticket.id, url);
      } else {
        const { url } = await createGitHubIssue(ticket, {
          repo: linkRepo.trim(),
          title: linkTitle.trim(),
          body: linkBody.trim(),
        });
        await setGitHubIssueUrl(ticket.id, url);
      }
      setLinkOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLinkSubmitting(false);
    }
  }

  async function onSendDiagnosisLink() {
    if (!ticket.customer_id) {
      setError('Ticket is not linked to a customer record — cannot send SMS.');
      return;
    }
    if (!ticket.customer_phone) {
      setError('Customer has no phone number on file.');
      return;
    }
    setDiagSending(true); setError(null);
    try {
      await sendFollowupSms({ customer_id: ticket.customer_id, message: diagBody });
      await markDiagnosisLinkSent(ticket.id);
      setDiagOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDiagSending(false);
    }
  }

  async function onDelete() {
    setBusy(true); setError(null);
    try {
      await deleteTicket(ticket.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const { rows: lifecycle } = useCustomerLifecycle();
  const lifecycleRow = ticket.unit_serial ? lifecycle.find(l => l.unit_serial === ticket.unit_serial) : null;
  const warranty = warrantyState(lifecycleRow ?? null);
  const { messages } = useTicketMessages(ticket.source === 'gmail' ? ticket.id : null);
  const { entries: classifyLog } = useClassificationLog(
    (ticket.source === 'gmail' || ticket.topic) ? ticket.id : null,
  );

  const cat = CATEGORY_META[ticket.category];
  const status = statusMeta(ticket.status);
  const prio = priorityMeta(ticket.priority);

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
          {editingSubject ? (
            <div className={styles.subjectEditRow}>
              <input
                className={styles.subjectEditInput}
                value={subjectDraft}
                autoFocus
                disabled={busy}
                onChange={e => setSubjectDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void saveSubject();
                  if (e.key === 'Escape') { setSubjectDraft(ticket.subject); setEditingSubject(false); }
                }}
              />
              <button className={styles.btnPrimary} disabled={busy} onClick={() => void saveSubject()}>Save</button>
              <button
                className={styles.btnSecondary}
                disabled={busy}
                onClick={() => { setSubjectDraft(ticket.subject); setEditingSubject(false); }}
              >Cancel</button>
            </div>
          ) : (
            <h3 className={styles.detailSubject}>
              {ticket.subject}
              <button
                className={styles.subjectEditBtn}
                title="Edit subject"
                onClick={() => { setSubjectDraft(ticket.subject); setEditingSubject(true); }}
              >✎</button>
            </h3>
          )}
          <div className={styles.detailMetaRow}>
            <span className={styles.pill} style={{ background: cat.bg, color: cat.color }}>{cat.label}</span>
            <span className={styles.pill} style={{ background: status.bg, color: status.color }}>{status.label}</span>
            <span className={styles.pill} style={{ background: '#f7fafc', color: prio.color }}>{prio.label}</span>
            <span className={styles.pill} style={{ background: '#edf2f7', color: '#4a5568' }}>
              {sourceLabel(ticket.source)}
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

      <DeviceContextHeader unitSerial={ticket.unit_serial} currentTicketId={ticket.id} />

      {ticket.source === 'telemetry_auto' && (
        <TelemetryAutoBanner ticket={ticket} />
      )}

      {ticket.sla_policy_id && (
        <SlaDeadlines ticket={ticket} />
      )}

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
            {ticket.status === 'closed' && ticket.closed_at && (
              <>
                <span className={styles.detailFieldLabel}>Closed</span>
                <span className={styles.detailFieldValue}>{new Date(ticket.closed_at).toLocaleString()}</span>
              </>
            )}
          </div>
        </div>

        <div className={styles.detailSection} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {ticket.replacement_order_id && ticket.replacement_order_id.length > 0 ? (
            <div className={styles.replacementLink} style={{ flexBasis: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div>
                Replacement order:&nbsp;
                <a
                  href={`/order-review/${ticket.replacement_order_id}`}
                  onClick={e => { e.preventDefault(); navigate(`/order-review/${ticket.replacement_order_id}`); }}
                >open in Order Review</a>
              </div>
              <QueuedReplacementDetails orderId={ticket.replacement_order_id} />
            </div>
          ) : (
            <button
              type="button"
              className={styles.replacementBtn}
              disabled={busy}
              onClick={() => setPickerOpen(true)}
            >
              Send replacement
            </button>
          )}
          {/* Backlog #75 — diagnosis-call booking link via SMS. Disabled
              when the ticket has no customer FK or no phone on file
              (covered in onSendDiagnosisLink with an error message). */}
          {ticket.diagnosis_link_sent_at ? (
            <span className={styles.replacementLink} title={ticket.diagnosis_link_sent_at}>
              Diagnosis link sent {new Date(ticket.diagnosis_link_sent_at).toLocaleDateString()}
            </span>
          ) : (
            <button
              type="button"
              className={styles.replacementBtn}
              disabled={busy}
              onClick={() => { setDiagBody(diagDefaultBody); setDiagOpen(true); }}
              title="Send the customer a diagnosis-call booking link via SMS"
            >
              Send diagnosis link
            </button>
          )}
          {/* Feature 3 — engineering issue linking */}
          {ticket.linear_issue_url ? (
            <a
              className={styles.replacementLink}
              href={ticket.linear_issue_url}
              target="_blank"
              rel="noreferrer"
              title="Open Linear issue"
            >
              Linear issue ↗
            </a>
          ) : ticket.github_issue_url ? (
            <a
              className={styles.replacementLink}
              href={ticket.github_issue_url}
              target="_blank"
              rel="noreferrer"
              title="Open GitHub issue"
            >
              GitHub issue ↗
            </a>
          ) : (
            <button
              type="button"
              className={styles.replacementBtn}
              disabled={busy}
              onClick={() => void onOpenLinkDialog()}
              title="Create a Linear or GitHub engineering issue from this ticket"
            >
              Link to engineering
            </button>
          )}
          {ticket.engineering_resolved_at && !ticket.closed_at && (
            <span
              className={styles.replacementLink}
              style={{ background: '#f0fff4', color: '#276749', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}
              title={`Engineering resolved at ${new Date(ticket.engineering_resolved_at).toLocaleString()}`}
            >
              Engineering fixed — follow up with customer
            </span>
          )}
        </div>

        {diagOpen && (
          <div className={styles.diagModalBackdrop} onClick={() => !diagSending && setDiagOpen(false)}>
            <div className={styles.diagModal} onClick={e => e.stopPropagation()}>
              <div className={styles.diagModalTitle}>Send diagnosis-call link</div>
              <div className={styles.diagModalMeta}>
                To: {ticket.customer_name ?? '—'} ({ticket.customer_phone ?? 'no phone on file'})
              </div>
              <textarea
                className={styles.diagModalTextarea}
                value={diagBody}
                onChange={e => setDiagBody(e.target.value)}
                rows={5}
                disabled={diagSending}
              />
              <div className={styles.diagModalActions}>
                <button
                  type="button"
                  className={styles.replacementBtn}
                  disabled={diagSending || !ticket.customer_id || !ticket.customer_phone || !diagBody.trim()}
                  onClick={() => void onSendDiagnosisLink()}
                >
                  {diagSending ? 'Sending…' : 'Send SMS'}
                </button>
                <button
                  type="button"
                  onClick={() => setDiagOpen(false)}
                  disabled={diagSending}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {pickerOpen && (
          <ReplacementPickerModal
            ticket={{
              id: ticket.id,
              customer_name: ticket.customer_name,
              customer_email: ticket.customer_email,
              customer_phone: ticket.customer_phone,
              ticket_number: ticket.ticket_number,
            }}
            address={pickerAddress}
            onClose={() => setPickerOpen(false)}
            onCreated={(result) => {
              setPickerOpen(false);
              navigate(`/order-review/${result.id}`);
            }}
          />
        )}

        {linkOpen && (
          <div className={styles.diagModalBackdrop} onClick={() => !linkSubmitting && setLinkOpen(false)}>
            <div className={styles.diagModal} onClick={e => e.stopPropagation()}>
              <div className={styles.diagModalTitle}>Link to engineering issue</div>
              <div className={styles.diagModalMeta} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="linkTarget"
                    value="linear"
                    checked={linkTarget === 'linear'}
                    onChange={() => setLinkTarget('linear')}
                    disabled={linkSubmitting}
                  />
                  Linear
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="linkTarget"
                    value="github"
                    checked={linkTarget === 'github'}
                    onChange={() => setLinkTarget('github')}
                    disabled={linkSubmitting}
                  />
                  GitHub
                </label>
              </div>
              {linkTarget === 'linear' ? (
                <div className={styles.diagModalMeta} style={{ marginBottom: 8 }}>
                  <label style={{ display: 'block', fontSize: 11, marginBottom: 2 }}>Linear team key</label>
                  <input
                    className={styles.subjectEditInput}
                    value={linkTeamKey}
                    onChange={e => setLinkTeamKey(e.target.value)}
                    disabled={linkSubmitting}
                    placeholder="e.g. VCY"
                    style={{ width: 100 }}
                  />
                </div>
              ) : (
                <div className={styles.diagModalMeta} style={{ marginBottom: 8 }}>
                  <label style={{ display: 'block', fontSize: 11, marginBottom: 2 }}>GitHub repo (owner/repo)</label>
                  <input
                    className={styles.subjectEditInput}
                    value={linkRepo}
                    onChange={e => setLinkRepo(e.target.value)}
                    disabled={linkSubmitting}
                    placeholder="virgohomeio/lila-firmware"
                    style={{ width: 260 }}
                  />
                </div>
              )}
              <div className={styles.diagModalMeta} style={{ marginBottom: 4 }}>
                <label style={{ display: 'block', fontSize: 11, marginBottom: 2 }}>Issue title</label>
                <input
                  className={styles.subjectEditInput}
                  value={linkTitle}
                  onChange={e => setLinkTitle(e.target.value)}
                  disabled={linkSubmitting}
                  style={{ width: '100%' }}
                />
              </div>
              <textarea
                className={styles.diagModalTextarea}
                value={linkBody}
                onChange={e => setLinkBody(e.target.value)}
                rows={4}
                disabled={linkSubmitting}
                placeholder="Description (optional — ticket number is always appended)"
              />
              <div className={styles.diagModalActions}>
                <button
                  type="button"
                  className={styles.replacementBtn}
                  disabled={linkSubmitting || !linkTitle.trim()}
                  onClick={() => void onSubmitLink()}
                >
                  {linkSubmitting ? 'Creating…' : `Create ${linkTarget === 'linear' ? 'Linear' : 'GitHub'} issue`}
                </button>
                <button
                  type="button"
                  onClick={() => setLinkOpen(false)}
                  disabled={linkSubmitting}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

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
              <span className={styles.detailFieldValue}>{ticket.topic ? topicLabel(ticket.topic) : '—'}</span>
              {ticket.root_cause && (
                <>
                  <span className={styles.detailFieldLabel}>Root cause</span>
                  <span className={styles.detailFieldValue}>{ticket.root_cause}</span>
                </>
              )}
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
            {/* Walkthrough #41: nudge operator toward Repair tab when topic
                suggests a hardware issue but category hasn't been flipped. */}
            {ticket.category !== 'repair' &&
              (ticket.topic === 'return_hardware_defect' || ticket.topic === 'warranty_replacement') && (
              <div style={{
                marginTop: 8, padding: '8px 10px', fontSize: 11,
                background: '#fffaf0', color: '#c05621', border: '1px solid #fbd38d',
                borderRadius: 4,
              }}>
                Classifier flagged this as a hardware issue. Use{' '}
                <strong>Move to → Repair</strong> below once a defect is confirmed
                to route this ticket into the Repair queue.
              </div>
            )}
          </div>
        )}

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Description</div>
          {editingDescription ? (
            <div className={styles.subjectEditRow} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
              <textarea
                className={styles.subjectEditInput}
                value={descriptionDraft}
                autoFocus
                disabled={busy}
                rows={4}
                placeholder="Add a description…"
                onChange={e => setDescriptionDraft(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button className={styles.btnPrimary} disabled={busy} onClick={() => void saveDescription()}>Save</button>
                <button
                  className={styles.btnSecondary}
                  disabled={busy}
                  onClick={() => { setDescriptionDraft(ticket.description ?? ''); setEditingDescription(false); }}
                >Cancel</button>
              </div>
            </div>
          ) : (
            <div className={styles.detailValue}>
              {ticket.description
                ? ticket.description
                : <span className={styles.muted}>No description yet</span>}
              <button
                className={styles.subjectEditBtn}
                title={ticket.description ? 'Edit description' : 'Add description'}
                onClick={() => { setDescriptionDraft(ticket.description ?? ''); setEditingDescription(true); }}
              >✎</button>
            </div>
          )}
        </div>

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
          <div
            className={styles.detailSectionLabel}
            title="Moves the ticket to a different tab. Flip to 'Repair' once a defect is confirmed; this routes the ticket to the Repair queue and exposes the Repair Details section above."
          >Move to (category)</div>
          <div className={styles.actionsRow}>
            {(['support', 'repair', 'onboarding'] as const).map(c => (
              <button
                key={c}
                className={ticket.category === c ? styles.btnPrimary : styles.btnSecondary}
                disabled={busy || ticket.category === c}
                onClick={() => run(setTicketCategory(ticket.id, c as TicketCategory))}
                title={
                  c === 'repair'
                    ? 'Confirmed hardware defect — needs disassembly / parts'
                    : c === 'onboarding'
                      ? 'Customer needs an onboarding session (Calendly)'
                      : 'General customer support inquiry'
                }
              >{CATEGORY_META[c].label}</button>
            ))}
          </div>
        </div>

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Status — transition</div>
          <div className={styles.actionsRow}>
            {(NEXT_STATUSES[ticket.status] ?? TICKET_STATUSES).map(next => (
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
          <div className={styles.detailSectionLabel}>Issue area</div>
          <select
            className={styles.select}
            value={ticket.issue_area ?? ''}
            disabled={busy}
            onChange={(e) => void run(setTicketIssueArea(ticket.id, (e.target.value || null) as IssueArea | null))}
          >
            <option value="">— Not categorized —</option>
            {ISSUE_AREAS.map(a => <option key={a} value={a}>{ISSUE_AREA_LABEL[a]}</option>)}
          </select>
        </div>

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Notes</div>
          <TicketNotes ticketId={ticket.id} />
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

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Danger zone</div>
          {confirmDelete ? (
            <div className={styles.dangerConfirm}>
              <span className={styles.dangerConfirmText}>
                Permanently delete {ticket.ticket_number}? This also removes its
                messages and attachments and cannot be undone.
              </span>
              <div className={styles.actionsRow}>
                <button
                  className={styles.btnDanger}
                  disabled={busy}
                  onClick={() => void onDelete()}
                >{busy ? 'Deleting…' : 'Yes, delete ticket'}</button>
                <button
                  className={styles.btnSecondary}
                  disabled={busy}
                  onClick={() => setConfirmDelete(false)}
                >Cancel</button>
              </div>
            </div>
          ) : (
            <div className={styles.actionsRow}>
              <button
                className={styles.btnDanger}
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >🗑 Delete ticket</button>
            </div>
          )}
        </div>

        {error && <div style={{ color: 'var(--color-error)', fontSize: 11 }}>{error}</div>}
      </div>
    </div>
  );
}

// ============================================================ SLA deadlines block
// Shown below DeviceContextHeader when a ticket has an SLA policy attached.

const SLA_DEADLINE_COLORS: Record<string, { color: string; bg: string }> = {
  green:  { color: '#276749', bg: '#f0fff4' },
  amber:  { color: '#c05621', bg: '#fffaf0' },
  red:    { color: '#c53030', bg: '#fff5f5' },
  grey:   { color: '#718096', bg: '#edf2f7' },
};

function slaDeadlineColor(dueAt: string | null, respondedAt: string | null): 'green' | 'amber' | 'red' | 'grey' {
  if (!dueAt) return 'grey';
  if (respondedAt) return 'green';
  const msRemaining = new Date(dueAt).getTime() - Date.now();
  if (msRemaining < 0) return 'red';
  if (msRemaining < 15 * 60 * 1000) return 'amber';
  return 'green';
}

function relativeDeadline(isoStr: string | null): string {
  if (!isoStr) return '—';
  const ms = new Date(isoStr).getTime() - Date.now();
  const absMin = Math.abs(ms) / 60_000;
  const past = ms < 0;
  const label = absMin < 60
    ? `${Math.round(absMin)}m`
    : absMin < 1440
      ? `${Math.round(absMin / 60)}h`
      : `${Math.round(absMin / 1440)}d`;
  return past ? `${label} ago` : `in ${label}`;
}

function SlaDeadlines({ ticket }: { ticket: ServiceTicket }) {
  const chip = slaChip(ticket);
  const chipStyle = SLA_DEADLINE_COLORS[chip.color];
  const frColor = SLA_DEADLINE_COLORS[slaDeadlineColor(ticket.first_response_due_at, ticket.first_responded_at)];
  const resColor = SLA_DEADLINE_COLORS[slaDeadlineColor(ticket.resolution_due_at, ticket.sla_resolved_at)];

  return (
    <div style={{
      display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center',
      padding: '8px 16px', borderBottom: '1px solid var(--color-border)',
      background: '#fafafa', fontSize: 12,
    }}>
      <span style={{
        fontWeight: 700, padding: '2px 8px', borderRadius: 4,
        background: chipStyle.bg, color: chipStyle.color,
      }}>SLA: {chip.label}</span>

      {ticket.first_response_due_at && (
        <span style={{ color: frColor.color }}>
          First response due:{' '}
          <strong title={new Date(ticket.first_response_due_at).toLocaleString()}>
            {new Date(ticket.first_response_due_at).toLocaleString()}
          </strong>{' '}
          <span style={{ fontStyle: 'italic' }}>({relativeDeadline(ticket.first_response_due_at)})</span>
          {ticket.first_responded_at && ' ✓'}
        </span>
      )}

      {ticket.resolution_due_at && (
        <span style={{ color: resColor.color }}>
          Resolution due:{' '}
          <strong title={new Date(ticket.resolution_due_at).toLocaleString()}>
            {new Date(ticket.resolution_due_at).toLocaleString()}
          </strong>{' '}
          <span style={{ fontStyle: 'italic' }}>({relativeDeadline(ticket.resolution_due_at)})</span>
          {ticket.sla_resolved_at && ' ✓'}
        </span>
      )}
    </div>
  );
}

// ---- TelemetryAutoBanner ----
// Shown at the top of the detail panel when ticket.source === 'telemetry_auto'.
// Extracts the state and duration from the ticket description; falls back to
// a generic banner if the description does not match the auto-generated format.

function TelemetryAutoBanner({ ticket }: { ticket: ServiceTicket }) {
  // The auto-create cron writes the description in a known format:
  // "Auto-created by telemetry monitor. Unit X has been in state STATE since ..."
  const stateMatch = ticket.description?.match(/state\s+(\S+)\s+since/);
  const classifiedState = stateMatch?.[1] ?? 'UNKNOWN';

  // Compute the hold duration from created_at (best proxy when no state_held_since
  // is stored on the ticket row itself).
  const createdMs = new Date(ticket.created_at).getTime();
  const heldHours = Math.round((Date.now() - createdMs) / 3_600_000);
  const durationStr = heldHours >= 24
    ? `${Math.floor(heldHours / 24)}d ${heldHours % 24}h`
    : `${heldHours}h`;

  const desc = ticket.description
    ? autoTicketDescription(classifiedState, ticket.created_at)
    : `Auto-created from telemetry — unit held ${classifiedState}.`;

  return (
    <div className={styles.telemetryAutoBanner}>
      <strong>Telemetry auto-created</strong>
      {' — '}unit held <strong>{classifiedState}</strong> for{' '}
      <strong>{durationStr}</strong>.
      {ticket.description && (
        <div className={styles.telemetryAutoBannerDetail}>
          {desc}
        </div>
      )}
    </div>
  );
}
