import { useEffect, useMemo, useState } from 'react';
import {
  createTicket,
  type TicketPriority, type ServiceTicket,
} from '../../lib/service';
import {
  syncCustomersFromHubspot,
  type Customer,
} from '../../lib/customers';
import { useUnits } from '../../lib/stock';
import {
  useTeamRoster, matchTeamMembers, teamUnits, holderMatchesMember, setTeamUnitHolder,
  type TeamMember,
} from '../../lib/team';
import styles from './Service.module.css';

/** The "New support ticket" dialog. Lived inside SupportTab until the ticket
 *  panel needed it too — a replacement that arrives damaged is a new case, and
 *  the operator raising it is standing on the old ticket, not on the Support
 *  list. Kept in its own file rather than exported from SupportTab because
 *  SupportTab already imports TicketDetailPanel, and importing back the other
 *  way would close the cycle.
 *
 *  The subject can be a CUSTOMER or a TEAM MEMBER. It used to be a customer
 *  only, so ticketing a colleague's LILA Pro meant giving them a customer
 *  record — which is how Huayi Gao, Pedrum Amin, George Yin and Support LILA
 *  ended up in public.customers, counted as customers by every rollup and
 *  export. A team subject writes no customer_id and no Klaviyo event.
 *  Spec: docs/superpowers/specs/2026-09-24-team-member-support-tickets-design.md */

/** Who the ticket is about. */
type Subject =
  | { kind: 'customer'; customer: Customer }
  | { kind: 'team'; member: TeamMember };

export function NewTicketModal({
  customers, presetCustomer, presetSubject, presetDescription, presetUnitSerial,
  title = 'New support ticket', onClose, onCreated,
}: {
  customers: Customer[];
  presetCustomer?: Customer | null;
  /** Seeded from the case the operator is standing on (e.g. a damaged
   *  replacement), still fully editable before Create. */
  presetSubject?: string;
  presetDescription?: string;
  presetUnitSerial?: string;
  title?: string;
  onClose: () => void;
  onCreated: (t: ServiceTicket) => void;
}) {
  const { units } = useUnits();
  const { members } = useTeamRoster();
  const [subject, setSubject] = useState(presetSubject ?? '');
  const [description, setDescription] = useState(presetDescription ?? '');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [customerSearch, setCustomerSearch] = useState('');
  // Pre-seed the customer when opened from a profile's "+ Add ticket".
  const [picked, setPicked] = useState<Subject | null>(
    presetCustomer ? { kind: 'customer', customer: presetCustomer } : null,
  );
  const selectedCustomer = picked?.kind === 'customer' ? picked.customer : null;
  const selectedMember = picked?.kind === 'team' ? picked.member : null;
  const [resyncing, setResyncing] = useState(false);
  const [resyncMsg, setResyncMsg] = useState<string | null>(null);

  // Walkthrough #34: when no candidates match the search, operators
  // suspected the HubSpot sync was stale. Inline this re-sync so they
  // can recover mid-call instead of switching tabs.
  async function handleResync() {
    setResyncing(true); setResyncMsg(null);
    try {
      const r = await syncCustomersFromHubspot();
      setResyncMsg(`Synced ${r.upserted} new customer${r.upserted === 1 ? '' : 's'} from HubSpot. Try the search again.`);
    } catch (e) {
      setResyncMsg(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setResyncing(false);
    }
  }
  const [unitSerial, setUnitSerial] = useState(presetUnitSerial ?? '');
  const [serialAutoFilled, setSerialAutoFilled] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-populate the unit serial when a customer is picked (walkthrough #36).
  // Match on lowercased customer_name; if the customer has multiple shipped
  // units we pick the most-recent and tag the field with a hint. We only
  // overwrite the serial when (a) the field is empty, or (b) it was
  // previously auto-filled — never when the operator has typed manually.
  useEffect(() => {
    if (!selectedCustomer) return;
    if (unitSerial && !serialAutoFilled) return;
    const lcName = selectedCustomer.full_name.toLowerCase();
    const matches = units
      .filter(u => u.customer_name?.toLowerCase() === lcName)
      .sort((a, b) => (b.shipped_at ?? '').localeCompare(a.shipped_at ?? ''));
    if (matches.length === 0) return;
    setUnitSerial(matches[0].serial);
    setSerialAutoFilled(true);
  }, [selectedCustomer, units, unitSerial, serialAutoFilled]);

  // The team's machines, and which of them are this member's. Twelve of the
  // fifteen record no holder at all, so the picker offers a member's own units
  // first and then the unclaimed ones — picking an unclaimed one records them
  // as the holder, so the next ticket auto-fills. A customer's unit is never
  // in this list.
  const allTeamUnits = useMemo(() => teamUnits(units), [units]);
  const memberUnits = useMemo(
    () => (selectedMember ? allTeamUnits.filter(u => holderMatchesMember(u, selectedMember)) : []),
    [allTeamUnits, selectedMember],
  );
  const unclaimedTeamUnits = useMemo(
    () => allTeamUnits.filter(u => !(u.customer_name ?? '').trim()),
    [allTeamUnits],
  );

  // Auto-fill a team member's serial the same way the customer path does, but
  // only when exactly one unit already names them — with two, picking is the
  // operator's call.
  useEffect(() => {
    if (!selectedMember) return;
    if (unitSerial && !serialAutoFilled) return;
    if (memberUnits.length !== 1) return;
    setUnitSerial(memberUnits[0].serial);
    setSerialAutoFilled(true);
  }, [selectedMember, memberUnits, unitSerial, serialAutoFilled]);

  const matchedUnitCount = useMemo(() => {
    if (!selectedCustomer) return 0;
    const lcName = selectedCustomer.full_name.toLowerCase();
    return units.filter(u => u.customer_name?.toLowerCase() === lcName).length;
  }, [selectedCustomer, units]);

  const candidates = useMemo(() => {
    const needle = customerSearch.trim().toLowerCase();
    if (!needle) return [];
    return customers.filter(c =>
      c.full_name.toLowerCase().includes(needle) ||
      (c.email ?? '').toLowerCase().includes(needle) ||
      (c.phone ?? '').toLowerCase().includes(needle),
    ).slice(0, 8);
  }, [customers, customerSearch]);

  const teamCandidates = useMemo(
    () => matchTeamMembers(members, customerSearch).slice(0, 8),
    [members, customerSearch],
  );

  const canSubmit = subject.trim().length > 0 && picked !== null && !submitting;

  const submit = async () => {
    if (!picked) return;
    setSubmitting(true);
    setError(null);
    const serial = unitSerial.trim() || null;
    try {
      if (picked.kind === 'team') {
        const member = picked.member;
        // Remember whose machine this is before the ticket is written, so a
        // unit that was anonymous stops being anonymous even if the operator
        // never comes back to this dialog.
        const unit = serial ? allTeamUnits.find(u => u.serial === serial) : undefined;
        if (unit && !holderMatchesMember(unit, member)) {
          await setTeamUnitHolder(serial as string, member.display_name);
        }
        onCreated(await createTicket({
          category: 'support',
          subject: subject.trim(),
          description: description.trim() || null,
          priority,
          // No customer record, by design: a colleague must not be counted as
          // a customer. The roster address is what identifies them.
          customer_id: null,
          customer_name: member.display_name,
          customer_email: member.email,
          customer_phone: null,
          unit_serial: serial,
          is_team: true,
        }));
        return;
      }

      const customer = picked.customer;
      onCreated(await createTicket({
        category: 'support',
        subject: subject.trim(),
        description: description.trim() || null,
        priority,
        customer_id: customer.id,
        customer_name: customer.full_name,
        customer_email: customer.email,
        customer_phone: customer.phone,
        unit_serial: serial,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create ticket');
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <strong>{title}</strong>
          <button onClick={onClose} className={styles.modalClose}>✕</button>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.modalRow}>
            <label>Subject *</label>
            <input
              type="text"
              className={styles.modalInput}
              value={subject}
              onChange={e => setSubject(e.target.value)}
              placeholder="Short summary of the issue"
              autoFocus
            />
          </div>
          <div className={styles.modalRow}>
            <label>Subject *</label>
            {picked ? (
              <div className={styles.modalSelected}>
                <strong>
                  {selectedMember ? selectedMember.display_name : selectedCustomer?.full_name}
                </strong>
                <span className={styles.muted}>
                  {selectedMember
                    ? `team · ${selectedMember.email}`
                    : [selectedCustomer?.email, selectedCustomer?.phone, selectedCustomer?.city]
                        .filter(Boolean).join(' · ') || '—'}
                </span>
                <button
                  className={styles.modalLinkBtn}
                  onClick={() => {
                    setPicked(null);
                    setCustomerSearch('');
                    // The serial belonged to whoever was selected; keeping it
                    // would file the next subject's ticket against their machine.
                    if (serialAutoFilled) { setUnitSerial(''); setSerialAutoFilled(false); }
                  }}
                >change</button>
              </div>
            ) : (
              <div className={styles.modalPicker}>
                <input
                  type="text"
                  className={styles.modalInput}
                  value={customerSearch}
                  onChange={e => setCustomerSearch(e.target.value)}
                  placeholder="Type a name, email, or phone…"
                />
                {(candidates.length > 0 || teamCandidates.length > 0) && (
                  <div className={styles.modalDropdown}>
                    {candidates.map(c => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setPicked({ kind: 'customer', customer: c })}
                        className={styles.modalDropItem}
                      >
                        <strong>{c.full_name}</strong>
                        <span className={styles.muted}>
                          {[c.email, c.phone].filter(Boolean).join(' · ') || '—'}
                        </span>
                      </button>
                    ))}
                    {teamCandidates.map(m => (
                      <button
                        key={m.email}
                        type="button"
                        onClick={() => setPicked({ kind: 'team', member: m })}
                        className={styles.modalDropItem}
                      >
                        <strong>{m.display_name}</strong>
                        <span className={styles.muted}>team · {m.email}</span>
                      </button>
                    ))}
                  </div>
                )}
                {customerSearch.trim() && candidates.length === 0 && teamCandidates.length === 0 && (
                  <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span className={styles.muted} style={{ fontSize: 11 }}>
                      No matching customer. If you just received their message, the HubSpot sync may be a few minutes behind.
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleResync()}
                      disabled={resyncing}
                      className={styles.modalSecondary}
                      style={{ alignSelf: 'flex-start' }}
                    >{resyncing ? 'Re-syncing…' : 'Re-sync from HubSpot'}</button>
                    {resyncMsg && (
                      <span className={styles.muted} style={{ fontSize: 11 }}>{resyncMsg}</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className={styles.modalRow}>
            <label>Description</label>
            <textarea
              className={styles.modalTextarea}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What happened? Steps the customer took, error messages, etc."
              rows={3}
            />
          </div>
          <div className={styles.modalGrid}>
            <div className={styles.modalRow}>
              <label>Priority</label>
              <select
                className={styles.modalSelect}
                value={priority}
                onChange={e => setPriority(e.target.value as TicketPriority)}
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div className={styles.modalRow}>
              <label htmlFor="new-ticket-serial">Unit serial</label>
              {selectedMember ? (
                <select
                  id="new-ticket-serial"
                  className={styles.modalSelect}
                  value={unitSerial}
                  onChange={e => { setUnitSerial(e.target.value); setSerialAutoFilled(false); }}
                >
                  <option value="">— none —</option>
                  {memberUnits.map(u => (
                    <option key={u.serial} value={u.serial}>
                      {u.serial} · {u.batch}
                    </option>
                  ))}
                  {unclaimedTeamUnits.map(u => (
                    <option key={u.serial} value={u.serial}>
                      {u.serial} · {u.batch} · no holder on file
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="new-ticket-serial"
                  type="text"
                  className={styles.modalInput}
                  value={unitSerial}
                  onChange={e => { setUnitSerial(e.target.value); setSerialAutoFilled(false); }}
                  placeholder="LL01-… (optional)"
                />
              )}
              {selectedMember && unitSerial
                && !memberUnits.some(u => u.serial === unitSerial) && (
                <span className={styles.muted} style={{ fontSize: 10, marginTop: 2 }}>
                  No holder is recorded for this machine — creating the ticket
                  files it to {selectedMember.display_name}.
                </span>
              )}
              {serialAutoFilled && matchedUnitCount > 0 && (
                <span className={styles.muted} style={{ fontSize: 10, marginTop: 2 }}>
                  Auto-filled from {selectedCustomer?.full_name}'s {matchedUnitCount === 1 ? 'shipped unit' : `most recent of ${matchedUnitCount} shipped units`} — edit to override.
                </span>
              )}
            </div>
          </div>
          {error && <div className={styles.modalError}>{error}</div>}
        </div>
        <div className={styles.modalFoot}>
          <button onClick={onClose} className={styles.modalSecondary}>Cancel</button>
          <button
            onClick={() => void submit()}
            className={styles.modalPrimary}
            disabled={!canSubmit}
          >
            {submitting ? 'Creating…' : 'Create ticket'}
          </button>
        </div>
      </div>
    </div>
  );
}
