import { statusMeta, topicLabel, sourceLabel, type ServiceTicket } from '../../lib/service';
import type { Customer } from '../../lib/customers';
import { DeviceContextHeader } from '../../components/DeviceContextHeader';
import type { CustomerGroup } from './ticketGrouping';
import styles from './Service.module.css';

// The per-customer "ticket profile": device context up top, then every ticket
// this customer has, each opening the full TicketDetailPanel. "+ Add ticket"
// creates another ticket under the same profile (tickets are never merged
// destructively — the profile just collects them).
export function CustomerProfilePanel({
  group, customer, onClose, onOpenTicket, onAddTicket,
}: {
  group: CustomerGroup;
  customer: Customer | undefined;
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
          <h3 className={styles.detailSubject}>{group.customerName}</h3>
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
        <DeviceContextHeader unitSerial={group.unitSerial} />

        <div className={styles.profileTicketsHead}>
          <span className={styles.detailSectionLabel}>Tickets</span>
          <button className={styles.profileAddBtn} onClick={onAddTicket}>+ Add ticket</button>
        </div>

        <div className={styles.profileTicketList}>
          {group.tickets.map(t => {
            const s = statusMeta(t.status);
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
                <span className={styles.pill} style={{ background: s.bg, color: s.color }}>{s.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
