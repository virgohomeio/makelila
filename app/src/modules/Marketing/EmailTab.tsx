import { useMemo, useState } from 'react';
import { useKlaviyoCampaigns, type KlaviyoCampaign } from '../../lib/marketing/klaviyo';

const subtle = 'var(--color-ink-subtle)';

const RANGES = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 60 days', days: 60 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 180 days', days: 180 },
  { label: 'Last 365 days', days: 365 },
  { label: 'All time', days: 0 },
];

const pct   = (n: number | null) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`);
const num   = (n: number | null) => (n == null ? '—' : n.toLocaleString());
const money = (n: number | null) => (n == null ? '—' : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const day   = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-CA', { dateStyle: 'medium' }) : '—');

// Weighted average of a per-campaign rate, weighted by recipients (so a big send
// counts more than a tiny one). Falls back to a plain mean if no recipients.
function weightedRate(rows: KlaviyoCampaign[], rate: (c: KlaviyoCampaign) => number | null): number | null {
  let wSum = 0, w = 0, plainSum = 0, plainN = 0;
  for (const c of rows) {
    const r = rate(c);
    if (r == null) continue;
    plainSum += r; plainN++;
    const rec = c.recipients ?? 0;
    if (rec > 0) { wSum += r * rec; w += rec; }
  }
  if (w > 0) return wSum / w;
  return plainN > 0 ? plainSum / plainN : null;
}

export function EmailTab() {
  const { campaigns, loading } = useKlaviyoCampaigns();
  const [days, setDays] = useState(365);

  const filtered = useMemo(() => {
    const cutoff = days ? Date.now() - days * 86_400_000 : 0;
    // Undated campaigns can't be placed in a window, so exclude them from a
    // bounded range (they still show under "All time").
    const inRange = days
      ? campaigns.filter(c => c.send_time && new Date(c.send_time).getTime() >= cutoff)
      : [...campaigns];
    // Most recently sent at the top (undated last).
    return inRange.sort((a, b) => (b.send_time ?? '').localeCompare(a.send_time ?? ''));
  }, [campaigns, days]);

  const totals = useMemo(() => {
    const sent = filtered.reduce((s, c) => s + (c.recipients ?? 0), 0);
    const revenue = filtered.reduce((s, c) => s + (c.revenue ?? 0), 0);
    const orders = filtered.reduce((s, c) => s + (c.conversions ?? 0), 0);
    return {
      count: filtered.length,
      sent,
      revenue,
      orders,
      openRate: weightedRate(filtered, c => c.open_rate),
      clickRate: weightedRate(filtered, c => c.click_rate),
    };
  }, [filtered]);

  if (loading) return <p style={{ color: subtle, fontSize: 13 }}>Loading email campaigns…</p>;
  if (campaigns.length === 0) return (
    <p style={{ color: subtle, fontSize: 13 }}>
      No email campaign data yet. Click <strong>Sync All Sources</strong> (or the Sync tab) to pull Klaviyo campaign performance.
    </p>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <select value={days} onChange={e => setDays(Number(e.target.value))}
                style={{ padding: '6px 10px', fontSize: 13, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm, 6px)' }}>
          {RANGES.map(r => <option key={r.days} value={r.days}>{r.label}</option>)}
        </select>
        <span style={{ fontSize: 11, color: subtle }}>{filtered.length} campaign{filtered.length === 1 ? '' : 's'} in range</span>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <Stat label="Campaigns" value={num(totals.count)} />
        <Stat label="Emails sent" value={num(totals.sent)} />
        <Stat label="Avg open rate" value={pct(totals.openRate)} />
        <Stat label="Avg click rate" value={pct(totals.clickRate)} />
        <Stat label="Attributed revenue" value={money(totals.revenue)} />
        <Stat label="Orders" value={num(totals.orders)} />
      </div>

      <div style={{ overflowX: 'auto', border: '1px solid var(--color-border)', borderRadius: 8 }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%', whiteSpace: 'nowrap' }}>
          <thead>
            <tr style={{ color: subtle, fontSize: 11 }}>
              <th style={left}>Campaign</th>
              <th style={left}>Sent</th>
              <th style={right}>Recipients</th>
              <th style={right}>Open rate</th>
              <th style={right}>Click rate</th>
              <th style={right}>Orders</th>
              <th style={right}>Revenue</th>
              <th style={right}>Unsub rate</th>
              <th style={right}>Bounce rate</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(c => (
              <tr key={c.campaign_id} style={{ borderTop: '1px solid var(--color-border)' }}>
                <td style={{ padding: '7px 10px', fontWeight: 500, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }} title={c.name ?? c.campaign_id}>
                  {c.name ?? c.campaign_id}
                </td>
                <td style={{ padding: '7px 10px', color: subtle }}>{day(c.send_time)}</td>
                <td style={td}>{num(c.recipients)}</td>
                <td style={td}>{pct(c.open_rate)}</td>
                <td style={td}>{pct(c.click_rate)}</td>
                <td style={td}>{num(c.conversions)}</td>
                <td style={td}>{money(c.revenue)}</td>
                <td style={td}>{pct(c.unsubscribe_rate)}</td>
                <td style={td}>{pct(c.bounce_rate)}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={9} style={{ padding: 12, color: subtle }}>No campaigns sent in this window.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 11, color: subtle, marginTop: 8 }}>
        Open/click rates are recipient-weighted averages. Revenue is Klaviyo "Placed Order" value attributed to each campaign over the last 12 months.
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: '10px 14px', minWidth: 120 }}>
      <div style={{ fontSize: 11, color: subtle }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.3px' }}>{value}</div>
    </div>
  );
}

const left  = { textAlign: 'left', padding: '8px 10px', background: 'var(--color-surface)' } as const;
const right = { textAlign: 'right', padding: '8px 10px', background: 'var(--color-surface)' } as const;
const td    = { textAlign: 'right', padding: '7px 10px' } as const;
