import { useState, useEffect } from 'react';
import { confirmTestReport, flagRework, type FulfillmentQueueRow } from '../../../lib/fulfillment';
import { useAuth } from '../../../lib/auth';
import { fetchUnitTestReport, openTestReport, type AttachedTestReport } from '../../../lib/testReports';
import styles from '../Fulfillment.module.css';

export function StepTest({ row }: { row: FulfillmentQueueRow }) {
  const { profile, user } = useAuth();
  const name = profile?.display_name ?? user?.email ?? 'Unknown';
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<'idle' | 'flagging'>('idle');
  const [issue, setIssue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stock already knows whether this serial has a test report, so the step
  // looks it up instead of asking the operator to paste a link by hand.
  // 'loading' and 'error' are kept distinct from 'no report': a failed lookup
  // must never render as "this machine has no test report", which reads as a
  // QC fact about the unit.
  const [report, setReport] = useState<AttachedTestReport | null>(null);
  const [lookup, setLookup] = useState<'loading' | 'done' | 'error'>('loading');
  const [lookupError, setLookupError] = useState<string | null>(null);

  const serial = row.assigned_serial;
  useEffect(() => {
    if (!serial) { setReport(null); setLookup('done'); return; }
    let cancelled = false;
    setLookup('loading'); setLookupError(null);
    fetchUnitTestReport(serial)
      .then(r => { if (!cancelled) { setReport(r); setLookup('done'); } })
      .catch((e: unknown) => {
        if (cancelled) return;
        setReport(null); setLookup('error');
        setLookupError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [serial]);

  const handlePass = async () => {
    setBusy(true); setError(null);
    // An attached report records its storage path, which stays resolvable;
    // a signed URL would be expired long before anyone read the record back.
    try { await confirmTestReport(row.id, report ? report.path : url); }
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

      {lookup === 'loading' && (
        <div className={styles.reportMeta}>Checking Stock for a test report…</div>
      )}

      {lookup === 'error' && (
        <div className={`${styles.reportPanel} ${styles.reportPanelFail}`}>
          <div className={styles.reportHead}>
            <span className={`${styles.reportVerdict} ${styles.reportVerdictFail}`}>
              Couldn't check for a test report
            </span>
          </div>
          <div className={styles.reportMeta}>{lookupError}</div>
        </div>
      )}

      {lookup === 'done' && report && (
        <div
          className={`${styles.reportPanel} ${
            report.result === 'fail' ? styles.reportPanelFail : styles.reportPanelPass
          }`}
        >
          <div className={styles.reportHead}>
            <span
              className={`${styles.reportVerdict} ${
                report.result === 'fail' ? styles.reportVerdictFail : styles.reportVerdictPass
              }`}
            >
              {report.result === 'fail'
                ? '✕ Electrical check failed'
                : report.result === 'incomplete'
                  ? '? Electrical check incomplete'
                  : '✓ Electrical check passed'}
            </span>
            <button
              type="button"
              className={styles.reportOpen}
              onClick={() => {
                // Not awaited before the call — openTestReport claims the tab
                // synchronously so the popup blocker doesn't eat the click.
                openTestReport(report.path).catch((e: unknown) =>
                  setError(e instanceof Error ? e.message : String(e)));
              }}
            >Open report ↗</button>
          </div>
          <div className={styles.reportFile}>{report.name ?? report.path}</div>
          {report.failedTests && (
            <div className={styles.reportFailed}>Failed: {report.failedTests}</div>
          )}
          <div className={styles.reportMeta}>
            From Stock{report.uploadedAt
              ? ` · uploaded ${new Date(report.uploadedAt).toLocaleDateString('en-US')}`
              : ''}
          </div>
        </div>
      )}

      {lookup === 'done' && !report && (
        <>
          <div className={`${styles.reportPanel} ${styles.reportPanelMissing}`}>
            <div className={styles.reportHead}>
              <span className={`${styles.reportVerdict} ${styles.reportVerdictMissing}`}>
                ⚠ No test report attached
              </span>
            </div>
            <div className={styles.reportMeta}>
              {serial
                ? `Stock has no test report for ${serial}. Upload it in Stock, or paste a link below.`
                : 'No unit is assigned to this order yet.'}
            </div>
          </div>
          <label style={{ display: 'block', fontSize: 11, color: 'var(--color-ink-subtle)', margin: '8px 0 4px' }}>
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
        </>
      )}
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
