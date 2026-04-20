import { logAction, useActivityLog } from '../lib/activityLog';
import { useAuth } from '../lib/auth';

export default function ActivityLog() {
  const { entries, loading } = useActivityLog(50);
  const { profile } = useAuth();

  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 14,
      }}>
        <h1 style={{ fontSize: 18, fontWeight: 800, color: 'var(--color-crimson)' }}>
          Activity Log
        </h1>
        <button
          onClick={() => void logAction(
            'infra_ping',
            'Infra ping',
            `Ping from ${profile?.display_name ?? 'unknown'}`,
          )}
          style={{
            background: 'var(--color-crimson)', color: '#fff', border: 'none',
            padding: '6px 14px', borderRadius: 5, fontSize: 11, fontWeight: 700,
          }}
        >Fire test ping</button>
      </div>

      {loading ? (
        <div style={{ fontSize: 11, color: 'var(--color-ink-subtle)' }}>Loading…</div>
      ) : (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 0,
          border: '1px solid var(--color-border)', borderRadius: 6,
        }}>
          {entries.map(e => (
            <div key={e.id} style={{
              padding: '8px 12px',
              borderBottom: '1px solid var(--color-border)',
              display: 'grid',
              gridTemplateColumns: '140px 120px 1fr 1fr',
              gap: 10, fontSize: 11,
            }}>
              <div style={{ color: 'var(--color-ink-subtle)', fontFamily: 'monospace' }}>
                {new Date(e.ts).toLocaleString('en-US')}
              </div>
              <div style={{ fontWeight: 700, color: 'var(--color-ink)' }}>{e.type}</div>
              <div style={{ color: 'var(--color-ink)' }}>{e.entity}</div>
              <div style={{ color: 'var(--color-ink-muted)' }}>{e.detail}</div>
            </div>
          ))}
          {entries.length === 0 && (
            <div style={{ padding: 14, fontSize: 11, color: 'var(--color-ink-subtle)' }}>
              No activity yet. Fire a test ping above.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
