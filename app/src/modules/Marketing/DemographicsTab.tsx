import { useMemo, useState } from 'react';
import { useFbDemographics, type FbDemographic } from '../../lib/marketing/facebook';
import { useAllOrders, type Order } from '../../lib/orders';

const subtle = 'var(--color-ink-subtle)';
const muted = 'var(--color-ink-muted)';

// Meta demographic breakdowns (age × gender) per product set, from the
// lead/purchase conversions. Three sets:
//   • Sharpei Waitlist — Leads
//   • LILA Mini        — Leads / Purchases (Shopline funnel)
//   • LILA Pro         — Purchases (the Dec-2025 → Summer-Pre-Order sale campaigns)
// Location: for LILA Pro we pull country / province / city from the actual
// Shopify sales (every sale carries all three), split into a Canada-provinces
// pie and a US-states pie. Sharpei/Mini keep Meta's country breakdown.
//
// Charts: SVG donuts. Identity uses the validated categorical palette in fixed
// order (extras fold into a grey "Other"); age uses a sequential blue ramp since
// it's ordinal (young → old = light → dark). Every donut ships a legend so
// identity is never colour-alone.

type SetKey = 'sharpei' | 'mini' | 'pro';
type Metric = 'leads' | 'purchases';
type Entry = { label: string; value: number };

/** Classify a Meta campaign into a product set (null = excluded / pre-2025). */
function setOf(name: string): SetKey | null {
  const n = name.toLowerCase();
  if (/sharpei|waitlist/.test(n)) return 'sharpei';
  if (/\bmini\b/.test(n)) return 'mini';
  if (/december|holiday|xmas|christmas|winter|march|spring|summer|pre[\s-]?order/.test(n)) return 'pro';
  return null;
}

const AGE_ORDER = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'];
const AGE_MID: Record<string, number> = {
  '13-17': 15, '18-24': 21, '25-34': 29.5, '35-44': 39.5, '45-54': 49.5, '55-64': 59.5, '65+': 70,
};
// Validated categorical palette (fixed order). "Other"/"Unknown" → grey.
const CAT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const GREY = '#b8b6ae';
const catColor = (label: string, i: number) => (/^(other|unknown)$/i.test(label) ? GREY : CAT[i % CAT.length]);
// Age uses the same distinct categorical hues, one per bucket (not shades of blue).
const ageColor = (label: string) => { const i = AGE_ORDER.indexOf(label); return i >= 0 ? CAT[i % CAT.length] : GREY; };

const gender = (g: string) => (g && g.toLowerCase() !== 'unknown' ? g.charAt(0).toUpperCase() + g.slice(1).toLowerCase() : 'Unknown');
const country = (c: string) => (c === 'US' ? 'United States' : c === 'CA' ? 'Canada' : c || 'Unknown');

// Province/state code → full name, for "Ontario (ON)" style pie labels.
const REGION_NAME: Record<string, string> = {
  // Canada
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories',
  NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec',
  SK: 'Saskatchewan', YT: 'Yukon',
  // United States
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
function regionLabel(code: string): string {
  const name = REGION_NAME[code];
  return name ? `${name} (${code})` : code;
}
const val = (d: FbDemographic, m: Metric) => ((m === 'leads' ? d.leads : d.purchases) ?? 0);

function groupSum(rows: FbDemographic[], key: (d: FbDemographic) => string, m: Metric): Entry[] {
  const map = new Map<string, number>();
  for (const d of rows) map.set(key(d), (map.get(key(d)) ?? 0) + val(d, m));
  return Array.from(map.entries()).map(([label, value]) => ({ label, value })).filter(e => e.value > 0);
}

/** Weighted average age from the age buckets, or null. */
function averageAge(entries: Entry[]): number | null {
  let sum = 0, n = 0;
  for (const e of entries) {
    const mid = AGE_MID[e.label];
    if (mid == null) continue;
    sum += mid * e.value; n += e.value;
  }
  return n > 0 ? sum / n : null;
}

/** Count orders by key (blank keys skipped), biggest first. */
function countBy(orders: Order[], key: (o: Order) => string): Entry[] {
  const m = new Map<string, number>();
  for (const o of orders) {
    const k = key(o);
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return Array.from(m.entries()).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

/** Keep the biggest slices; fold the rest (too many, or below minShare) into
 *  "Other" so a pie never turns into confetti. Assumes entries are sorted desc. */
function foldOther(entries: Entry[], maxSlices = 6, minShare = 0.03): Entry[] {
  const total = entries.reduce((s, e) => s + e.value, 0);
  if (total === 0) return [];
  const kept: Entry[] = [];
  let other = 0;
  for (const e of entries) {
    if (kept.length < maxSlices && e.value / total >= minShare) kept.push(e);
    else other += e.value;
  }
  if (other > 0) kept.push({ label: 'Other', value: other });
  return kept;
}

/** Turn province/state codes into "Full Name (CODE)" pie labels; keep "Other". */
function labelRegions(entries: Entry[]): Entry[] {
  return entries.map(e => ({ label: e.label === 'Other' ? 'Other' : regionLabel(e.label), value: e.value }));
}

export function DemographicsTab() {
  const { demographics, loading } = useFbDemographics();
  const { orders } = useAllOrders();
  const [set, setSet] = useState<SetKey>('pro');
  const [miniMetric, setMiniMetric] = useState<Metric>('purchases');

  const metric: Metric = set === 'sharpei' ? 'leads' : set === 'pro' ? 'purchases' : miniMetric;

  const { total, byGender, byAge, byCountry, avgAge } = useMemo(() => {
    const rows = demographics.filter(d => setOf(d.campaign_name ?? '') === set);
    const ag = rows.filter(d => d.age !== 'all' && d.gender !== 'all');
    const geo = rows.filter(d => d.country !== 'all');
    const total = ag.reduce((s, d) => s + val(d, metric), 0);
    const byGender = groupSum(ag, d => gender(d.gender), metric).sort((a, b) => b.value - a.value);
    const byAge = groupSum(ag, d => d.age, metric)
      .sort((a, b) => (AGE_ORDER.indexOf(a.label) - AGE_ORDER.indexOf(b.label)) || (b.value - a.value));
    const byCountry = groupSum(geo, d => country(d.country), metric).sort((a, b) => b.value - a.value);
    return { total, byGender, byAge, byCountry, avgAge: averageAge(byAge) };
  }, [demographics, set, metric]);

  // LILA Pro location from the actual Shopify sales — Canada provinces + US
  // states in separate pies, and top cities split by country ("Richmond Hill, ON").
  const saleLoc = useMemo(() => {
    const sales = orders.filter(o => o.kind !== 'replacement');
    const ca = sales.filter(o => o.country === 'CA');
    const us = sales.filter(o => o.country === 'US');
    const cityLabel = (o: Order) => (o.city ? (o.region_state ? `${o.city}, ${o.region_state}` : o.city) : '');
    return {
      total: sales.length,
      byCountry: foldOther(countBy(sales, o => country(o.country ?? '')), 5, 0),
      caProvinces: labelRegions(foldOther(countBy(ca, o => o.region_state ?? ''), 6, 0.03)),
      usStates: labelRegions(foldOther(countBy(us, o => o.region_state ?? ''), 6, 0.03)),
      citiesCA: countBy(ca, cityLabel).slice(0, 10),
      citiesUS: countBy(us, cityLabel).slice(0, 10),
      caTotal: ca.length, usTotal: us.length,
    };
  }, [orders]);

  const metricLabel = metric === 'leads' ? 'Leads' : 'Purchases';
  const topLoc = set === 'pro' ? saleLoc.byCountry[0] : byCountry[0];
  const locTotal = set === 'pro' ? saleLoc.total : total;

  if (loading) return <p style={{ color: subtle, fontSize: 13 }}>Loading demographics…</p>;

  return (
    <div>
      {/* Set tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid var(--color-border)', marginBottom: 16 }}>
        {([['sharpei', 'Sharpei Waitlist'], ['mini', 'LILA Mini'], ['pro', 'LILA Pro']] as [SetKey, string][]).map(([k, label]) => (
          <button key={k} onClick={() => setSet(k)}
            style={{
              padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none', background: 'none',
              color: set === k ? 'var(--color-crimson)' : 'var(--color-ink-muted)',
              borderBottom: `2px solid ${set === k ? 'var(--color-crimson)' : 'transparent'}`, marginBottom: -2,
            }}>{label}</button>
        ))}
      </div>

      {set === 'mini' && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
          {(['leads', 'purchases'] as Metric[]).map(m => (
            <button key={m} onClick={() => setMiniMetric(m)}
              style={{
                padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', borderRadius: 6,
                border: '1px solid var(--color-border)',
                background: miniMetric === m ? 'var(--color-crimson)' : 'var(--color-surface)',
                color: miniMetric === m ? '#fff' : 'var(--color-ink-muted)',
              }}>{m === 'leads' ? 'Leads' : 'Purchases'}</button>
          ))}
        </div>
      )}

      {total === 0 ? (
        <p style={{ color: subtle, fontSize: 13 }}>
          No {metricLabel.toLowerCase()} demographics for this set yet. Run <strong>Sync All Sources</strong> (the "Ad demographics" line) —
          this needs Meta to be tracking {metric} conversions on these campaigns.
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
            <Stat label={`Total ${metricLabel.toLowerCase()}`} value={total.toLocaleString()} />
            <Stat label="Top gender" value={byGender[0] ? `${byGender[0].label} · ${pct(byGender[0].value, total)}` : '—'} />
            <Stat label="Average age" value={avgAge != null ? `~${Math.round(avgAge)}` : '—'} />
            <Stat label="Top location" value={topLoc ? `${topLoc.label} · ${pct(topLoc.value, locTotal)}` : '—'} />
          </div>

          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <PieCard title="By gender" entries={byGender} colorFor={catColor} center={{ main: total.toLocaleString(), sub: metricLabel.toLowerCase() }} />
            <PieCard title="By age" entries={byAge} colorFor={(l) => ageColor(l)}
              center={{ main: avgAge != null ? `~${Math.round(avgAge)}` : '—', sub: 'avg age' }} />
            {set === 'pro' ? (
              <>
                <PieCard title="By country" entries={saleLoc.byCountry} colorFor={catColor} center={{ main: saleLoc.total.toLocaleString(), sub: 'sales' }} />
                <PieCard title="Canada — by province" entries={saleLoc.caProvinces} colorFor={catColor} center={{ main: saleLoc.caTotal.toLocaleString(), sub: 'CA sales' }} />
                <PieCard title="US — by state" entries={saleLoc.usStates} colorFor={catColor} center={{ main: saleLoc.usTotal.toLocaleString(), sub: 'US sales' }} />
                <TopList title="Top cities — Canada" entries={saleLoc.citiesCA} total={saleLoc.caTotal} />
                <TopList title="Top cities — US" entries={saleLoc.citiesUS} total={saleLoc.usTotal} />
              </>
            ) : (
              <PieCard title="By location" entries={byCountry} colorFor={catColor} center={{ main: total.toLocaleString(), sub: metricLabel.toLowerCase() }} />
            )}
          </div>

          <div style={{ fontSize: 11, color: muted, marginTop: 16 }}>
            Age &amp; gender are {metricLabel.toLowerCase()} attributed by Meta to this set's campaigns (percent of total {metricLabel.toLowerCase()});
            average age is a weighted midpoint of the age buckets. Small slices fold into “Other.”{' '}
            {set === 'pro'
              ? `Location comes from your ${saleLoc.total.toLocaleString()} Shopify sales — split into Canada provinces and US states (percent of that country's sales).`
              : 'Location is country-level (Meta’s demographic breakdown).'}
          </div>
        </>
      )}
    </div>
  );
}

function pct(value: number, total: number): string {
  return total > 0 ? `${((value / total) * 100).toFixed(0)}%` : '—';
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: '10px 14px', minWidth: 130 }}>
      <div style={{ fontSize: 11, color: subtle }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2, letterSpacing: '-0.3px' }}>{value}</div>
    </div>
  );
}

/** SVG donut + legend. `colorFor(label, index)` assigns each slice its colour. */
function PieCard({ title, entries, colorFor, center }: {
  title: string;
  entries: Entry[];
  colorFor: (label: string, i: number) => string;
  center?: { main: string; sub?: string };
}) {
  const total = entries.reduce((s, e) => s + e.value, 0);
  const R = 52, T = 22, C = 2 * Math.PI * R;      // ring radius + thickness
  const gap = entries.length > 1 ? 3 : 0;          // px gap between slices
  let acc = 0;
  const slices = entries.map((e, i) => {
    const f = total > 0 ? e.value / total : 0;
    const slice = { color: colorFor(e.label, i), dash: Math.max(0, f * C - gap), offset: -acc * C, label: e.label, value: e.value };
    acc += f;
    return slice;
  });

  return (
    <div style={{ flex: '0 0 auto', minWidth: 210, border: '1px solid var(--color-border)', borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{title}</div>
      {total === 0 ? (
        <div style={{ fontSize: 12, color: subtle, padding: '18px 0' }}>No data yet</div>
      ) : (
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <svg viewBox="0 0 140 140" width={128} height={128} role="img" aria-label={title}>
            <g transform="rotate(-90 70 70)">
              {slices.map((s, i) => (
                <circle key={i} cx={70} cy={70} r={R} fill="none" stroke={s.color} strokeWidth={T}
                  strokeDasharray={`${s.dash} ${C}`} strokeDashoffset={s.offset} />
              ))}
            </g>
            {center && (
              <>
                <text x={70} y={center.sub ? 66 : 74} textAnchor="middle" style={{ fontSize: 22, fontWeight: 700, fill: 'currentColor' }}>{center.main}</text>
                {center.sub && <text x={70} y={84} textAnchor="middle" style={{ fontSize: 11, fill: muted }}>{center.sub}</text>}
              </>
            )}
          </svg>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 96 }}>
            {slices.map((s, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <span style={{ width: 11, height: 11, borderRadius: 3, background: s.color, flex: '0 0 auto' }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.label}>{s.label}</span>
                <span style={{ color: muted, fontVariantNumeric: 'tabular-nums' }}>{pct(s.value, total)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Compact ranked list — for cities, which are too fragmented for a pie. */
function TopList({ title, entries, total }: { title: string; entries: Entry[]; total: number }) {
  return (
    <div style={{ flex: '0 0 auto', minWidth: 200, border: '1px solid var(--color-border)', borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>{title}</div>
      {entries.length === 0 && <div style={{ fontSize: 12, color: subtle }}>—</div>}
      {entries.map(e => (
        <div key={e.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6, gap: 10 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.label}>{e.label}</span>
          <span style={{ color: muted, flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' }}>{e.value.toLocaleString()} · {pct(e.value, total)}</span>
        </div>
      ))}
    </div>
  );
}
