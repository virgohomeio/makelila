import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { useFbCampaigns } from '../../lib/marketing/facebook';
import { summarizeCampaignTypes, type CampaignTypeKey, type CampaignTypeSummary } from '../../lib/marketing/campaignTypes';
import { useGoogleAds, sumGoogleAds } from '../../lib/marketing/googleAds';
import { useKlaviyoSyncStatus } from '../../lib/marketing/klaviyo';
import { useCacByChannel } from '../../lib/marketing/cac';
import { useAcquisitionOverview } from '../../lib/marketing/journey';
import { useSocialMetrics, SOCIAL_CHANNELS } from '../../lib/marketing/socialOrganic';
import { useSocialOverview } from '../../lib/marketing/socialPosts';

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const num = (n: number | null) => (n == null ? '—' : n.toLocaleString());

const subtle = 'var(--color-ink-subtle)';
const muted = 'var(--color-ink-muted)';

// ── Colour tones ──────────────────────────────────────────────────────────
// A small, fixed palette drawn from the app's semantic tokens so every tinted
// surface on this page reads as one system. Each tone is {bg, border, accent}:
// the accent is both the tile's left stripe and (for a non-neutral tone) its
// value colour, so money-in is green, money-out is red, efficiency is gold, etc.
type Tone = 'neutral' | 'spend' | 'revenue' | 'roas' | 'info' | 'purple';

const TONES: Record<Tone, { bg: string; border: string; accent: string }> = {
  neutral: { bg: 'var(--color-raised)',    border: 'var(--color-border)',        accent: 'var(--color-ink)' },
  spend:   { bg: 'var(--color-error-bg)',   border: 'var(--color-error-border)',  accent: 'var(--color-crimson)' },
  revenue: { bg: 'var(--color-success-bg)', border: 'var(--color-success-border)', accent: 'var(--color-success)' },
  roas:    { bg: 'var(--color-warning-bg)', border: 'var(--color-warning-border)', accent: 'var(--color-warning)' },
  info:    { bg: 'var(--color-info-bg)',    border: 'var(--color-info-border)',   accent: 'var(--color-info)' },
  purple:  { bg: 'var(--color-purple-bg)',  border: '#d6bcfa',                    accent: 'var(--color-purple)' },
};

// Distinct accent per campaign type, so the four breakdown cards are instantly
// tellable apart.
const TYPE_ACCENT: Record<CampaignTypeKey, string> = {
  revenue:   'var(--color-crimson)',
  mini:      'var(--color-info)',
  sharpei:   'var(--color-purple)',
  prepedrum: 'var(--color-accent-coffee)',
};

// Cycling palette for the acquisition-mix bars.
const CHANNEL_COLORS = [
  'var(--color-crimson)', 'var(--color-info)', 'var(--color-success)',
  'var(--color-accent-gold)', 'var(--color-purple)', 'var(--color-accent-clay)',
  'var(--color-phase-delivery)',
];

// Marketing overview: one screen rolling up every channel — paid (Meta ads),
// acquisition mix, CAC, and email-sync health. Renders gracefully when a source
// has no data yet (the Meta/Klaviyo pulls aren't wired in prod), surfacing a
// clear "not synced yet" hint instead of blank zeros.
export function DashboardTab() {
  const { campaigns, loading: campsLoading } = useFbCampaigns(180);
  const { rows: googleRows } = useGoogleAds();
  const { rows: cac, loading: cacLoading } = useCacByChannel();
  const { rows: acq, loading: acqLoading } = useAcquisitionOverview();
  const { logs } = useKlaviyoSyncStatus(1);
  const { rows: social } = useSocialMetrics();
  const { posts: socialPosts, channels: socialChannels } = useSocialOverview();

  // Order the synced channels by our canonical display order; drop unknowns.
  const socialOrdered = useMemo(() => {
    const byKey = new Map(social.map(r => [r.channel, r]));
    return SOCIAL_CHANNELS.map(c => ({ ...c, row: byKey.get(c.key) })).filter(c => c.row);
  }, [social]);

  // Combined organic totals: followers now, + trailing-28d net new / views / engagement.
  const socialTotals = useMemo(() => {
    const cut = new Date(Date.now() - 28 * 86_400_000).toISOString().slice(0, 10);
    const recent = socialPosts.filter(p => (p.posted_date ?? '') >= cut);
    return {
      followers: socialChannels.reduce((s, c) => s + (c.followers ?? 0), 0),
      newFollowers: socialChannels.reduce((s, c) => s + (c.followersDelta ?? 0), 0),
      anyDelta: socialChannels.some(c => c.followersDelta != null),
      totalViews: socialChannels.reduce((s, c) => s + (c.views ?? 0), 0),
      views28: recent.reduce((s, p) => s + (p.views ?? 0), 0),
      hasData: socialChannels.length > 0,
    };
  }, [socialPosts, socialChannels]);

  const ads = useMemo(() => {
    let spend = 0, impressions = 0, clicks = 0, leads = 0;
    const active = new Set<string>();
    for (const c of campaigns) {
      spend += c.spend_cad ?? 0;
      impressions += c.impressions ?? 0;
      clicks += c.clicks ?? 0;
      leads += c.leads ?? 0;
      if (c.status === 'ACTIVE') active.add(c.campaign_id);
    }
    return {
      spend, impressions, clicks, leads,
      ctr: impressions ? (clicks / impressions) * 100 : null,
      cpl: leads ? spend / leads : null,
      active: active.size,
      hasData: campaigns.length > 0,
    };
  }, [campaigns]);

  const google = useMemo(() => sumGoogleAds(googleRows), [googleRows]);
  // Meta's own reported conversions (website purchases).
  const metaConversions = useMemo(
    () => campaigns.reduce((s, c) => s + (c.metrics?.website_purchases ?? 0), 0),
    [campaigns],
  );
  const metaCac = metaConversions ? ads.spend / metaConversions : null;
  const googleCac = google.conversions ? google.spend / google.conversions : null;
  const totalSpend = ads.spend + google.spend;
  const totalConversions = metaConversions + google.conversions;
  const blendedCac = totalConversions ? totalSpend / totalConversions : null;

  // Revenue each platform attributes (Meta purchase value, Google conversion
  // value), blended + per-platform ROAS.
  const metaRevenue = useMemo(
    () => campaigns.reduce((s, c) => s + (c.metrics?.website_purchases_value ?? 0), 0),
    [campaigns],
  );
  const googleRevenue = google.value;
  const totalRevenue = metaRevenue + googleRevenue;
  const metaRoas = ads.spend ? metaRevenue / ads.spend : null;
  const blendedRoas = totalSpend ? totalRevenue / totalSpend : null;

  const topCampaigns = useMemo(
    () => [...campaigns].sort((a, b) => (b.spend_cad ?? 0) - (a.spend_cad ?? 0)).slice(0, 5),
    [campaigns],
  );

  // The four campaign types (revenue / Mini reservation / Sharpei leads /
  // pre-Pedrum), each with its own spend + revenue.
  const campaignTypes = useMemo(() => summarizeCampaignTypes(campaigns), [campaigns]);

  const acqTotal = acq.reduce((s, r) => s + r.count, 0);
  const lastKlaviyo = logs[0]?.synced_at ? new Date(logs[0].synced_at).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }) : null;

  return (
    <div>
      {/* Combined paid-ads summary — Meta + Google, together and split. */}
      <SectionHead color="var(--color-crimson)">Paid ads summary — Meta + Google</SectionHead>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 6 }}>
        <Tile tone="spend" label="Total ad spend (CAD)" value={money(totalSpend)} sub={`${totalConversions.toLocaleString()} conversions`} />
        <Tile tone="revenue" label="Total revenue (CAD)" value={money(totalRevenue)} sub={`Meta ${money(metaRevenue)} · Google ${money(googleRevenue)}`} />
        <Tile tone="roas" label="Blended ROAS" value={blendedRoas != null ? `${blendedRoas.toFixed(2)}×` : '—'} sub="revenue ÷ spend" />
        <Tile tone="purple" label="Blended CAC" value={blendedCac != null ? money(blendedCac) : '—'} />
        <Tile tone="spend" label="Meta spend" value={money(ads.spend)} sub={metaRoas != null ? `${money(metaRevenue)} rev · ${metaRoas.toFixed(2)}× ROAS` : (metaCac != null ? `$${metaCac.toFixed(0)} CAC` : undefined)} />
        <Tile tone="info" label="Google spend" value={money(google.spend)} sub={googleCac != null ? `${money(googleRevenue)} rev · ${google.spend ? (googleRevenue / google.spend).toFixed(2) : '—'}× ROAS` : (google.hasData ? undefined : 'not synced')} />
      </div>
      <div style={{ fontSize: 11, color: muted, marginBottom: 16 }}>
        Revenue + conversions are each platform's own reported numbers (Meta purchase value / purchases, Google conversion
        value / conversions); ROAS is revenue ÷ spend. Meta reflects synced campaign lifetime; Google reflects the last ~90 days.
      </div>

      {/* Campaign-type breakdown — each type's own ad spend + revenue (Meta). */}
      <SectionHead color="var(--color-accent-gold)">Campaign breakdown (Meta) — spend + revenue by type</SectionHead>
      <div style={{ fontSize: 11, color: muted, marginBottom: 10 }}>
        Each Meta campaign is sorted into one type by name. Revenue campaigns + pre-Pedrum are judged on revenue/ROAS;
        LILA Mini + Sharpei are lead-gen, so leads (not revenue) are the goal.
      </div>
      {ads.hasData ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 18 }}>
          {campaignTypes.map(t => <CampaignTypeCard key={t.key} t={t} />)}
        </div>
      ) : (
        <div style={{ ...notice, marginBottom: 18 }}>No Meta campaign data yet — breakdown lights up once the ads sync has run.</div>
      )}

      {/* Paid-ads KPI row */}
      <SectionHead color="var(--color-crimson)">Paid ads (Meta) — last 180 days synced</SectionHead>
      {campsLoading ? (
        <p style={{ color: subtle, fontSize: 13 }}>Loading…</p>
      ) : !ads.hasData ? (
        <div style={notice}>
          No campaign data yet. The Meta Ads sync (<code>sync-facebook-ads</code>) isn't running in prod —
          campaign metrics light up once it's deployed with Meta API access. Use the <strong>Campaigns</strong> tab's
          "Sync Facebook Ads" button once that's wired.
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
          <Tile tone="spend" label="Ad spend (CAD)" value={`$${ads.spend.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
          <Tile label="Impressions" value={ads.impressions.toLocaleString()} />
          <Tile tone="info" label="Clicks" value={ads.clicks.toLocaleString()} sub={ads.ctr != null ? `${ads.ctr.toFixed(2)}% CTR` : undefined} />
          <Tile tone="roas" label="Leads" value={ads.leads.toLocaleString()} sub={ads.cpl != null ? `$${ads.cpl.toFixed(0)} CPL` : undefined} />
          <Tile tone="purple" label="Purchases" value={metaConversions.toLocaleString()} sub={metaCac != null ? `$${metaCac.toFixed(0)} CAC` : undefined} />
          <Tile tone="revenue" label="Revenue (CAD)" value={money(metaRevenue)} sub={metaRoas != null ? `${metaRoas.toFixed(2)}× ROAS` : undefined} />
          <Tile label="Active campaigns" value={String(ads.active)} />
        </div>
      )}

      {ads.hasData && topCampaigns.length > 0 && (
        <div style={{ marginTop: 12, marginBottom: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Top campaigns by spend</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: 'var(--color-ink)', fontSize: 11, textAlign: 'left', background: 'var(--color-surface)' }}>
                <th style={{ padding: '6px 8px', borderRadius: '4px 0 0 4px' }}>Campaign</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>Spend</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>Clicks</th>
                <th style={{ textAlign: 'right', padding: '6px 8px' }}>Leads</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', borderRadius: '0 4px 4px 0' }}>CPL</th>
              </tr>
            </thead>
            <tbody>
              {topCampaigns.map(c => (
                <tr key={c.campaign_id + c.date_start} style={{ borderTop: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '6px 8px', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.campaign_name}</td>
                  <td style={{ textAlign: 'right', padding: '6px 8px', color: 'var(--color-crimson)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{c.spend_cad != null ? `$${c.spend_cad.toFixed(0)}` : '—'}</td>
                  <td style={{ textAlign: 'right', padding: '6px 8px', fontVariantNumeric: 'tabular-nums' }}>{c.clicks?.toLocaleString() ?? '—'}</td>
                  <td style={{ textAlign: 'right', padding: '6px 8px', fontVariantNumeric: 'tabular-nums' }}>{c.leads ?? '—'}</td>
                  <td style={{ textAlign: 'right', padding: '6px 8px', fontVariantNumeric: 'tabular-nums' }}>{c.cpl_cad != null ? `$${c.cpl_cad.toFixed(0)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Paid ads (Google) */}
      <SectionHead color="var(--color-info)">Paid ads (Google) — last ~90 days synced</SectionHead>
      {!google.hasData ? (
        <div style={notice}>No Google Ads data yet — <code>sync-google-ads</code> populates this every 3 hours.</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
          <Tile tone="spend" label="Ad spend (CAD)" value={money(google.spend)} />
          <Tile label="Impressions" value={google.impressions.toLocaleString()} />
          <Tile tone="info" label="Clicks" value={google.clicks.toLocaleString()} sub={google.impressions ? `${((google.clicks / google.impressions) * 100).toFixed(2)}% CTR` : undefined} />
          <Tile tone="purple" label="Conversions" value={google.conversions.toLocaleString()} sub={googleCac != null ? `$${googleCac.toFixed(0)} CAC` : undefined} />
          <Tile tone="revenue" label="Revenue — conv. value (CAD)" value={money(google.value)} sub={google.spend ? `${(google.value / google.spend).toFixed(2)}× ROAS` : undefined} />
        </div>
      )}

      {/* Organic social */}
      <SectionHead color="var(--color-purple)">Organic social</SectionHead>
      <div style={{ fontSize: 11, color: muted, marginBottom: 8 }}>Followers + total views are current; the 28-day figures are the trailing 28 days. Full breakdown on the Social tab.</div>
      {socialTotals.hasData && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
          <Tile tone="info" label="Total followers" value={num(socialTotals.followers)} />
          <Tile tone="revenue" label="Followers · 28d" value={socialTotals.anyDelta ? (socialTotals.newFollowers > 0 ? '+' : '') + socialTotals.newFollowers.toLocaleString() : 'building…'} />
          <Tile tone="purple" label="Total views" value={num(socialTotals.totalViews)} />
          <Tile tone="roas" label="Views · 28d" value={num(socialTotals.views28)} />
        </div>
      )}
      {socialOrdered.length === 0 ? (
        <div style={notice}>No organic social data yet — <code>sync-social-organic</code> populates Facebook + Instagram daily (YouTube / TikTok / LinkedIn are separate setups).</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
          {socialOrdered.map((c, i) => (
            <SocialCard key={c.key} label={c.label} accent={CHANNEL_COLORS[i % CHANNEL_COLORS.length]}
              followers={c.row!.followers} reach={c.row!.reach} engagement={c.row!.engagement} posts={c.row!.posts} />
          ))}
        </div>
      )}

      {/* Acquisition mix */}
      <SectionHead color="var(--color-success)">Where customers come from (first touch)</SectionHead>
      {acqLoading ? (
        <p style={{ color: subtle, fontSize: 13 }}>Loading…</p>
      ) : acq.length === 0 ? (
        <p style={{ color: subtle, fontSize: 13 }}>No attribution captured yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 8 }}>
          {acq.map((r, i) => {
            const color = CHANNEL_COLORS[i % CHANNEL_COLORS.length];
            const pct = acqTotal ? (r.count / acqTotal) * 100 : 0;
            return (
              <div key={r.channel} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
                <span style={{ width: 130, color: muted, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                  {r.channel}
                </span>
                <div style={{ flex: 1, background: 'var(--color-surface)', borderRadius: 999, overflow: 'hidden', height: 14 }}>
                  <div style={{ width: `${pct}%`, background: color, height: '100%', borderRadius: 999, transition: 'width var(--dur-settle) var(--ease-out)' }} />
                </div>
                <span style={{ width: 64, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.count} <span style={{ color: subtle }}>({Math.round(pct)}%)</span></span>
              </div>
            );
          })}
        </div>
      )}

      {/* CAC by channel */}
      <SectionHead color="var(--color-accent-gold)">Cost per acquisition by channel</SectionHead>
      {cacLoading ? (
        <p style={{ color: subtle, fontSize: 13 }}>Loading…</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 8 }}>
          <thead>
            <tr style={{ color: 'var(--color-ink)', fontSize: 11, textAlign: 'left', background: 'var(--color-surface)' }}>
              <th style={{ padding: '6px 8px', borderRadius: '4px 0 0 4px' }}>Channel</th>
              <th style={{ textAlign: 'right', padding: '6px 8px' }}>Spend (CAD)</th>
              <th style={{ textAlign: 'right', padding: '6px 8px' }}>Customers</th>
              <th style={{ textAlign: 'right', padding: '6px 8px', borderRadius: '0 4px 4px 0' }}>CAC</th>
            </tr>
          </thead>
          <tbody>
            {cac.map(r => (
              <tr key={r.channel} style={{ borderTop: '1px solid var(--color-border)' }}>
                <td style={{ padding: '6px 8px' }}>{r.channel}</td>
                <td style={{ textAlign: 'right', padding: '6px 8px', fontVariantNumeric: 'tabular-nums' }}>{r.spend_cad ? `$${r.spend_cad.toFixed(0)}` : '—'}</td>
                <td style={{ textAlign: 'right', padding: '6px 8px', fontVariantNumeric: 'tabular-nums' }}>{r.customers_acquired}</td>
                <td style={{ textAlign: 'right', padding: '6px 8px', color: 'var(--color-accent-coffee)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{r.cac_cad != null ? `$${r.cac_cad.toFixed(0)}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Source health */}
      <SectionHead color="var(--color-ink-subtle)">Data sources</SectionHead>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
        <SourceRow name="Meta Ads" ok={ads.hasData} detail={ads.hasData ? `${campaigns.length} campaign rows synced` : 'sync-facebook-ads not deployed yet'} />
        <SourceRow name="Google Ads" ok={google.hasData} detail={google.hasData ? `${money(google.spend)} spend synced (last 90d)` : 'sync-google-ads: no data yet'} />
        <SourceRow name="Klaviyo (email)" ok={!!lastKlaviyo} detail={lastKlaviyo ? `last profile sync ${lastKlaviyo}` : 'sync-klaviyo-profiles not deployed yet'} />
        <SourceRow name="Attribution (first touch)" ok={acqTotal > 0} detail={`${acqTotal} customers with a source`} />
        <SourceRow name="Organic social (Facebook + Instagram)" ok={socialOrdered.length > 0} detail={socialOrdered.length > 0 ? `${socialOrdered.map(c => c.label).join(' + ')} synced` : 'sync-social-organic: no data yet'} />
        <SourceRow name="Organic social (YouTube / TikTok / LinkedIn)" ok={false} detail="separate app setup — not wired yet" />
        <SourceRow name="Google Analytics (GA4)" ok={false} detail="synced to ga4_daily — dashboard section coming" />
      </div>
    </div>
  );
}

// Section heading with a coloured accent bar — gives each block of the page its
// own identity at a glance.
function SectionHead({ color, children }: { color: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '18px 0 8px' }}>
      <span style={{ width: 4, height: 17, borderRadius: 2, background: color, flexShrink: 0 }} />
      <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-ink)' }}>{children}</span>
    </div>
  );
}

function CampaignTypeCard({ t }: { t: CampaignTypeSummary }) {
  const isLeads = t.goal === 'leads';
  const accent = TYPE_ACCENT[t.key];
  return (
    <div style={{
      border: '1px solid var(--color-border)', borderRadius: 10, overflow: 'hidden',
      minWidth: 210, flex: '1 1 210px', maxWidth: 260, background: 'var(--color-raised)',
      boxShadow: 'var(--shadow-sm)',
    }}>
      <div style={{ height: 4, background: accent }} />
      <div style={{ padding: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: accent }}>{t.label}</div>
        <div style={{ fontSize: 10, color: subtle, marginBottom: 10 }}>{t.blurb} · {t.campaigns} campaign{t.campaigns === 1 ? '' : 's'}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <MiniStat label="Ad spend" value={money(t.spend)} color="var(--color-crimson)" />
          <MiniStat label="Revenue" value={money(t.revenue)} color="var(--color-success)" />
          {isLeads
            ? <MiniStat label="Leads" value={t.leads.toLocaleString()} color={accent} />
            : <MiniStat label="Purchases" value={t.purchases.toLocaleString()} color={accent} />}
          <MiniStat
            label={isLeads ? 'Cost / lead' : 'ROAS'}
            value={isLeads
              ? (t.leads ? `$${(t.spend / t.leads).toFixed(2)}` : '—')
              : (t.roas != null ? `${t.roas.toFixed(2)}×` : '—')}
          />
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, tone = 'neutral' }: { label: string; value: string; sub?: string; tone?: Tone }) {
  const t = TONES[tone];
  return (
    <div style={{
      border: `1px solid ${t.border}`, borderRadius: 8, padding: '9px 14px 9px 16px', minWidth: 124,
      background: t.bg, position: 'relative', overflow: 'hidden',
    }}>
      <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: t.accent }} />
      <div style={{ fontSize: 10, color: subtle, textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2, color: tone === 'neutral' ? 'var(--color-ink)' : t.accent, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: muted, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function SocialCard({ label, accent, followers, reach, engagement, posts }: {
  label: string; accent: string; followers: number | null; reach: number | null; engagement: number | null; posts: number | null;
}) {
  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 8, overflow: 'hidden', minWidth: 180, background: 'var(--color-raised)', boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ height: 4, background: accent }} />
      <div style={{ padding: '8px 14px 10px' }}>
        <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4, color: accent }}>{label}</div>
        <div style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{num(followers)}</div>
        <div style={{ fontSize: 10, color: subtle, textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 6 }}>followers</div>
        <div style={{ display: 'flex', gap: 14 }}>
          <MiniStat label="Reach 28d" value={num(reach)} />
          <MiniStat label="Engage 28d" value={num(engagement)} />
          <MiniStat label="Posts" value={num(posts)} />
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 700, color: color ?? 'var(--color-ink)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 9, color: subtle, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
    </div>
  );
}

function SourceRow({ name, ok, detail }: { name: string; ok: boolean; detail: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: ok ? 'var(--color-success)' : 'var(--color-ink-faint)', flexShrink: 0, boxShadow: ok ? '0 0 0 3px rgba(39,103,73,0.12)' : 'none' }} />
      <span style={{ width: 220 }}>{name}</span>
      <span style={{ color: subtle }}>{detail}</span>
    </div>
  );
}

const notice: CSSProperties = {
  fontSize: 12, color: muted, background: 'var(--color-surface)',
  borderRadius: 6, padding: '10px 12px', marginBottom: 8, lineHeight: 1.5,
};
