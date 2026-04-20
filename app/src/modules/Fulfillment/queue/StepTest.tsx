import { useState } from 'react';
import { confirmTestReport, flagRework, type FulfillmentQueueRow } from '../../../lib/fulfillment';
import { useAuth } from '../../../lib/auth';
import styles from '../Fulfillment.module.css';

export function StepTest({ row }: { row: FulfillmentQueueRow }) {
  const { profile, user } = useAuth();
  const name = profile?.display_name ?? user?.email ?? 'Unknown';
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<'idle' | 'flagging'>('idle');
  const [issue, setIssue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePass = async () => {
    setBusy(true); setError(null);
    try { await confirmTestReport(row.id, url); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const handleFlag = async () => {
    if (!issue.trim() || !row.assigned_serial) return;
    setBusy(true); setError(null);
    try {
      await flagRework(row.id, row.assigned_serial, issue.trim(), name);
      setMode('idle'); setIssue('');
    }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
        Verify the test report for unit <code>{row.assigned_serial}</code>
      </h3>
      <label style={{ display: 'block', fontSize: 11, color: 'var(--color-ink-subtle)', marginBottom: 4 }}>
        Test report URL (optional):
      </label>
      <input
        type="url"
        placeholder="https://drive.google.com/..."
        value={url}
        onChange={e => setUrl(e.target.value)}
        style={{
          width: '100%', maxWidth: 500, padding: '6px 10px',
          border: '1px solid var(--color-border)', borderRadius: 4, fontSize: 11,
        }}
      />
      {mode === 'idle' ? (
        <div className={styles.stepBar}>
          <button className={styles.confirmBtn} onClick={handlePass} disabled={busy}>
            {busy ? 'Saving…' : '✓ Test passed — proceed'}
          </button>
          <button
            onClick={() => setMode('flagging')}
            disabled={busy}
            style={{
              background: '#fff', color: 'var(--color-error-strong)',
              border: '1.5px solid var(--color-error-strong)',
              padding: '9px 18px', borderRadius: 4, fontSize: 12, fontWeight: 700,
              cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >⚑ Flag to Aaron/Junaid</button>
        </div>
      ) : (
        <div className={styles.stepBar} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <textarea
            placeholder="What's wrong? (required)"
            value={issue}
            onChange={e => setIssue(e.target.value)}
            rows={2}
            style={{
              width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)',
              borderRadius: 4, fontSize: 11, fontFamily: 'inherit',
            }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleFlag}
              disabled={busy || !issue.trim()}
              style={{
                background: 'var(--color-error-strong)', color: '#fff', border: 'none',
                padding: '8px 16px', borderRadius: 4, fontSize: 11, fontWeight: 700,
                cursor: (!busy && issue.trim()) ? 'pointer' : 'not-allowed',
              }}
            >{busy ? 'Flagging…' : '⚑ Flag rework'}</button>
            <button
              onClick={() => { setMode('idle'); setIssue(''); }}
              disabled={busy}
              style={{
                background: '#fff', color: 'var(--color-ink-subtle)',
                border: '1px solid var(--color-border)', padding: '8px 16px',
                borderRadius: 4, fontSize: 11,
              }}
            >Cancel</button>
          </div>
        </div>
      )}
      {error && <div style={{ color: 'var(--color-error)', fontSize: 11, marginTop: 6 }}>{error}</div>}
    </div>
  );
}
