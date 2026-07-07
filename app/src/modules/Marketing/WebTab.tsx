import { useState } from 'react';
import { useGa4, useGsc, triggerGa4Sync, triggerGscSync } from '../../lib/marketing/google';

const subtle = 'var(--color-ink-subtle)';
const muted = 'var(--color-ink-muted)';

// Website analytics — GA4 traffic + Search Console performance. Both pull via a
// Google service account (see the Web setup checklist). Cards show "not connected"
// until the first sync returns rows.
export function WebTab() {
  const { totals: ga, byChannel, lastSynced: gaSynced, loading: gaLoading, reload: reloadGa } = useGa4();
  const { totals: gsc, lastSynced: gscSynced, loading: gscLoading, reload: reloadGsc } = useGsc();
  const [syncing, setSyncing] = useState<'ga4' | 'gsc' | null>(null);
  const [msg, setMsg] = useState('');

  async function run(which: 'ga4' | 'gsc') {
    setSyncing(which); setMsg('');
    try {
      const r = which === 'ga4' ? await triggerGa4Sync() : await triggerGscSync();
      setMsg(r.note ?? `Synced ${r.synced} ${which === 'ga4' ? 'GA4' : 'Search Console'} rows.`);
      if (which === 'ga4') await reloadGa(); else await reloadGsc();
    } catch (e) {
      setMsg(`${which === 'ga4' ? 'GA4' : 'Search Console'} sync failed: ${String(e)}`);
    } finally {
      setSyncing(null);
    }
  }

  const gaConnected = ga.sessions > 0;
  const gscConnected = gsc.impressions > 0;

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div>
          <button style={btn} disabled={syncing !== null} onClick={() => void run('ga4')}>
            {syncing === 'ga4' ? 'Syncing…' : 'Sync GA4'}
          </button>
          <div style={syncedCaption}>{gaSynced ? `Last synced ${fmtDT(gaSynced)}` : 'Never synced'}</div>
        </div>
        <div>
          <button style={btn} disabled={syncing !== null} onClick={() => void run('gsc')}>
            {syncing === 'gsc' ? 'Syncing…' : 'Sync Search Console'}
          </button>
          <div style={syncedCaption}>{gscSynced ? `Last synced ${fmtDT(gscSynced)}` : 'Never synced'}</div>
        </div>
        {msg && <span style={{ fontSize: 12, color: muted, alignSelf: 'center' }}>{msg}</span>}
      </div>

      {/* GA4 */}
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Google Analytics (GA4) · last 90 days</div>
      {gaLoading ? <p style={{ color: subtle, fontSize: 13 }}>Loading…</p> : !gaConnected ? (
        <div style={notice}>Not connected yet. Add the service account to your GA4 property + set <code>GA4_PROPERTY_ID</code>, then Sync GA4.</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            <Kpi label="Sessions" value={ga.sessions.toLocaleString()} />
            <Kpi label="Users" value={ga.users.toLocaleString()} />
            <Kpi label="Conversions" value={ga.conversions.toLocaleString()} />
            <Kpi label="Conv. rate" value={ga.sessions ? `${((ga.conversions / ga.sessions) * 100).toFixed(1)}%` : '—'} />
          </div>
          <table style={{ width: '100%', maxWidth: 520, borderCollapse: 'collapse', fontSize: 12, marginBottom: 18 }}>
            <thead><tr style={{ color: subtle, fontSize: 11, textAlign: 'left' }}><th style={{ paddingBottom: 6 }}>Channel</th><th style={{ textAlign: 'right' }}>Sessions</th><th style={{ textAlign: 'right' }}>Conversions</th></tr></thead>
            <tbody>
              {byChannel.map(c => (
                <tr key={c.channel} style={{ borderTop: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '5px 0' }}>{c.channel}</td>
                  <td style={{ textAlign: 'right' }}>{c.sessions.toLocaleString()}</td>
                  <td style={{ textAlign: 'right' }}>{c.conversions.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* Search Console */}
      <div style={{ fontSize: 13, fontWeight: 600, margin: '10px 0 8px' }}>Search Console · last 90 days</div>
      {gscLoading ? <p style={{ color: subtle, fontSize: 13 }}>Loading…</p> : !gscConnected ? (
        <div style={notice}>Not connected yet. Add the service account to your Search Console property + set <code>GSC_SITE_URL</code>, then Sync Search Console.</div>
      ) : (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Kpi label="Clicks" value={gsc.clicks.toLocaleString()} />
          <Kpi label="Impressions" value={gsc.impressions.toLocaleString()} />
          <Kpi label="CTR" value={`${(gsc.ctr * 100).toFixed(2)}%`} />
          <Kpi label="Avg position" value={gsc.position.toFixed(1)} />
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 6, padding: '8px 14px', minWidth: 110 }}>
      <div style={{ fontSize: 10, color: subtle, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>{value}</div>
    </div>
  );
}

const btn = {
  padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  background: 'var(--color-crimson)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm, 6px)',
} as const;

const notice = {
  fontSize: 12, color: muted, background: 'var(--color-surface)',
  borderRadius: 6, padding: '10px 12px', marginBottom: 14, lineHeight: 1.5,
} as const;

const syncedCaption = { fontSize: 11, color: subtle, marginTop: 4 } as const;

function fmtDT(iso: string): string {
  return new Date(iso).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' });
}
