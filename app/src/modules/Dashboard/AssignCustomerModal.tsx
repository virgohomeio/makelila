import { useEffect, useMemo, useState } from 'react';
import { useCustomers, type Customer } from '../../lib/customers';
import { assignCustomerToSerial } from '../../lib/dashboard';
import styles from './Dashboard.module.css';

interface Props {
  serialNumber: string;
  /** Optional hint string from the telemetry layer (e.g. `lila.user`) used
   *  to pre-rank the suggested customer. */
  telemetryHint?: string | null;
  onClose: () => void;
  onAssigned: () => void;
}

export default function AssignCustomerModal({
  serialNumber,
  telemetryHint,
  onClose,
  onAssigned,
}: Props) {
  const { customers, loading } = useCustomers();
  const [query, setQuery] = useState(telemetryHint?.trim() ?? '');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ranked = useMemo(() => rankCustomers(customers, query, telemetryHint), [customers, query, telemetryHint]);

  useEffect(() => {
    if (ranked.length && selectedId == null) setSelectedId(ranked[0].id);
  }, [ranked, selectedId]);

  const selected = ranked.find((c) => c.id === selectedId) ?? null;

  const handleConfirm = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      await assignCustomerToSerial(serialNumber, selected.full_name);
      onAssigned();
    } catch (e) {
      setError((e as Error)?.message ?? 'Assignment failed.');
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
        <header className={styles.modalHeader}>
          <h3>Assign customer to {serialNumber}</h3>
          <button className={styles.modalClose} onClick={onClose} aria-label="Close">×</button>
        </header>

        <input
          className={styles.modalSearch}
          autoFocus
          placeholder="Search customers by name…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelectedId(null); }}
        />

        {loading ? (
          <p className={styles.muted}>Loading customers…</p>
        ) : ranked.length === 0 ? (
          <p className={styles.muted}>No matching customers.</p>
        ) : (
          <ul className={styles.modalList}>
            {ranked.slice(0, 20).map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={`${styles.modalListRow} ${selectedId === c.id ? styles.modalListRowActive : ''}`}
                  onClick={() => setSelectedId(c.id)}
                >
                  <span className={styles.modalListName}>{c.full_name}</span>
                  <span className={styles.modalListMeta}>{c.email ?? c.phone ?? ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && <p className={styles.error}>{error}</p>}

        <footer className={styles.modalFooter}>
          <button className={styles.modalCancel} onClick={onClose} disabled={submitting}>Cancel</button>
          <button
            className={styles.modalConfirm}
            onClick={handleConfirm}
            disabled={!selected || submitting}
          >
            {submitting ? 'Assigning…' : selected ? `Assign to ${selected.full_name}` : 'Pick a customer'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Rank customers by (a) match against the explicit query, then (b) match
 *  against the telemetry hint string if the query is empty. Customers with
 *  no `serials` yet float above ones already linked, since they're more
 *  likely to be the missing assignment. */
function rankCustomers(customers: Customer[], query: string, hint: string | null | undefined): Customer[] {
  const q = query.trim().toLowerCase();
  const h = (hint ?? '').trim().toLowerCase();
  const needle = q || h;
  if (!needle) {
    return [...customers].sort((a, b) => {
      const ua = (a.serials?.length ?? 0) === 0 ? 0 : 1;
      const ub = (b.serials?.length ?? 0) === 0 ? 0 : 1;
      if (ua !== ub) return ua - ub;
      return a.full_name.localeCompare(b.full_name);
    });
  }
  const scored: Array<{ c: Customer; score: number }> = [];
  for (const c of customers) {
    const name = c.full_name.toLowerCase();
    let score = 0;
    if (name === needle) score = 1000;
    else if (name.startsWith(needle)) score = 500;
    else if (name.includes(needle)) score = 100;
    else {
      const parts = needle.split(/\s+/).filter(Boolean);
      const matched = parts.filter((p) => name.includes(p)).length;
      score = matched * 10;
    }
    if (score > 0) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score || a.c.full_name.localeCompare(b.c.full_name));
  return scored.map((s) => s.c);
}
