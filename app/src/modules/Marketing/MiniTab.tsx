import { useMemo, useState } from 'react';
import { useFbAds, type FbAd } from '../../lib/marketing/facebook';

const subtle = 'var(--color-ink-subtle)';
const muted = 'var(--color-ink-muted)';

// Ad-level analysis for a creative test (built for the LILA Mini campaign: 5
// creatives × 5 audiences). Three views for the selected campaign: overall,
// per ad set (audience), and per ad creative (ad name, compiled across ad sets).

type Agg = {
  name: string;
  spend: number; impressions: number; clicks: number; leads: number;
  cpl: number | null; cpc: number | null; ctr: number | null; leadRate: number | null;
};

function aggregate(name: string, list: FbAd[]): Agg {
  let spend = 0, impressions = 0, clicks = 0, leads = 0;
  for (const a of list) {
    spend += a.spend_cad ?? 0;
    impressions += a.impressions ?? 0;
    clicks += a.clicks ?? 0;
    leads += a.leads ?? 0;
  }
  return {
    name, spend, impressions, clicks, leads,
    cpl: leads > 0 ? spend / leads : null,
    cpc: clicks > 0 ? spend / clicks : null,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    leadRate: impressions > 0 ? (leads / impressions) * 100 : null,
  };
}

function groupBy(list: FbAd[], key: (a: FbAd) => string): Agg[] {
  const m = new Map<string, FbAd[]>();
  for (const a of list) {
    const k = key(a) || '—';
    (m.get(k) ?? m.set(k, []).get(k)!).push(a);
  }
  return Array.from(m.entries())
    .map(([name, rows]) => aggregate(name, rows))
    .sort((a, b) => b.spend - a.spend);
}

const money  = (n: number | null) => (n == null ? '—' : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const money2 = (n: number | null) => (n == null ? '—' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct    = (n: number | null) => (n == null ? '—' : `${n.toFixed(2)}%`);
const num    = (n: number) => n.toLocaleString();

// Friendly description per creative, keyed off the m<N> prefix of the ad name
// (m1a, m2b… → m1, m2…). LILA Mini July creative test.
const CREATIVE_MAP: Record<string, string> = {
  m1: 'Pedrum Images',
  m2: 'LaunchBoom Images',
  m3: 'Pro Performer Videos',
  m4: 'LaunchBoom Videos',
  m5: 'IAS Render Video',
};
function creativeLabel(name: string): string {
  const m = name.toLowerCase().match(/m\s*(\d+)/);
  return m ? CREATIVE_MAP[`m${m[1]}`] ?? '—' : '—';
}

// The "text combination" code in an ad name (e.g. "m4a HB3BL1" → "HB3BL1"),
// stripping the creative code (m<N><letter>) so ads group by their text variant.
function textCombo(name: string): string {
  const tokens = name.split(/[\s\-_|]+/).filter(Boolean);
  const nonCreative = tokens.filter(t => !/^m\d+[a-z]?$/i.test(t));
  return (nonCreative.length ? nonCreative.join(' ') : name) || '—';
}

// Local YYYY-MM-DD for today + offset (matches fb_ads.date_start day strings).
function dayStr(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const RANGES: { key: string; label: string; from: () => string; to: () => string }[] = [
  { key: 'today',     label: 'Today',         from: () => dayStr(0),   to: () => dayStr(0) },
  { key: 'yesterday', label: 'Yesterday',     from: () => dayStr(-1),  to: () => dayStr(-1) },
  { key: '7',         label: 'Last 7 days',   from: () => dayStr(-6),  to: () => dayStr(0) },
  { key: '14',        label: 'Last 14 days',  from: () => dayStr(-13), to: () => dayStr(0) },
  { key: '28',        label: 'Last 28 days',  from: () => dayStr(-27), to: () => dayStr(0) },
  { key: '30',        label: 'Last 30 days',  from: () => dayStr(-29), to: () => dayStr(0) },
  { key: '90',        label: 'Last 90 days',  from: () => dayStr(-89), to: () => dayStr(0) },
  { key: 'all',       label: 'All time',      from: () => '0000-01-01', to: () => '9999-12-31' },
];

type MiniView = 'creative' | 'text';

export function MiniTab() {
  const { ads, loading } = useFbAds();
  const [rangeKey, setRangeKey] = useState('all');
  const [view, setView] = useState<MiniView>('creative');
  const [selected, setSelected] = useState<string | null>(null);

  const campaigns = useMemo(() => {
    const s = new Set<string>();
    for (const a of ads) if (a.campaign_name) s.add(a.campaign_name);
    return Array.from(s).sort();
  }, [ads]);

  // Each sub-tab defaults to its own campaign: the creative test vs the primary
  // text-sales campaign. The picker still lets you switch to any campaign.
  const defaultCampaign = useMemo(() => {
    if (view === 'creative') {
      return campaigns.find(c => /creative/i.test(c)) ?? campaigns.find(c => /mini/i.test(c)) ?? campaigns[0] ?? '';
    }
    return campaigns.find(c => /mini/i.test(c) && !/creative/i.test(c)) ?? campaigns.find(c => /mini/i.test(c)) ?? campaigns[0] ?? '';
  }, [campaigns, view]);
  const campaign = selected ?? defaultCampaign;

  const campaignAds = useMemo(() => {
    const r = RANGES.find(x => x.key === rangeKey) ?? RANGES[RANGES.length - 1];
    const from = r.from(), to = r.to();
    return ads.filter(a =>
      a.campaign_name === campaign &&
      a.date_start != null && a.date_start >= from && a.date_start <= to);
  }, [ads, campaign, rangeKey]);

  const overall = useMemo(() => aggregate('Whole campaign', campaignAds), [campaignAds]);
  const byAdset = useMemo(() => groupBy(campaignAds, a => a.adset_name ?? '—'), [campaignAds]);
  const byThird = useMemo(
    () => groupBy(campaignAds, a => (view === 'creative' ? (a.ad_name ?? '—') : textCombo(a.ad_name ?? ''))),
    [campaignAds, view],
  );

  if (loading) return <p style={{ color: subtle, fontSize: 13 }}>Loading ad data…</p>;
  if (ads.length === 0) return (
    <p style={{ color: subtle, fontSize: 13 }}>
      No ad-level data yet. Run <strong>Campaigns → Sync Facebook Ads</strong> (it now pulls ad-level rows too).
    </p>
  );

  return (
    <div>
      {/* Sub-tabs: the creative test vs the primary text-sales campaign */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid var(--color-border)', marginBottom: 14 }}>
        {([['creative', 'Creative Test'], ['text', 'Text Sales']] as [MiniView, string][]).map(([k, label]) => (
          <button key={k} onClick={() => { setView(k); setSelected(null); }}
            style={{
              padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none', background: 'none',
              color: view === k ? 'var(--color-crimson)' : 'var(--color-ink-muted)',
              borderBottom: `2px solid ${view === k ? 'var(--color-crimson)' : 'transparent'}`, marginBottom: -2,
            }}>{label}</button>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: muted }}>Campaign</span>
        <select value={campaign} onChange={e => setSelected(e.target.value)}
                style={{ padding: '6px 10px', fontSize: 13, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm, 6px)', maxWidth: 420 }}>
          {campaigns.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <span style={{ fontSize: 12, color: muted }}>Date</span>
        <select value={rangeKey} onChange={e => setRangeKey(e.target.value)}
                style={{ padding: '6px 10px', fontSize: 13, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm, 6px)' }}>
          {RANGES.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <span style={{ fontSize: 11, color: subtle }}>{campaignAds.length} ad-days</span>
      </div>

      <Section title="Overall campaign" rows={[overall]} firstCol="Campaign" />
      <Section title="By ad set (audience)" rows={byAdset} firstCol="Ad set" />
      {view === 'creative' ? (
        <Section title="By ad creative (compiled across ad sets)" rows={byThird} firstCol="Ad name" describe={creativeLabel} />
      ) : (
        <Section title="By text combination (compiled across ad sets)" rows={byThird} firstCol="Text combination" />
      )}

      <div style={{ fontSize: 11, color: muted, marginTop: 8 }}>
        {view === 'creative'
          ? '"Creative" groups by ad name (m1a, m2a…), summing that creative across all its ad sets.'
          : '"Text combination" is parsed from the ad name (e.g. "m4a HB3BL1" → "HB3BL1"), summing each text variant across creatives + ad sets.'}
        {' '}Lead rate = leads ÷ impressions.
      </div>
    </div>
  );
}

function Section({ title, rows, firstCol, describe }: {
  title: string; rows: Agg[]; firstCol: string; describe?: (name: string) => string;
}) {
  const leftTh = { textAlign: 'left', padding: '8px 10px', background: 'var(--color-surface)' } as const;
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{title}</div>
      <div style={{ overflowX: 'auto', border: '1px solid var(--color-border)', borderRadius: 8 }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%', whiteSpace: 'nowrap' }}>
          <thead>
            <tr style={{ color: subtle, fontSize: 11 }}>
              <th style={leftTh}>{firstCol}</th>
              {describe && <th style={leftTh}>Type</th>}
              <th style={th}>Leads</th>
              <th style={th}>Cost / lead</th>
              <th style={th}>Lead rate</th>
              <th style={th}>Clicks</th>
              <th style={th}>Cost / click</th>
              <th style={th}>CTR</th>
              <th style={th}>Impressions</th>
              <th style={th}>Spend</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.name} style={{ borderTop: '1px solid var(--color-border)' }}>
                <td style={{ padding: '7px 10px', fontWeight: 500, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.name}>{r.name}</td>
                {describe && <td style={{ padding: '7px 10px', fontWeight: 600 }}>{describe(r.name)}</td>}
                <td style={td}>{num(r.leads)}</td>
                <td style={td}>{money2(r.cpl)}</td>
                <td style={td}>{pct(r.leadRate)}</td>
                <td style={td}>{num(r.clicks)}</td>
                <td style={td}>{money2(r.cpc)}</td>
                <td style={td}>{pct(r.ctr)}</td>
                <td style={td}>{num(r.impressions)}</td>
                <td style={td}>{money(r.spend)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={describe ? 10 : 9} style={{ padding: 12, color: subtle }}>No ads.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const th = { textAlign: 'right', padding: '8px 10px', background: 'var(--color-surface)' } as const;
const td = { textAlign: 'right', padding: '7px 10px' } as const;
