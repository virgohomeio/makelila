import { useMemo, useState } from 'react';
import { triggerFbIgSync } from '../../lib/marketing/social';
import { useSocialOverview, groupPostsByDate, type SocialPost, type ChannelOverview } from '../../lib/marketing/socialPosts';

const subtle = 'var(--color-ink-subtle)';
const muted = 'var(--color-ink-muted)';

type ChannelDef = { key: string; label: string; icon: string; setup: string };

const CHANNELS: ChannelDef[] = [
  { key: 'facebook',  label: 'Facebook',  icon: '📘', setup: 'Reuses the Meta token — needs page scopes + Page ID' },
  { key: 'instagram', label: 'Instagram', icon: '📸', setup: 'Reuses the Meta token — needs IG scopes' },
  { key: 'youtube',   label: 'YouTube',   icon: '▶️', setup: 'YouTube Data API key' },
  { key: 'tiktok',    label: 'TikTok',    icon: '🎵', setup: 'TikTok Display API + OAuth' },
  { key: 'linkedin',  label: 'LinkedIn',  icon: '💼', setup: 'Community Management API — pending approval' },
];
const LABEL = new Map(CHANNELS.map(c => [c.key, c] as const));

const WINDOW_MS = 28 * 86_400_000;

export function SocialTab() {
  const { posts, channels, loading } = useSocialOverview();
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState('');

  const byChannel = useMemo(() => new Map(channels.map(c => [c.channel, c])), [channels]);

  // Posts within the last 28 days, for totals + insights.
  const recentPosts = useMemo(() => {
    const cut = new Date(Date.now() - WINDOW_MS).toISOString().slice(0, 10);
    return posts.filter(p => (p.posted_date ?? '') >= cut);
  }, [posts]);

  const totals = useMemo(() => {
    const followers = channels.reduce((s, c) => s + (c.followers ?? 0), 0);
    const newFollowers = channels.reduce((s, c) => s + (c.followersDelta ?? 0), 0);
    const anyDelta = channels.some(c => c.followersDelta != null);
    const views28 = recentPosts.reduce((s, p) => s + (p.views ?? 0), 0);
    const eng28 = recentPosts.reduce((s, p) => s + (p.engagement ?? 0), 0);
    const lifetimeViews = channels.reduce((s, c) => s + (c.views ?? 0), 0);
    return { followers, newFollowers, anyDelta, views28, eng28, lifetimeViews };
  }, [channels, recentPosts]);

  // Per-platform insights from the 28-day posts.
  const insights = useMemo(() => {
    const m = new Map<string, { count: number; eng: number; views: number; best: SocialPost | null }>();
    for (const p of recentPosts) {
      const e = m.get(p.platform) ?? { count: 0, eng: 0, views: 0, best: null };
      e.count += 1; e.eng += p.engagement ?? 0; e.views += p.views ?? 0;
      if (!e.best || (p.engagement ?? 0) > (e.best.engagement ?? 0)) e.best = p;
      m.set(p.platform, e);
    }
    return m;
  }, [recentPosts]);

  const days = useMemo(() => groupPostsByDate(posts).slice(0, 20), [posts]);
  const activePlatforms = useMemo(
    () => CHANNELS.map(c => c.key).filter(k => posts.some(p => p.platform === k)),
    [posts],
  );

  async function syncFbIg() {
    setSyncing(true); setMsg('');
    try {
      const r = await triggerFbIgSync();
      setMsg(`Synced ${r.channels.join(' + ') || 'nothing'}. Reload to see updated numbers.`);
    } catch (e) { setMsg(`Sync failed: ${String(e)}`); } finally { setSyncing(false); }
  }

  if (loading) return <p style={{ color: subtle, fontSize: 13 }}>Loading…</p>;

  return (
    <div>
      {/* Totals */}
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>All channels — combined</div>
      <div style={{ fontSize: 11, color: muted, marginBottom: 8 }}>Followers are current; new followers + views + engagement are the trailing 28 days.</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 18 }}>
        <Tile label="Total followers" value={abbr(totals.followers)} big />
        <Tile label="New followers · 28d" value={totals.anyDelta ? signed(totals.newFollowers) : 'building…'} />
        <Tile label="Views · 28d" value={abbr(totals.views28)} />
        <Tile label="Engagement · 28d" value={abbr(totals.eng28)} />
        <Tile label="Lifetime views" value={abbr(totals.lifetimeViews)} sub="YouTube + TikTok" />
      </div>

      <div style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={() => void syncFbIg()} disabled={syncing} style={{
          padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: syncing ? 'wait' : 'pointer',
          background: 'var(--color-crimson)', color: '#fff', border: 'none', borderRadius: 6,
        }}>{syncing ? 'Syncing…' : 'Sync Facebook & Instagram'}</button>
        {msg && <span style={{ fontSize: 12, color: muted }}>{msg}</span>}
      </div>

      {/* Per-platform cards */}
      <div style={{ fontSize: 13, fontWeight: 600, margin: '6px 0 8px' }}>By platform</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
        {CHANNELS.map(ch => {
          const m = byChannel.get(ch.key);
          const ins = insights.get(ch.key);
          return <PlatformCard key={ch.key} def={ch} m={m} count={ins?.count ?? 0} avgEng={ins && ins.count ? Math.round(ins.eng / ins.count) : null} />;
        })}
      </div>

      {/* Cross-platform post comparison */}
      <div style={{ fontSize: 13, fontWeight: 600, margin: '6px 0 2px' }}>Post performance by platform</div>
      <div style={{ fontSize: 11, color: muted, marginBottom: 8 }}>
        Same day = same post (content goes out together). Each cell shows that platform's engagement and views for the day's post. Best per row is highlighted.
      </div>
      {days.length === 0 ? (
        <p style={{ color: subtle, fontSize: 13 }}>No posts synced in the window yet.</p>
      ) : (
        <div style={{ overflowX: 'auto', marginBottom: 20 }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 12, minWidth: 640, width: '100%' }}>
            <thead>
              <tr style={{ color: subtle, fontSize: 11, textAlign: 'left' }}>
                <th style={{ padding: '4px 8px 6px 0', whiteSpace: 'nowrap' }}>Date</th>
                <th style={{ padding: '4px 8px 6px 0', minWidth: 180 }}>Post</th>
                {activePlatforms.map(p => (
                  <th key={p} style={{ padding: '4px 8px 6px', textAlign: 'center' }}>{LABEL.get(p)?.icon} {LABEL.get(p)?.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map(d => {
                const best = activePlatforms.reduce<string | null>((b, p) => {
                  const e = d.byPlatform[p]?.engagement ?? -1;
                  if (e < 0) return b;
                  return b == null || e > (d.byPlatform[b]?.engagement ?? -1) ? p : b;
                }, null);
                return (
                  <tr key={d.date} style={{ borderTop: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '6px 8px 6px 0', whiteSpace: 'nowrap', color: muted }}>
                      {new Date(d.date + 'T12:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}
                    </td>
                    <td style={{ padding: '6px 8px 6px 0', maxWidth: 260, color: subtle }}>
                      <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>
                        {d.caption ? d.caption.replace(/\s+/g, ' ').slice(0, 70) : '—'}
                      </span>
                    </td>
                    {activePlatforms.map(p => {
                      const post = d.byPlatform[p];
                      const isBest = p === best && post;
                      return (
                        <td key={p} style={{ padding: '6px 8px', textAlign: 'center', background: isBest ? 'color-mix(in srgb, var(--color-crimson) 10%, transparent)' : undefined, borderRadius: isBest ? 4 : undefined }}>
                          {post ? (
                            <Cell post={post} highlight={!!isBest} />
                          ) : <span style={{ color: 'var(--color-border)' }}>·</span>}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Per-platform insights */}
      <div style={{ fontSize: 13, fontWeight: 600, margin: '6px 0 8px' }}>Insights · last 28 days</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {activePlatforms.map(p => {
          const ins = insights.get(p)!;
          const def = LABEL.get(p)!;
          return (
            <div key={p} style={{ width: 280, border: '1px solid var(--color-border)', borderRadius: 8, padding: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 16 }}>{def.icon}</span>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{def.label}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                <Stat label="Posts" value={String(ins.count)} />
                <Stat label="Avg engagement" value={ins.count ? abbr(Math.round(ins.eng / ins.count)) : '—'} />
                <Stat label="Total engagement" value={abbr(ins.eng)} />
                <Stat label="Views" value={ins.views ? abbr(ins.views) : '—'} />
              </div>
              {ins.best && (
                <div style={{ fontSize: 11, color: muted, lineHeight: 1.4 }}>
                  <span style={{ color: subtle, fontWeight: 600 }}>Top post:</span>{' '}
                  {ins.best.permalink
                    ? <a href={ins.best.permalink} target="_blank" rel="noreferrer" style={{ color: 'var(--color-crimson)' }}>{(ins.best.caption ?? 'view').replace(/\s+/g, ' ').slice(0, 48)}</a>
                    : (ins.best.caption ?? '—').replace(/\s+/g, ' ').slice(0, 48)}
                  {' '}· {abbr(ins.best.engagement)} eng{ins.best.views ? ` · ${abbr(ins.best.views)} views` : ''}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Cell({ post, highlight }: { post: SocialPost; highlight: boolean }) {
  const inner = (
    <div style={{ lineHeight: 1.25 }}>
      <div style={{ fontWeight: highlight ? 700 : 600, fontSize: 13 }}>{abbr(post.engagement)}<span style={{ fontSize: 9, color: subtle }}> eng</span></div>
      {post.views ? <div style={{ fontSize: 10, color: muted }}>{abbr(post.views)} views</div> : null}
    </div>
  );
  return post.permalink
    ? <a href={post.permalink} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }} title={post.caption ?? ''}>{inner}</a>
    : inner;
}

function PlatformCard({ def, m, count, avgEng }: { def: ChannelDef; m: ChannelOverview | undefined; count: number; avgEng: number | null }) {
  const connected = !!m;
  return (
    <div style={{ width: 230, border: '1px solid var(--color-border)', borderRadius: 8, padding: 14, opacity: connected ? 1 : 0.7 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 18 }}>{def.icon}</span>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{def.label}</span>
        <span style={{ marginLeft: 'auto', width: 8, height: 8, borderRadius: '50%', background: connected ? '#38a169' : '#cbd5e0' }} />
      </div>
      {connected ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Stat label="Followers" value={abbr(m!.followers)} sub={m!.followersDelta != null ? signed(m!.followersDelta) + ' · 28d' : undefined} />
            <Stat label={def.key === 'youtube' || def.key === 'tiktok' ? 'Views' : 'Reach'} value={abbr(def.key === 'youtube' || def.key === 'tiktok' ? m!.views : m!.reach)} />
            <Stat label="Engagement · 28d" value={abbr(m!.engagement)} />
            <Stat label="Posts · 28d" value={String(count)} sub={avgEng != null ? `${abbr(avgEng)} avg` : undefined} />
          </div>
        </>
      ) : (
        <div style={{ fontSize: 11, color: muted, lineHeight: 1.5 }}>
          <div style={{ fontWeight: 600, color: subtle, marginBottom: 2 }}>Not connected</div>
          {def.setup}
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, sub, big }: { label: string; value: string; sub?: string; big?: boolean }) {
  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 6, padding: '8px 14px', minWidth: 120 }}>
      <div style={{ fontSize: 10, color: subtle, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: big ? 22 : 18, fontWeight: 700, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: muted, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: subtle, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: muted }}>{sub}</div>}
    </div>
  );
}

function abbr(n: number | null | undefined): string {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'm';
  if (a >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return n.toLocaleString();
}
function signed(n: number): string { return (n > 0 ? '+' : '') + n.toLocaleString(); }
