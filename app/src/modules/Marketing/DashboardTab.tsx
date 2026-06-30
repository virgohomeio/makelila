import { useMemo, type CSSProperties } from 'react';
import { useFbCampaigns } from '../../lib/marketing/facebook';
import { useKlaviyoSyncStatus } from '../../lib/marketing/klaviyo';
import { useCacByChannel } from '../../lib/marketing/cac';
import { useAcquisitionOverview } from '../../lib/marketing/journey';

const subtle = 'var(--color-ink-subtle)';
const muted = 'var(--color-ink-muted)';

// Marketing overview: one screen rolling up every channel — paid (Meta ads),
// acquisition mix, CAC, and email-sync health. Renders gracefully when a source
// has no data yet (the Meta/Klaviyo pulls aren't wired in prod), surfacing a
// clear "not synced yet" hint instead of blank zeros.
export function DashboardTab() {
  const { campaigns, loading: campsLoading } = useFbCampaigns(180);
  const { rows: cac, loading: cacLoading } = useCacByChannel();
  const { rows: acq, loading: acqLoading } = useAcquisitionOverview();
  const { logs } = useKlaviyoSyncStatus(1);

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

  const topCampaigns = useMemo(
    () => [...campaigns].sort((a, b) => (b.spend_cad ?? 0) - (a.spend_cad ?? 0)).slice(0, 5),
    [campaigns],
  );

  const acqTotal = acq.reduce((s, r) => s + r.count, 0);
  const lastKlaviyo = logs[0]?.synced_at ? new Date(logs[0].synced_at).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }) : null;

  return (
    <div>
      {/* Paid-ads KPI row */}
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Paid ads (Meta) — last 180 days synced</div>
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
          <Tile label="Ad spend (CAD)" value={`$${ads.spend.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
          <Tile label="Impressions" value={ads.impressions.toLocaleString()} />
          <Tile label="Clicks" value={ads.clicks.toLocaleString()} sub={ads.ctr != null ? `${ads.ctr.toFixed(2)}% CTR` : undefined} />
          <Tile label="Leads" value={ads.leads.toLocaleString()} sub={ads.cpl != null ? `$${ads.cpl.toFixed(0)} CPL` : undefined} />
          <Tile label="Active campaigns" value={String(ads.active)} />
        </div>
      )}

      {ads.hasData && topCampaigns.length > 0 && (
        <div style={{ marginTop: 12, marginBottom: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Top campaigns by spend</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: subtle, fontSize: 11, textAlign: 'left' }}>
                <th style={{ paddingBottom: 6 }}>Campaign</th>
                <th style={{ textAlign: 'right' }}>Spend</th>
                <th style={{ textAlign: 'right' }}>Clicks</th>
                <th style={{ textAlign: 'right' }}>Leads</th>
                <th style={{ textAlign: 'right' }}>CPL</th>
              </tr>
            </thead>
            <tbody>
              {topCampaigns.map(c => (
                <tr key={c.campaign_id + c.date_start} style={{ borderTop: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '6px 0', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.campaign_name}</td>
                  <td style={{ textAlign: 'right' }}>{c.spend_cad != null ? `$${c.spend_cad.toFixed(0)}` : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{c.clicks?.toLocaleString() ?? '—'}</td>
                  <td style={{ textAlign: 'right' }}>{c.leads ?? '—'}</td>
                  <td style={{ textAlign: 'right' }}>{c.cpl_cad != null ? `$${c.cpl_cad.toFixed(0)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Acquisition mix */}
      <div style={{ fontSize: 13, fontWeight: 600, margin: '18px 0 8px' }}>Where customers come from (first touch)</div>
      {acqLoading ? (
        <p style={{ color: subtle, fontSize: 13 }}>Loading…</p>
      ) : acq.length === 0 ? (
        <p style={{ color: subtle, fontSize: 13 }}>No attribution captured yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
          {acq.map(r => (
            <div key={r.channel} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
              <span style={{ width: 130, color: muted }}>{r.channel}</span>
              <div style={{ flex: 1, background: 'var(--color-surface)', borderRadius: 4, overflow: 'hidden', height: 16 }}>
                <div style={{ width: `${acqTotal ? (r.count / acqTotal) * 100 : 0}%`, background: 'var(--color-crimson)', height: '100%' }} />
              </div>
              <span style={{ width: 64, textAlign: 'right' }}>{r.count} <span style={{ color: subtle }}>({acqTotal ? Math.round((r.count / acqTotal) * 100) : 0}%)</span></span>
            </div>
          ))}
        </div>
      )}

      {/* CAC by channel */}
      <div style={{ fontSize: 13, fontWeight: 600, margin: '18px 0 8px' }}>Cost per acquisition by channel</div>
      {cacLoading ? (
        <p style={{ color: subtle, fontSize: 13 }}>Loading…</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 8 }}>
          <thead>
            <tr style={{ color: subtle, fontSize: 11, textAlign: 'left' }}>
              <th style={{ paddingBottom: 6 }}>Channel</th>
              <th style={{ textAlign: 'right' }}>Spend (CAD)</th>
              <th style={{ textAlign: 'right' }}>Customers</th>
              <th style={{ textAlign: 'right' }}>CAC</th>
            </tr>
          </thead>
          <tbody>
            {cac.map(r => (
              <tr key={r.channel} style={{ borderTop: '1px solid var(--color-border)' }}>
                <td style={{ padding: '6px 0' }}>{r.channel}</td>
                <td style={{ textAlign: 'right' }}>{r.spend_cad ? `$${r.spend_cad.toFixed(0)}` : '—'}</td>
                <td style={{ textAlign: 'right' }}>{r.customers_acquired}</td>
                <td style={{ textAlign: 'right' }}>{r.cac_cad != null ? `$${r.cac_cad.toFixed(0)}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Source health */}
      <div style={{ fontSize: 13, fontWeight: 600, margin: '18px 0 8px' }}>Data sources</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
        <SourceRow name="Meta Ads" ok={ads.hasData} detail={ads.hasData ? `${campaigns.length} campaign rows synced` : 'sync-facebook-ads not deployed yet'} />
        <SourceRow name="Klaviyo (email)" ok={!!lastKlaviyo} detail={lastKlaviyo ? `last profile sync ${lastKlaviyo}` : 'sync-klaviyo-profiles not deployed yet'} />
        <SourceRow name="Attribution (first touch)" ok={acqTotal > 0} detail={`${acqTotal} customers with a source`} />
        <SourceRow name="Organic social / Google Analytics" ok={false} detail="not integrated yet (roadmap)" />
      </div>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 6, padding: '8px 14px', minWidth: 120 }}>
      <div style={{ fontSize: 10, color: subtle, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: muted, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function SourceRow({ name, ok, detail }: { name: string; ok: boolean; detail: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: ok ? '#38a169' : '#cbd5e0', flexShrink: 0 }} />
      <span style={{ width: 220 }}>{name}</span>
      <span style={{ color: subtle }}>{detail}</span>
    </div>
  );
}

const notice: CSSProperties = {
  fontSize: 12, color: muted, background: 'var(--color-surface)',
  borderRadius: 6, padding: '10px 12px', marginBottom: 8, lineHeight: 1.5,
};
