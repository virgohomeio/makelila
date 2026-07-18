import type { FbCampaign } from './facebook';

// The operator's curated sale "campaigns" — each is a GROUP of many Meta ad
// campaigns. The DATE WINDOWS are hard-coded (operator-provided) because Meta's
// own start dates don't reliably reflect when each sale actually ran. Meta
// campaigns are still matched into each group by keyword to sum ad spend and to
// read the discount off the campaign name. Update the ranges here as new sales
// launch. Windows are contiguous, so every sale falls into exactly one.

// LILA Mini sells through Shopline/Smartpush, NOT Shopify — excluded from the
// Shopify (LILA Pro) Journey Report buckets.
const EXCLUDE = /\bmini\b/i;

// Precedence order (specific first) so "Late Spring" doesn't match "Spring".
// start/end are inclusive YYYY-MM-DD (end null = ongoing). discount is the
// fallback when the Meta campaign name doesn't carry one.
const DEFS: {
  key: string; name: string; match: RegExp;
  start: string; end: string | null; discount: string;
}[] = [
  { key: 'summer',     name: 'Summer Pre Order 2026',      match: /summer|pre[\s-]?order/i,                                    start: '2026-06-03', end: null,         discount: '25% Off' },
  { key: 'latespring', name: 'Late Spring Sale (v2) 2026', match: /late[\s-]?spring|spring[^a-z]*(v ?2|version 2)|\bv2\b/i,     start: '2026-05-11', end: '2026-06-02', discount: '20% Off' },
  { key: 'spring',     name: 'Spring Sale 2026',           match: /spring/i,                                                   start: '2026-04-01', end: '2026-05-10', discount: '30% Off' },
  { key: 'march',      name: 'March Sale 2026',            match: /march/i,                                                    start: '2026-03-01', end: '2026-03-31', discount: '10% Off' },
  { key: 'winter',     name: 'Winter Sale 2026',           match: /winter/i,                                                   start: '2026-01-01', end: '2026-02-28', discount: '30% Off' },
  { key: 'december',   name: 'December Holiday 2025',      match: /december|holiday|christmas|xmas/i,                          start: '2025-12-08', end: '2025-12-31', discount: '35% Off' },
];

/** Pull a human discount label out of a campaign name, if present. */
export function parseDiscount(name: string): string | null {
  const pct = name.match(/(\d{1,3})\s*%\s*off/i);
  if (pct) return `${pct[1]}% Off`;
  const dollar = name.match(/\$\s*(\d+)\s*off/i);
  if (dollar) return `$${dollar[1]} Off`;
  if (/\bbogo\b|buy\s*one/i.test(name)) return 'BOGO';
  if (/free\s*ship/i.test(name)) return 'Free Shipping';
  return null;
}

export type CampaignGroup = {
  key: string;
  label: string;          // "Winter Sale 2026 - 30% Off"
  ids: Set<string>;       // Meta campaign_ids in this group (for ad spend)
  startDate: string;      // inclusive YYYY-MM-DD
  endDate: string | null; // inclusive; null = ongoing
};

/** Build the fixed sale windows, attaching each group's matched Meta campaigns
 *  (for spend) and its discount (parsed off the campaign names, else fallback).
 *  Ordered chronologically by start. */
export function buildCampaignGroups(campaigns: FbCampaign[]): CampaignGroup[] {
  return DEFS.map(def => {
    const ids = new Set<string>();
    let parsed: string | null = null;
    for (const c of campaigns) {
      const name = c.campaign_name ?? '';
      if (EXCLUDE.test(name)) continue;
      // Assign to the first def it matches (precedence) so late-spring campaigns
      // don't also count toward spring.
      const firstDef = DEFS.find(d => d.match.test(name));
      if (firstDef?.key !== def.key) continue;
      if (c.campaign_id) ids.add(c.campaign_id);
      if (!parsed) parsed = parseDiscount(name);
    }
    const discount = parsed ?? def.discount;
    return {
      key: def.key,
      label: discount ? `${def.name} - ${discount}` : def.name,
      ids,
      startDate: def.start,
      endDate: def.end,
    };
  }).sort((a, b) => a.startDate.localeCompare(b.startDate));
}
