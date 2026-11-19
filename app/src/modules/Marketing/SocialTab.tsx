import { useMemo, useState } from 'react';
import { triggerAllSocialSync } from '../../lib/marketing/social';
import { useSocialOverview, groupPostsByDate, type SocialPost, type ChannelOverview, type PostDay } from '../../lib/marketing/socialPosts';

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

// Columns for the post-comparison table. Facebook + Instagram collapse into one
// "Meta" column (same content ships to both), aggregated per day.
type Col = { key: string; label: string; icon: string; platforms: string[] };
const COLS: Col[] = [
  { key: 'meta',     label: 'Meta (FB + IG)', icon: '🟦', platforms: ['facebook', 'instagram'] },
  { key: 'youtube',  label: 'YouTube',        icon: '▶️', platforms: ['youtube'] },
  { key: 'tiktok',   label: 'TikTok',         icon: '🎵', platforms: ['tiktok'] },
  { key: 'linkedin', label: 'LinkedIn',       icon: '💼', platforms: ['linkedin'] },
];

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
    const totalViews = channels.reduce((s, c) => s + (c.views ?? 0), 0);
    return { followers, newFollowers, anyDelta, views28, totalViews };
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
  const activeCols = useMemo(
    () => COLS.filter(c => c.platforms.some(p => posts.some(pp => pp.platform === p))),
    [posts],
  );

  async function syncAll() {
    setSyncing(true); setMsg('');
    try {
      const summary = await triggerAllSocialSync();
      setMsg(`${summary} Reload to see updated numbers.`);
    } catch (e) { setMsg(`Sync failed: ${String(e)}`); } finally { setSyncing(false); }
  }

  if (loading) return <p style={{ color: subtle, fontSize: 13 }}>Loading…</p>;

  return (
    <div>
      {/* Totals */}
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>All channels — combined</div>
      <div style={{ fontSize: 11, color: muted, marginBottom: 8 }}>Followers + total views are current totals; the 28-day figures are the trailing 28 days.</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 18 }}>
        <Tile label="Total followers" value={abbr(totals.followers)} big />
        <Tile label="Followers · 28d" value={totals.anyDelta ? signed(totals.newFollowers) : 'building…'} sub={totals.anyDelta ? undefined : 'from tomorrow'} />
        <Tile label="Total views" value={abbr(totals.totalViews)} big />
        <Tile label="Views · 28d" value={abbr(totals.views28)} />
      </div>

      <div style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={() => void syncAll()} disabled={syncing} style={{
          padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: syncing ? 'wait' : 'pointer',
          background: 'var(--color-crimson)', color: '#fff', border: 'none', borderRadius: 6,
        }}>{syncing ? 'Syncing…' : 'Sync all platforms'}</button>
        {msg && <span style={{ fontSize: 12, color: muted }}>{msg}</span>}
      </div>

      {/* Per-platform cards */}
      <div style={{ fontSize: 13, fontWeight: 600, margin: '6px 0 8px' }}>By platform</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
        {CHANNELS.map(ch => {
          const m = byChannel.get(ch.key);
          const ins = insights.get(ch.key);
          return <PlatformCard key={ch.key} def={ch} m={m} views28={ins?.views ?? 0} />;
        })}
      </div>

      {/* Cross-platform post comparison */}
      <div style={{ fontSize: 13, fontWeight: 600, margin: '6px 0 2px' }}>Post performance by platform</div>
      <div style={{ fontSize: 11, color: muted, marginBottom: 8 }}>
        Same day = same post (content ships together). Each cell shows engagement + views for the day's post; Meta combines Facebook + Instagram. Best per row is highlighted.
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
                {activeCols.map(c => (
                  <th key={c.key} style={{ padding: '4px 8px 6px', textAlign: 'center' }}>{c.icon} {c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map(d => {
                const aggs = activeCols.map(c => ({ col: c, ...aggCol(d, c.platforms) }));
                let best: string | null = null, bestEng = -1;
                for (const a of aggs) if (a.anyPost && a.eng > bestEng) { best = a.col.key; bestEng = a.eng; }
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
                    {aggs.map(a => {
                      const isBest = a.col.key === best && a.anyPost;
                      return (
                        <td key={a.col.key} style={{ padding: '6px 8px', textAlign: 'center', background: isBest ? 'color-mix(in srgb, var(--color-crimson) 10%, transparent)' : undefined, borderRadius: isBest ? 4 : undefined }}>
                          {a.anyPost
                            ? <Cell eng={a.eng} views={a.views} permalink={a.permalink} caption={d.caption} highlight={isBest} />
                            : <span style={{ color: 'var(--color-border)' }}>·</span>}
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
                <Stat label="Views" value={abbr(ins.views)} />
              </div>
              {ins.best && (
                <div style={{ fontSize: 11, color: muted, lineHeight: 1.4 }}>
                  <span style={{ color: subtle, fontWeight: 600 }}>Top post:</span>{' '}
                  {ins.best.permalink
                    ? <a href={ins.best.permalink} target="_blank" rel="noreferrer" style={{ color: 'var(--color-crimson)' }}>{(ins.best.caption ?? 'view').replace(/\s+/g, ' ').slice(0, 48)}</a>
                    : (ins.best.caption ?? '—').replace(/\s+/g, ' ').slice(0, 48)}
                  {' '}· {abbr(ins.best.engagement)} eng{ins.best.views != null ? ` · ${abbr(ins.best.views)} views` : ''}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Aggregate a column's platforms for one day (Meta sums FB + IG). `views` stays
// null only when no post in the column reports a view count; a genuine 0 is kept.
function aggCol(d: PostDay, platforms: string[]): { anyPost: boolean; eng: number; views: number | null; permalink: string | null } {
  let eng = 0, views = 0, anyPost = false, anyViews = false;
  let permalink: string | null = null;
  for (const p of platforms) {
    const post = d.byPlatform[p];
    if (!post) continue;
    anyPost = true;
    eng += post.engagement ?? 0;
    if (post.views != null) { views += post.views; anyViews = true; }
    if (post.permalink && (!permalink || p === 'instagram')) permalink = post.permalink;
  }
  return { anyPost, eng, views: anyViews ? views : null, permalink };
}

function Cell({ eng, views, permalink, caption, highlight }: { eng: number; views: number | null; permalink: string | null; caption?: string | null; highlight: boolean }) {
  const inner = (
    <div style={{ lineHeight: 1.3 }}>
      <div style={{ fontWeight: 700, fontSize: 14 }}>
        {views != null ? abbr(views) : '—'}<span style={{ fontSize: 9, color: subtle, fontWeight: 400 }}> views</span>
      </div>
      <div style={{ fontSize: 11, color: muted, fontWeight: highlight ? 600 : 400 }}>{abbr(eng)} eng</div>
    </div>
  );
  return permalink
    ? <a href={permalink} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }} title={caption ?? ''}>{inner}</a>
    : inner;
}

function PlatformCard({ def, m, views28 }: { def: ChannelDef; m: ChannelOverview | undefined; views28: number }) {
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
            <Stat label="Total followers" value={abbr(m!.followers)} />
            <Stat label="Total views" value={abbr(m!.views)} />
            <Stat label="Views · 28d" value={abbr(views28)} />
            <Stat label="Followers · 28d" value={m!.followersDelta != null ? signed(m!.followersDelta) : 'building…'} sub={m!.followersDelta != null ? undefined : 'from tomorrow'} />
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

// Full number with thousands separators — no k/m abbreviation anywhere.
function abbr(n: number | null | undefined): string {
  if (n == null) return '—';
  return Math.round(n).toLocaleString();
}
function signed(n: number): string { return (n > 0 ? '+' : '') + n.toLocaleString(); }
