import type { FbCampaign } from './facebook';

// The four operator-facing campaign TYPES (a different axis from the sale
// windows in campaignGroups.ts). Every Meta ad campaign is classified into
// exactly one, by keyword on its name, so the dashboard can show spend +
// revenue per type:
//   1. Revenue campaigns     — the Sale / Pre-Order / Holiday purchase campaigns
//   2. LILA Mini reservation — "Mini - ..." reservation / sign-up campaigns
//   3. Sharpei leads         — "Sharpei - Set N - To Lead Gen Form" lead-gen
//   4. Pre-Pedrum campaigns  — legacy "Pre-launch_Lila_Optimization_*" campaigns
//
// Classification is by PRECEDENCE (most specific first); "Revenue" is the
// catch-all so a new sale campaign lands there automatically.

export type CampaignTypeKey = 'revenue' | 'mini' | 'sharpei' | 'prepedrum';

export type CampaignTypeSummary = {
  key: CampaignTypeKey;
  label: string;
  blurb: string;
  goal: 'revenue' | 'leads';   // which secondary metric matters
  spend: number;
  revenue: number;
  purchases: number;
  leads: number;
  roas: number | null;         // revenue ÷ spend (null when no spend)
  campaigns: number;
};

const DEFS: {
  key: CampaignTypeKey; label: string; blurb: string;
  goal: 'revenue' | 'leads'; match: RegExp;
}[] = [
  { key: 'sharpei',   label: 'Sharpei leads',         blurb: 'Lead-gen form campaigns',               goal: 'leads',   match: /sharpei/i },
  { key: 'mini',      label: 'LILA Mini reservation', blurb: 'Mini reservations / landing-page signups', goal: 'leads',   match: /\bmini\b/i },
  { key: 'prepedrum', label: 'Pre-Pedrum campaigns',  blurb: 'Legacy pre-launch optimization campaigns', goal: 'revenue', match: /pre[\s_-]?launch/i },
  { key: 'revenue',   label: 'Revenue campaigns',     blurb: 'Sale / pre-order purchase campaigns',   goal: 'revenue', match: /.*/ }, // catch-all — keep LAST
];

// Fixed display order the operator asked for.
const ORDER: CampaignTypeKey[] = ['revenue', 'mini', 'sharpei', 'prepedrum'];

/** Classify one Meta campaign name into its type (first matching def wins). */
export function classifyCampaign(name: string): CampaignTypeKey {
  return (DEFS.find(d => d.match.test(name)) ?? DEFS[DEFS.length - 1]).key;
}

/** Roll Meta campaigns up into the four types, summing spend + revenue each.
 *  Returned in the operator's fixed display order. */
export function summarizeCampaignTypes(campaigns: FbCampaign[]): CampaignTypeSummary[] {
  const acc = new Map<CampaignTypeKey, CampaignTypeSummary>(
    DEFS.map(d => [d.key, {
      key: d.key, label: d.label, blurb: d.blurb, goal: d.goal,
      spend: 0, revenue: 0, purchases: 0, leads: 0, roas: null, campaigns: 0,
    }]),
  );
  for (const c of campaigns) {
    const s = acc.get(classifyCampaign(c.campaign_name ?? ''))!;
    s.spend += c.spend_cad ?? 0;
    s.revenue += c.metrics?.website_purchases_value ?? 0;
    s.purchases += c.metrics?.website_purchases ?? 0;
    s.leads += c.leads ?? 0;
    s.campaigns += 1;
  }
  for (const s of acc.values()) s.roas = s.spend ? s.revenue / s.spend : null;
  return ORDER.map(k => acc.get(k)!);
}
