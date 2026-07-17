import type { FbCampaign } from './facebook';

// The operator's curated sale "campaigns" — each is a GROUP of many Meta ad
// campaigns. We classify each Meta campaign into one group by keyword, take the
// earliest start in the group as its window start, and parse the discount out of
// the campaign name (e.g. "…30% off…" → "30% Off"). Order in the Journey Report
// is chronological (piled: each group runs until the next group starts).

// Order matters — more specific patterns first so "Late Spring" doesn't fall
// into "Spring", and "Mini" doesn't fall into "Pre-Launch".
const GROUP_DEFS: { key: string; name: string; match: RegExp }[] = [
  { key: 'mini',       name: 'Mini - Test/Pre-Launch',     match: /\bmini\b/i },
  { key: 'summer',     name: 'Summer Pre Order 2026',      match: /summer|pre[\s-]?order/i },
  { key: 'latespring', name: 'Late Spring Sale (v2) 2026', match: /late[\s-]?spring|spring[^a-z]*(v ?2|version 2)|\bv2\b/i },
  { key: 'spring',     name: 'Spring Sale 2026',           match: /spring/i },
  { key: 'march',      name: 'March Sale 2026',            match: /march/i },
  { key: 'winter',     name: 'Winter Sale 2026',           match: /winter/i },
  { key: 'december',   name: 'December Holiday 2025',      match: /december|holiday|christmas|xmas/i },
  { key: 'sharpei',    name: 'Sharpei Waitlist',           match: /sharpei|waitlist/i },
  { key: 'prepro',     name: 'Pre Pro Launch',             match: /pre[\s-]?pro|pro[\s-]?launch|pre[\s-]?launch/i },
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
  ids: Set<string>;       // Meta campaign_ids in this group
  startMs: number;        // earliest Meta start in the group
  endMs: number;          // next group's start (Infinity for the latest)
};

/** Build the ordered, piled campaign groups from the synced Meta campaigns. */
export function buildCampaignGroups(campaigns: FbCampaign[]): CampaignGroup[] {
  const acc = new Map<string, { name: string; startMs: number; ids: Set<string>; discount: string | null }>();
  for (const c of campaigns) {
    const name = c.campaign_name ?? '';
    const def = GROUP_DEFS.find(g => g.match.test(name));
    if (!def) continue;
    const startIso = c.metrics?.campaign_start ?? c.date_start ?? null;
    const startMs = startIso ? new Date(startIso).getTime() : NaN;
    const g = acc.get(def.key) ?? { name: def.name, startMs: Infinity, ids: new Set<string>(), discount: null };
    if (isFinite(startMs)) g.startMs = Math.min(g.startMs, startMs);
    if (c.campaign_id) g.ids.add(c.campaign_id);
    if (!g.discount) g.discount = parseDiscount(name);
    acc.set(def.key, g);
  }
  const list = Array.from(acc.entries())
    .map(([key, g]) => ({ key, ...g }))
    .filter(g => isFinite(g.startMs))
    .sort((a, b) => a.startMs - b.startMs);
  return list.map((g, i) => ({
    key: g.key,
    label: g.discount ? `${g.name} - ${g.discount}` : g.name,
    ids: g.ids,
    startMs: g.startMs,
    endMs: list[i + 1]?.startMs ?? Infinity,
  }));
}
