import { useState } from 'react';
import {
  createDatasetLabel,
  type DatasetLabelKind,
  type DatasetLabelSource,
  type DatasetLabelConfidence,
} from '../../lib/dashboard';
import styles from './Dashboard.module.css';

type Props = {
  serialNumber: string;
  onClose: () => void;
  onSaved: () => void;
};

const LABELS: { value: DatasetLabelKind; description: string }[] = [
  { value: 'smelly',     description: 'Customer reports compost smells (paired with bme_sensors.gas_resistivity for ML)' },
  { value: 'no_smell',   description: 'Customer confirms no smell' },
  { value: 'dry',        description: 'Compost is dry (paired with bme_sensors.humidity)' },
  { value: 'wet',        description: 'Compost is too wet' },
  { value: 'mixing',     description: 'Mixing/turnover is working' },
  { value: 'not_mixing',       description: 'Mixing appears stuck' },
  { value: 'moldy_composter', description: 'Mold visible inside the composter body' },
  { value: 'moldy_chamber',   description: 'Mold visible inside the mixing chamber' },
  { value: 'other',           description: 'Other (capture context in notes)' },
];

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function LabelWindowModal({ serialNumber, onClose, onSaved }: Props) {
  // Default the window to the last 24h ending now. Operator can adjust.
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 3600_000);
  const [startedAt, setStartedAt] = useState(toLocalInput(dayAgo));
  const [endedAt, setEndedAt] = useState(toLocalInput(now));
  const [label, setLabel] = useState<DatasetLabelKind>('smelly');
  const [source, setSource] = useState<DatasetLabelSource>('sms');
  const [confidence, setConfidence] = useState<DatasetLabelConfidence>('customer_reported');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true); setError(null);
    try {
      await createDatasetLabel({
        serial_number: serialNumber,
        started_at: new Date(startedAt).toISOString(),
        ended_at:   new Date(endedAt).toISOString(),
        label,
        source,
        confidence,
        notes: notes.trim() || null,
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
        <header className={styles.modalHeader}>
          <h3>Label telemetry window — {serialNumber}</h3>
          <button className={styles.modalClose} onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className={styles.labelFormRow}>
          <label>From</label>
          <input type="datetime-local" value={startedAt} onChange={e => setStartedAt(e.target.value)} />
        </div>
        <div className={styles.labelFormRow}>
          <label>To</label>
          <input type="datetime-local" value={endedAt} onChange={e => setEndedAt(e.target.value)} />
        </div>

        <div className={styles.labelFormRow}>
          <label>Label</label>
          <select value={label} onChange={e => setLabel(e.target.value as DatasetLabelKind)}>
            {LABELS.map(l => <option key={l.value} value={l.value}>{l.value}</option>)}
          </select>
        </div>
        <p className={styles.labelHelp}>{LABELS.find(l => l.value === label)?.description}</p>

        <div className={styles.labelFormRow}>
          <label>Source</label>
          <select value={source} onChange={e => setSource(e.target.value as DatasetLabelSource)}>
            <option value="sms">SMS (Quo / OpenPhone)</option>
            <option value="phone">Phone call</option>
            <option value="ticket">Support ticket</option>
            <option value="in_person">In-person</option>
            <option value="operator_inferred">Operator inferred (no customer report)</option>
          </select>
        </div>

        <div className={styles.labelFormRow}>
          <label>Confidence</label>
          <select value={confidence} onChange={e => setConfidence(e.target.value as DatasetLabelConfidence)}>
            <option value="customer_reported">Customer reported (high)</option>
            <option value="operator_inferred">Operator inferred (low)</option>
          </select>
        </div>

        <div className={styles.labelFormRow}>
          <label>Notes</label>
          <textarea
            rows={3}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Optional context — e.g. ticket #, what the customer said verbatim"
          />
        </div>

        {error && <p className={styles.error}>{error}</p>}

        <footer className={styles.modalFooter}>
          <button className={styles.modalCancel} onClick={onClose} disabled={busy}>Cancel</button>
          <button className={styles.modalConfirm} onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save label'}
          </button>
        </footer>
      </div>
    </div>
  );
}
