import { useState } from 'react';
import { useSocialLatest, triggerFbIgSync, type SocialChannel } from '../../lib/marketing/social';

const subtle = 'var(--color-ink-subtle)';
const muted = 'var(--color-ink-muted)';

type ChannelDef = { key: SocialChannel; label: string; icon: string; setup: string };

// Organic-social channels. Each "connects" when its sync edge function starts
// upserting rows into social_metrics. Setup notes mirror what each platform
// needs (see the roadmap) so the operator knows why a channel is dark.
const CHANNELS: ChannelDef[] = [
  { key: 'facebook',  label: 'Facebook',  icon: '📘', setup: 'Reuses the Meta token — needs page scopes + Page ID' },
  { key: 'instagram', label: 'Instagram', icon: '📸', setup: 'Reuses the Meta token — needs IG scopes (IG is linked to the Page)' },
  { key: 'youtube',   label: 'YouTube',   icon: '▶️', setup: 'Needs a Google Cloud project + YouTube Data/Analytics API' },
  { key: 'linkedin',  label: 'LinkedIn',  icon: '💼', setup: 'Needs a LinkedIn app + Marketing API access (approval)' },
  { key: 'tiktok',    label: 'TikTok',    icon: '🎵', setup: 'Needs a TikTok for Business app + OAuth' },
];

export function SocialTab() {
  const { byChannel, loading } = useSocialLatest();
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState('');

  async function syncFbIg() {
    setSyncing(true); setMsg('');
    try {
      const r = await triggerFbIgSync();
      setMsg(`Synced ${r.channels.join(' + ') || 'nothing'}. Reload to see updated numbers.`);
    } catch (e) {
      setMsg(`Sync failed: ${String(e)}`);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Organic social</div>
      <p style={{ color: subtle, fontSize: 12, marginTop: 0, marginBottom: 12 }}>
        Followers, reach and engagement per channel. Each lights up once its connection is wired — Facebook & Instagram
        reuse the Meta token; YouTube, LinkedIn and TikTok each need their own app + token.
      </p>

      <div style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          onClick={() => void syncFbIg()}
          disabled={syncing}
          style={{
            padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: syncing ? 'wait' : 'pointer',
            background: 'var(--color-crimson)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm, 6px)',
          }}
        >
          {syncing ? 'Syncing…' : 'Sync Facebook & Instagram'}
        </button>
        {msg && <span style={{ fontSize: 12, color: muted }}>{msg}</span>}
      </div>

      {loading ? (
        <p style={{ color: subtle, fontSize: 13 }}>Loading…</p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {CHANNELS.map(ch => {
            const m = byChannel.get(ch.key);
            const connected = !!m;
            return (
              <div
                key={ch.key}
                style={{
                  width: 230, border: '1px solid var(--color-border)', borderRadius: 8,
                  padding: 14, opacity: connected ? 1 : 0.72,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 18 }}>{ch.icon}</span>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{ch.label}</span>
                  <span style={{
                    marginLeft: 'auto', width: 8, height: 8, borderRadius: '50%',
                    background: connected ? '#38a169' : '#cbd5e0',
                  }} />
                </div>

                {connected ? (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <Stat label="Followers" value={fmt(m!.followers)} />
                      <Stat label={ch.key === 'youtube' || ch.key === 'tiktok' ? 'Views' : 'Reach'} value={fmt(ch.key === 'youtube' || ch.key === 'tiktok' ? m!.views : m!.reach)} />
                      <Stat label="Engagement" value={fmt(m!.engagement)} />
                      <Stat label="Posts" value={fmt(m!.posts)} />
                    </div>
                    <div style={{ fontSize: 10, color: subtle, marginTop: 8 }}>
                      as of {new Date(m!.as_of).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: '2-digit' })}
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 11, color: muted, lineHeight: 1.5 }}>
                    <div style={{ fontWeight: 600, color: subtle, marginBottom: 2 }}>Not connected</div>
                    {ch.setup}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: subtle, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function fmt(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString();
}
