import type { CSSProperties } from 'react';
import type { FbCampaign } from '../../lib/marketing/facebook';

// Full Ads-Manager column set for the Campaigns tab. Wide table → horizontal
// scroll; the campaign-name column is sticky-left so it stays visible.

const subtle = 'var(--color-ink-subtle)';

const money  = (n: number | null | undefined) => (n == null ? '—' : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const money2 = (n: number | null | undefined) => (n == null ? '—' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct    = (n: number | null | undefined) => (n == null ? '—' : `${n.toFixed(2)}%`);
const num    = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString());
const freq   = (n: number | null | undefined) => (n == null ? '—' : n.toFixed(2));
const text   = (s: string | null | undefined) => (s == null || s === '' ? '—' : s);

type Col = { label: string; get: (c: FbCampaign) => string; align?: 'left' | 'right' };

const COLS: Col[] = [
  { label: 'Delivery',              get: c => text(c.metrics?.delivery) },
  { label: 'Budget',                get: c => text(c.metrics?.budget) },
  { label: 'Amount spent',          get: c => money(c.spend_cad), align: 'right' },
  { label: 'Results',               get: c => num(c.metrics?.results), align: 'right' },
  { label: 'Cost per result',       get: c => money2(c.metrics?.cost_per_result), align: 'right' },
  { label: 'Result rate',           get: c => pct(c.metrics?.result_rate), align: 'right' },
  { label: 'Adds to cart',          get: c => num(c.metrics?.adds_to_cart), align: 'right' },
  { label: 'Adds of payment info',  get: c => num(c.metrics?.add_payment_info), align: 'right' },
  { label: 'Checkouts initiated',   get: c => num(c.metrics?.checkouts_initiated), align: 'right' },
  { label: 'Clicks (all)',          get: c => num(c.clicks), align: 'right' },
  { label: 'CTR (all)',             get: c => pct(c.metrics?.ctr), align: 'right' },
  { label: 'Reach',                 get: c => num(c.reach), align: 'right' },
  { label: 'Impressions',           get: c => num(c.impressions), align: 'right' },
  { label: 'Leads',                 get: c => num(c.leads), align: 'right' },
  { label: 'Post comments',         get: c => num(c.metrics?.post_comments), align: 'right' },
  { label: 'Post reactions',        get: c => num(c.metrics?.post_reactions), align: 'right' },
  { label: 'Post shares',           get: c => num(c.metrics?.post_shares), align: 'right' },
  { label: 'Facebook likes',        get: c => num(c.metrics?.page_likes), align: 'right' },
  { label: 'Post saves',            get: c => num(c.metrics?.post_saves), align: 'right' },
  { label: 'Website purchases',     get: c => num(c.metrics?.website_purchases), align: 'right' },
  { label: 'Bid strategy',          get: c => text(c.metrics?.bid_strategy) },
  { label: 'Frequency',             get: c => freq(c.metrics?.frequency), align: 'right' },
  { label: 'Start date',            get: c => text(c.metrics?.campaign_start) },
  { label: 'End date',              get: c => text(c.metrics?.campaign_end) },
  { label: 'CPM',                   get: c => money2(c.metrics?.cpm), align: 'right' },
  { label: 'Attribution',           get: c => text(c.metrics?.attribution_setting) },
  { label: '3-sec video plays',     get: c => num(c.metrics?.video_3s), align: 'right' },
  { label: '75% video plays',       get: c => num(c.metrics?.video_p75), align: 'right' },
  { label: '100% video plays',      get: c => num(c.metrics?.video_p100), align: 'right' },
  { label: 'Link clicks',           get: c => num(c.metrics?.link_clicks), align: 'right' },
  { label: 'Landing page views',    get: c => num(c.metrics?.landing_page_views), align: 'right' },
];

const stickyName: CSSProperties = {
  position: 'sticky', left: 0, zIndex: 1, background: '#fff',
  maxWidth: 240, minWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  borderRight: '1px solid var(--color-border)',
};

export function CampaignsTable({ campaigns }: { campaigns: FbCampaign[] }) {
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--color-border)', borderRadius: 8 }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12, whiteSpace: 'nowrap' }}>
        <thead>
          <tr style={{ color: subtle, fontSize: 11 }}>
            <th style={{ ...stickyName, textAlign: 'left', padding: '8px 10px', background: 'var(--color-surface)', zIndex: 2 }}>Campaign</th>
            {COLS.map(col => (
              <th key={col.label} style={{ textAlign: col.align ?? 'left', padding: '8px 10px', background: 'var(--color-surface)' }}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {campaigns.map(c => (
            <tr key={c.campaign_id + c.date_start} style={{ borderTop: '1px solid var(--color-border)' }}>
              <td style={{ ...stickyName, padding: '7px 10px', fontWeight: 500 }} title={c.campaign_name}>{c.campaign_name}</td>
              {COLS.map(col => (
                <td key={col.label} style={{ textAlign: col.align ?? 'left', padding: '7px 10px' }}>
                  {col.get(c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
