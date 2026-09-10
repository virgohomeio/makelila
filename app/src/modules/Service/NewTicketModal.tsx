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
import styles from './Service.module.css';

/** The "New support ticket" dialog. Lived inside SupportTab until the ticket
 *  panel needed it too — a replacement that arrives damaged is a new case, and
 *  the operator raising it is standing on the old ticket, not on the Support
 *  list. Kept in its own file rather than exported from SupportTab because
 *  SupportTab already imports TicketDetailPanel, and importing back the other
 *  way would close the cycle. */

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
  const [subject, setSubject] = useState(presetSubject ?? '');
  const [description, setDescription] = useState(presetDescription ?? '');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [customerSearch, setCustomerSearch] = useState('');
  // Pre-seed the customer when opened from a profile's "+ Add ticket".
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(presetCustomer ?? null);
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

  const canSubmit = subject.trim().length > 0 && selectedCustomer !== null && !submitting;

  const submit = async () => {
    if (!selectedCustomer) return;
    setSubmitting(true);
    setError(null);
    try {
      const row = await createTicket({
        category: 'support',
        subject: subject.trim(),
        description: description.trim() || null,
        priority,
        customer_id: selectedCustomer.id,
        customer_name: selectedCustomer.full_name,
        customer_email: selectedCustomer.email,
        customer_phone: selectedCustomer.phone,
        unit_serial: unitSerial.trim() || null,
      });
      onCreated(row);
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
            <label>Customer *</label>
            {selectedCustomer ? (
              <div className={styles.modalSelected}>
                <strong>{selectedCustomer.full_name}</strong>
                <span className={styles.muted}>
                  {[selectedCustomer.email, selectedCustomer.phone, selectedCustomer.city]
                    .filter(Boolean).join(' · ') || '—'}
                </span>
                <button
                  className={styles.modalLinkBtn}
                  onClick={() => { setSelectedCustomer(null); setCustomerSearch(''); }}
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
                {candidates.length > 0 && (
                  <div className={styles.modalDropdown}>
                    {candidates.map(c => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setSelectedCustomer(c)}
                        className={styles.modalDropItem}
                      >
                        <strong>{c.full_name}</strong>
                        <span className={styles.muted}>
                          {[c.email, c.phone].filter(Boolean).join(' · ') || '—'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {customerSearch.trim() && candidates.length === 0 && (
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
              <label>Unit serial</label>
              <input
                type="text"
                className={styles.modalInput}
                value={unitSerial}
                onChange={e => { setUnitSerial(e.target.value); setSerialAutoFilled(false); }}
                placeholder="LL01-… (optional)"
              />
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
