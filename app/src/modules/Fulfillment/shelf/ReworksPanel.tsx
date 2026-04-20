import { useState } from 'react';
import { useOpenReworks, resolveRework, type UnitRework } from '../../../lib/fulfillment';
import { useAuth } from '../../../lib/auth';
import styles from '../Fulfillment.module.css';

function ReworkCard({ rw, resolverName }: { rw: UnitRework; resolverName: string }) {
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolve = async () => {
    setBusy(true); setError(null);
    try { await resolveRework(rw.id, rw.serial, notes || undefined, resolverName); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className={styles.reworkCard}>
      <div className={styles.reworkMeta}>
        <strong style={{ fontFamily: 'ui-monospace, monospace' }}>{rw.serial}</strong>
        {' · flagged by '}{rw.flagged_by_name}
        {' · '}{new Date(rw.flagged_at).toLocaleString('en-US')}
      </div>
      <div className={styles.reworkBody}>{rw.issue}</div>
      <div className={styles.reworkRow}>
        <input
          type="text"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Resolution notes (optional)"
          style={{
            flex: 1, padding: '5px 8px', border: '1px solid var(--color-border)',
            borderRadius: 3, fontSize: 10,
          }}
        />
        <button
          onClick={resolve}
          disabled={busy}
          style={{
            background: 'var(--color-success)', color: '#fff', border: 'none',
            padding: '5px 12px', borderRadius: 3, fontSize: 10, fontWeight: 700,
            cursor: busy ? 'not-allowed' : 'pointer',
          }}
        >{busy ? 'Resolving…' : 'Mark resolved'}</button>
      </div>
      {error && <div style={{ color: 'var(--color-error)', fontSize: 10, marginTop: 4 }}>{error}</div>}
    </div>
  );
}

export function ReworksPanel() {
  const { reworks, loading } = useOpenReworks();
  const { profile, user } = useAuth();
  const resolverName = profile?.display_name ?? user?.email ?? 'Unknown';

  if (loading) return null;
  return (
    <div className={styles.reworksPanel}>
      <div className={styles.reworksTitle}>
        {reworks.length === 0 ? 'No units pending rework.' : `Pending reworks (${reworks.length})`}
      </div>
      {reworks.map(rw => <ReworkCard key={rw.id} rw={rw} resolverName={resolverName} />)}
    </div>
  );
}
