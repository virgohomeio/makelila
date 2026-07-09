import { useState } from 'react';
import { CacDashboard } from './CacDashboard';
import { CampaignsTable } from './CampaignsTable';
import { MiniTab } from './MiniTab';
import { DashboardTab } from './DashboardTab';
import { ReportTab } from './ReportTab';
import { JourneyTab } from './JourneyTab';
import { SocialTab } from './SocialTab';
import { WebTab } from './WebTab';
import { SystemOfRecordCard } from './SystemOfRecordCard';
import { useFbCampaigns, triggerFbSync } from '../../lib/marketing/facebook';
import { useKlaviyoSyncStatus, triggerKlaviyoSync, triggerKlaviyoEventsSync } from '../../lib/marketing/klaviyo';
import styles from './Marketing.module.css';

type Tab = 'dashboard' | 'report' | 'campaigns' | 'mini' | 'social' | 'web' | 'attribution' | 'journey' | 'sync';

const TAB_LABEL: Partial<Record<Tab, string>> = { mini: 'LILA Mini' };

export default function Marketing() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

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
      </div>

      <div className={styles.tabs}>
        {(['dashboard', 'report', 'campaigns', 'mini', 'social', 'web', 'attribution', 'journey', 'sync'] as Tab[]).map(t => (
          <button
            key={t}
            className={`${styles.tab} ${tab === t ? styles.tabActive : ''}`}
            onClick={() => setTab(t)}
          >
            {TAB_LABEL[t] ?? t.charAt(0).toUpperCase() + t.slice(1)}
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
              {syncing ? 'Syncing…' : 'Sync Facebook Ads'}
            </button>
            {syncMsg && <span className={styles.syncStatus}>{syncMsg}</span>}
          </div>

          {campsLoading ? (
            <p style={{ color: 'var(--color-ink-subtle)', fontSize: 13 }}>Loading campaigns…</p>
          ) : campaigns.length === 0 ? (
            <p style={{ color: 'var(--color-ink-subtle)', fontSize: 13 }}>
              No campaigns yet. Click "Sync Facebook Ads" to pull data.
            </p>
          ) : (
            <CampaignsTable campaigns={campaigns} />
          )}
        </>
      )}

      {tab === 'dashboard' && <DashboardTab />}

      {tab === 'report' && <ReportTab />}

      {tab === 'mini' && <MiniTab />}

      {tab === 'social' && <SocialTab />}

      {tab === 'web' && <WebTab />}

      {tab === 'attribution' && <CacDashboard />}

      {tab === 'journey' && <JourneyTab />}

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
