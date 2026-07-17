import { useState } from 'react';
import { CampaignsTable } from './CampaignsTable';
import { MiniTab } from './MiniTab';
import { DashboardTab } from './DashboardTab';
import { ReportTab } from './ReportTab';
import { SocialTab } from './SocialTab';
import { EmailTab } from './EmailTab';
import { WebTab } from './WebTab';
import { SystemOfRecordCard } from './SystemOfRecordCard';
import { useFbCampaigns, triggerFbSync } from '../../lib/marketing/facebook';
import { useKlaviyoSyncStatus, triggerKlaviyoSync, triggerKlaviyoEventsSync, triggerKlaviyoCampaignsSync } from '../../lib/marketing/klaviyo';
import { triggerGa4Sync, triggerGscSync } from '../../lib/marketing/google';
import { triggerFbIgSync } from '../../lib/marketing/social';
import { supabase } from '../../lib/supabase';
import styles from './Marketing.module.css';

type Tab = 'dashboard' | 'report' | 'campaigns' | 'social' | 'email' | 'web' | 'sync';

// Every inbound analytics source, fired together by the "Sync All Sources"
// button. Each returns a short human summary for the status panel.
const SYNC_ALL_TASKS: { label: string; run: () => Promise<string> }[] = [
  { label: 'Shopify orders', run: async () => {
    // Full sync (no incremental flag) so attribution + journey source backfill
    // across all orders — the Report's Source column reads from here.
    const { data, error } = await supabase.functions.invoke('sync-shopify-orders', { body: {} });
    if (error) throw error;
    const d = (data ?? {}) as { imported?: number; refreshed?: number };
    return `${d.imported ?? 0} new, ${d.refreshed ?? 0} refreshed`;
  } },
  { label: 'Meta Ads', run: async () => `${(await triggerFbSync()).synced} campaign rows` },
  { label: 'Email campaigns', run: async () => { const r = await triggerKlaviyoCampaignsSync(); return r.note ?? `${r.synced} campaigns`; } },
  { label: 'Klaviyo journey', run: async () => { const r = await triggerKlaviyoEventsSync(); return r.note ?? `${r.synced} events`; } },
  { label: 'Google Analytics', run: async () => `${(await triggerGa4Sync()).synced} rows` },
  { label: 'Search Console', run: async () => `${(await triggerGscSync()).synced} rows` },
  { label: 'Organic social', run: async () => { const r = await triggerFbIgSync(); return `${r.synced} rows (${r.channels.join(', ')})`; } },
];

type SyncAllRow = { label: string; state: 'pending' | 'ok' | 'err'; msg: string };

export default function Marketing() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [campaignsSub, setCampaignsSub] = useState<'all' | 'mini'>('all');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncAll, setSyncAll] = useState<SyncAllRow[]>([]);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(() => localStorage.getItem('marketing_last_sync_all'));

  async function handleSyncAll() {
    setSyncingAll(true);
    setSyncAll(SYNC_ALL_TASKS.map(t => ({ label: t.label, state: 'pending', msg: 'Syncing…' })));
    await Promise.all(SYNC_ALL_TASKS.map(async (t, i) => {
      try {
        const msg = await t.run();
        setSyncAll(prev => prev.map((r, j) => (j === i ? { ...r, state: 'ok', msg } : r)));
      } catch (e) {
        setSyncAll(prev => prev.map((r, j) => (j === i ? { ...r, state: 'err', msg: String(e).replace(/^Error:\s*/, '') } : r)));
      }
    }));
    const now = new Date().toISOString();
    localStorage.setItem('marketing_last_sync_all', now);
    setLastSyncAt(now);
    setSyncingAll(false);
  }

  const { campaigns, loading: campsLoading } = useFbCampaigns(90);
  const { logs, loading: logsLoading } = useKlaviyoSyncStatus(5);

  async function handleFbSync() {
    setSyncing(true);
    setSyncMsg('');
    try {
      const result = await triggerFbSync();
      setSyncMsg(`Synced ${result.synced} Facebook campaign rows.`);
    } catch (e) {
      setSyncMsg(`Facebook sync failed: ${String(e)}`);
    } finally {
      setSyncing(false);
    }
  }

  async function handleKlaviyoSync() {
    setSyncing(true);
    setSyncMsg('');
    try {
      const result = await triggerKlaviyoSync();
      setSyncMsg(`Synced ${result.profiles_sent} Klaviyo profiles.`);
    } catch (e) {
      setSyncMsg(`Klaviyo sync failed: ${String(e)}`);
    } finally {
      setSyncing(false);
    }
  }

  async function handleKlaviyoEventsSync() {
    setSyncing(true);
    setSyncMsg('');
    try {
      const r = await triggerKlaviyoEventsSync();
      setSyncMsg(r.note ?? `Pulled ${r.synced} Klaviyo events across ${r.profiles ?? 0} profiles into customer journeys.`);
    } catch (e) {
      setSyncMsg(`Klaviyo events sync failed: ${String(e)}`);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.title}>Marketing</div>
        <div className={styles.syncAllHeader}>
          <button
            className={styles.syncAllBtn}
            onClick={() => void handleSyncAll()}
            disabled={syncingAll}
          >
            {syncingAll ? 'Syncing all sources…' : 'Sync All Sources'}
          </button>
          <span className={styles.syncStatus}>
            {lastSyncAt
              ? `Last synced ${new Date(lastSyncAt).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}`
              : 'Not synced yet'}
          </span>
        </div>
      </div>

      {syncAll.length > 0 && (
        <div className={styles.syncAllPanel}>
          {syncAll.map(r => (
            <div key={r.label} className={styles.syncAllRow}>
              <span className={`${styles.dot} ${r.state === 'ok' ? styles.dotOk : r.state === 'err' ? styles.dotErr : styles.dotPending}`}>
                {r.state === 'ok' ? '✓' : r.state === 'err' ? '✕' : '…'}
              </span>
              <span className={styles.label}>{r.label}</span>
              <span className={styles.msg}>{r.msg}</span>
            </div>
          ))}
        </div>
      )}

      <div className={styles.tabs}>
        {(['dashboard', 'report', 'campaigns', 'social', 'email', 'web', 'sync'] as Tab[]).map(t => (
          <button
            key={t}
            className={`${styles.tab} ${tab === t ? styles.tabActive : ''}`}
            onClick={() => setTab(t)}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'campaigns' && (
        <>
          <div className={styles.syncRow}>
            <button
              className={styles.syncBtn}
              onClick={() => void handleFbSync()}
              disabled={syncing}
            >
              {syncing ? 'Syncing…' : 'Sync Meta Ads'}
            </button>
            {syncMsg && <span className={styles.syncStatus}>{syncMsg}</span>}
          </div>

          <div className={styles.tabs} style={{ marginBottom: 12 }}>
            {(['all', 'mini'] as const).map(s => (
              <button
                key={s}
                className={`${styles.tab} ${campaignsSub === s ? styles.tabActive : ''}`}
                onClick={() => setCampaignsSub(s)}
              >
                {s === 'all' ? 'All campaigns' : 'LILA Mini'}
              </button>
            ))}
          </div>

          {campaignsSub === 'mini' ? (
            <MiniTab />
          ) : campsLoading ? (
            <p style={{ color: 'var(--color-ink-subtle)', fontSize: 13 }}>Loading campaigns…</p>
          ) : campaigns.length === 0 ? (
            <p style={{ color: 'var(--color-ink-subtle)', fontSize: 13 }}>
              No campaigns yet. Click "Sync Meta Ads" to pull data.
            </p>
          ) : (
            <CampaignsTable campaigns={campaigns} />
          )}
        </>
      )}

      {tab === 'dashboard' && <DashboardTab />}

      {tab === 'report' && <ReportTab />}

      {tab === 'social' && <SocialTab />}

      {tab === 'email' && <EmailTab />}

      {tab === 'web' && <WebTab />}

      {tab === 'sync' && (
        <>
          <div className={styles.syncRow}>
            <button
              className={styles.syncBtn}
              onClick={() => void handleKlaviyoSync()}
              disabled={syncing}
            >
              {syncing ? 'Syncing…' : 'Sync Klaviyo Profiles'}
            </button>
            <button
              className={styles.syncBtn}
              onClick={() => void handleKlaviyoEventsSync()}
              disabled={syncing}
            >
              {syncing ? 'Syncing…' : 'Sync Klaviyo Events'}
            </button>
            {syncMsg && <span className={styles.syncStatus}>{syncMsg}</span>}
          </div>

          {logsLoading ? (
            <p style={{ color: 'var(--color-ink-subtle)', fontSize: 13 }}>Loading sync logs…</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: 'var(--color-ink-subtle)', fontSize: 11 }}>
                  <th style={{ textAlign: 'left', paddingBottom: 8 }}>Synced At</th>
                  <th style={{ textAlign: 'right' }}>Profiles Sent</th>
                  <th style={{ textAlign: 'right' }}>Errors</th>
                  <th style={{ textAlign: 'left' }}>Detail</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(log => (
                  <tr key={log.id} style={{ borderTop: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '8px 0' }}>
                      {new Date(log.synced_at).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}
                    </td>
                    <td style={{ textAlign: 'right' }}>{log.profiles_sent}</td>
                    <td style={{ textAlign: 'right', color: log.errors > 0 ? 'var(--color-danger, #c53030)' : 'inherit' }}>
                      {log.errors}
                    </td>
                    <td style={{ color: 'var(--color-ink-subtle)' }}>{log.detail ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <SystemOfRecordCard />
        </>
      )}
    </div>
  );
}
