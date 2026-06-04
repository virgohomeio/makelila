import { useEffect, useState } from 'react';
import {
  STATUS_SMS_KIND,
  STATUS_SMS_TEMPLATES,
  customerForSerial,
  lastStatusSmsAt,
  type MachineStatus,
} from '../../lib/dashboard';
import { sendFollowupSms } from '../../lib/customers';
import { logAction } from '../../lib/activityLog';
import styles from './Dashboard.module.css';

type Props = {
  serialNumber: string;
  status: MachineStatus;
  onClose: () => void;
};

type Loaded = {
  customer: { id: string; full_name: string; first_name: string | null; phone: string | null } | null;
  cooldownUntil: Date | null;
};

export default function StatusSmsModal({ serialNumber, status, onClose }: Props) {
  const kind = STATUS_SMS_KIND[status];
  const template = kind ? STATUS_SMS_TEMPLATES[kind] : null;

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentResult, setSentResult] = useState<{ duplicate?: boolean; test_redirected?: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [customer, cooldown] = await Promise.all([
          customerForSerial(serialNumber),
          lastStatusSmsAt(serialNumber, status),
        ]);
        if (cancelled) return;
        setLoaded({ customer, cooldownUntil: cooldown });
        if (customer && template) {
          const firstName = customer.first_name?.trim() || customer.full_name.split(/\s+/)[0] || 'there';
          setMessage(template.body(firstName));
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [serialNumber, status, template]);

  async function send() {
    if (!loaded?.customer) return;
    setBusy(true); setError(null);
    try {
      const result = await sendFollowupSms({ customer_id: loaded.customer.id, message });
      // Even if the followup-sms function returned duplicate=true, log a
      // dashboard_status_sms entry so the cooldown picks it up next time.
      await logAction(
        'dashboard_status_sms',
        serialNumber,
        `${status}: ${message.slice(0, 80)}${message.length > 80 ? '…' : ''}`,
      );
      setSentResult(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!template) {
    // Defensive — caller shouldn't open the modal for non-actionable statuses.
    return null;
  }

  const cooldownActive = loaded?.cooldownUntil != null;
  const noCustomer = loaded != null && loaded.customer == null;
  const noPhone = loaded?.customer != null && !loaded.customer.phone;

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
        <header className={styles.modalHeader}>
          <h3>{template.label} — {serialNumber}</h3>
          <button className={styles.modalClose} onClick={onClose} aria-label="Close">×</button>
        </header>

        {sentResult ? (
          <div className={styles.statusSmsResult}>
            <p>✓ Message sent{sentResult.test_redirected ? ' (test redirect)' : ''}{sentResult.duplicate ? ' (duplicate — original send already on record)' : ''}.</p>
            <button className={styles.modalConfirm} onClick={onClose}>Close</button>
          </div>
        ) : !loaded ? (
          <p className={styles.muted}>Loading customer…</p>
        ) : noCustomer ? (
          <p className={styles.error}>No customer is linked to this unit (or it's flagged as a team test unit). Assign a customer first to send.</p>
        ) : noPhone ? (
          <p className={styles.error}>{loaded.customer!.full_name} has no phone number on file. Add one in the Customers module before sending.</p>
        ) : cooldownActive ? (
          <div>
            <p className={styles.statusSmsCooldown}>
              Already messaged about <strong>{status}</strong> at {loaded.cooldownUntil!.toLocaleString('en-US')}. Cooldown is 48h to prevent flicker-spam.
            </p>
            <p className={styles.muted}>You can still send by editing + confirming, but consider following up via Quo thread instead.</p>
            <textarea
              className={styles.statusSmsTextarea}
              rows={6}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            {error && <p className={styles.error}>{error}</p>}
            <footer className={styles.modalFooter}>
              <button className={styles.modalCancel} onClick={onClose} disabled={busy}>Cancel</button>
              <button className={styles.modalConfirm} onClick={send} disabled={busy || message.trim() === ''}>
                {busy ? 'Sending…' : 'Send anyway'}
              </button>
            </footer>
          </div>
        ) : (
          <div>
            <p className={styles.statusSmsTo}>
              To: <strong>{loaded.customer!.full_name}</strong>{' '}
              <span className={styles.muted}>· {loaded.customer!.phone}</span>
            </p>
            <textarea
              className={styles.statusSmsTextarea}
              rows={6}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            {error && <p className={styles.error}>{error}</p>}
            <footer className={styles.modalFooter}>
              <button className={styles.modalCancel} onClick={onClose} disabled={busy}>Cancel</button>
              <button className={styles.modalConfirm} onClick={send} disabled={busy || message.trim() === ''}>
                {busy ? 'Sending…' : 'Send SMS'}
              </button>
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}
