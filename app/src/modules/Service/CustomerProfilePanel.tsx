import { statusMeta, topicLabel, sourceLabel, ticketStatusSet, type ServiceTicket } from '../../lib/service';
import type { Customer, CustomerParties } from '../../lib/customers';
import { CustomerPartyName } from '../../components/CustomerPartyName';
import type { CustomerGroup } from './ticketGrouping';
import styles from './Service.module.css';

// The per-customer "ticket profile": every ticket
// this customer has, each opening the full TicketDetailPanel. "+ Add ticket"
// creates another ticket under the same profile (tickets are never merged
// destructively — the profile just collects them).
export function CustomerProfilePanel({
  group, customer, parties, onClose, onOpenTicket, onAddTicket,
}: {
  group: CustomerGroup;
  customer: Customer | undefined;
  /** FR-6 purchaser / primary-user pair, resolved by the caller against the
   *  directory. Absent only in bare renders — fall back to the group name. */
  parties?: CustomerParties;
  onClose: () => void;
  onOpenTicket: (ticket: ServiceTicket) => void;
  onAddTicket: () => void;
}) {
  const contact = [
    customer?.email ?? group.customerEmail,
    customer?.phone ?? group.customerPhone,
    customer?.city,
  ].filter(Boolean).join(' · ') || '—';

  return (
    <div className={styles.detailOverlay}>
      <div className={styles.detailHead}>
        <div>
          <h3 className={styles.detailSubject}>
            {parties
              ? <CustomerPartyName parties={parties} />
              : group.customerName}
          </h3>
          <div className={styles.profileContact}>{contact}</div>
          <div className={styles.detailMetaRow}>
            <span className={styles.pill} style={{ background: '#edf2f7', color: '#4a5568' }}>
              {group.total} ticket{group.total === 1 ? '' : 's'}
            </span>
            <span className={styles.pill} style={{ background: '#f0fff4', color: '#276749' }}>
              {group.openCount} open
            </span>
          </div>
        </div>
        <button className={styles.detailClose} onClick={onClose}>✕</button>
      </div>

      <div className={styles.detailBody}>
        <div className={styles.profileTicketsHead}>
          <span className={styles.detailSectionLabel}>Tickets</span>
          <button className={styles.profileAddBtn} onClick={onAddTicket}>+ Add ticket</button>
        </div>

        <div className={styles.profileTicketList}>
          {group.tickets.map(t => {
            const ts = t.last_message_at ?? t.created_at;
            return (
              <button key={t.id} className={styles.profileTicketRow} onClick={() => onOpenTicket(t)}>
                <span className={styles.profileTicketNum}>{t.ticket_number}</span>
                <span className={styles.profileTicketSubject}>
                  {t.subject}
                  {t.topic && <span className={styles.profileTicketTopic}>{topicLabel(t.topic)}</span>}
                </span>
                <span className={styles.profileTicketMeta}>
                  {sourceLabel(t.source)} · {new Date(ts).toLocaleDateString()}
                </span>
                <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end' }}>
                  {/* Statuses are multi-select — render the whole set in one
                      uniform pill style. Rendering `status` and `tags` as two
                      separate lists double-printed the primary, which is stored
                      in both. */}
                  {ticketStatusSet(t).map(v => {
                    const m = statusMeta(v);
                    return (
                      <span key={v} className={styles.pill} style={{ background: m.bg, color: m.color }}>
                        {m.label}
                      </span>
                    );
                  })}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
