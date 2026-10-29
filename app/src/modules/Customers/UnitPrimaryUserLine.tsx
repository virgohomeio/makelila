import { useState } from 'react';
import {
  setUnitPrimaryUser, clearUnitPrimaryUser,
  type UnitPrimaryUser, type AdditionalUserInput,
} from '../../lib/customers';
import { UserForm } from './AdditionalUsersSection';
import styles from './Customers.module.css';

// The primary user of ONE machine, shown under its row in "Shipped units".
// A purchaser who bought several machines for different people (one for
// themselves, others shipped to family or colleagues) records each machine's
// user here. Without a per-machine row, the machine falls back to the
// customer-level "Primary user of the machine" — or the purchaser themselves —
// shown greyed as the default.

export function UnitPrimaryUserLine({ serial, customerId, row, fallbackName, onChanged }: {
  serial: string;
  customerId: string;
  row: UnitPrimaryUser | undefined;
  /** Who uses this machine when no per-machine user is recorded. */
  fallbackName: string;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); setEditing(false); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (editing) {
    const initial: AdditionalUserInput = {
      full_name: row?.full_name ?? '',
      phone: row?.phone ?? '',
      email: row?.email ?? '',
      relationship: row?.relationship ?? '',
    };
    return (
      <div className={styles.unitPrimaryUser}>
        <UserForm
          initial={initial}
          busy={busy}
          submitLabel="Save"
          who={`Primary user of ${serial}`}
          onSubmit={input => void run(() => setUnitPrimaryUser(serial, customerId, input))}
          onCancel={() => { setEditing(false); setErr(null); }}
        />
        {err && <div className={styles.toastError} style={{ marginTop: 6 }}>{err}</div>}
      </div>
    );
  }

  const contact = row ? [row.phone, row.email].filter(Boolean).join(' · ') : '';
  return (
    <div className={styles.unitPrimaryUser}>
      Primary user:{' '}
      {row ? (
        <>
          <span className={styles.unitPrimaryUserName}>{row.full_name}</span>
          {row.relationship && <span> · {row.relationship}</span>}
          {contact && <span> · {contact}</span>}
        </>
      ) : (
        <span title="No primary user recorded for this machine — showing the customer's default.">
          {fallbackName} (default)
        </span>
      )}
      <span className={styles.unitPrimaryUserActions}>
        <button className={styles.linkBtn} disabled={busy}
          onClick={() => { setEditing(true); setErr(null); }}>
          {row ? 'Edit' : 'Set'}
        </button>
        {row && (
          <button className={styles.linkBtn} disabled={busy}
            onClick={() => void run(() => clearUnitPrimaryUser(serial, customerId))}>
            Clear
          </button>
        )}
      </span>
      {err && <div className={styles.toastError} style={{ marginTop: 6 }}>{err}</div>}
    </div>
  );
}
