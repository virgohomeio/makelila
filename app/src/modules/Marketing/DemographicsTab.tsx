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
// Shopify sales (every sale carries all three) instead of Meta's country-only
// demographic breakdown. Sharpei/Mini keep Meta's country breakdown.

type SetKey = 'sharpei' | 'mini' | 'pro';
type Metric = 'leads' | 'purchases';

/** Classify a Meta campaign into a product set (null = excluded / pre-2025). */
function setOf(name: string): SetKey | null {
  const n = name.toLowerCase();
  if (/sharpei|waitlist/.test(n)) return 'sharpei';
  if (/\bmini\b/.test(n)) return 'mini';
  if (/december|holiday|xmas|christmas|winter|march|spring|summer|pre[\s-]?order/.test(n)) return 'pro';
  return null;
}

const AGE_ORDER = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'];
// Bucket midpoints for a weighted average age (65+ treated as ~70).
const AGE_MID: Record<string, number> = {
  '13-17': 15, '18-24': 21, '25-34': 29.5, '35-44': 39.5, '45-54': 49.5, '55-64': 59.5, '65+': 70,
};
const gender = (g: string) => (g && g.toLowerCase() !== 'unknown' ? g.charAt(0).toUpperCase() + g.slice(1).toLowerCase() : 'Unknown');
const country = (c: string) => (c === 'US' ? 'United States' : c === 'CA' ? 'Canada' : c || 'Unknown');
const val = (d: FbDemographic, m: Metric) => ((m === 'leads' ? d.leads : d.purchases) ?? 0);

type Entry = { label: string; value: number };

function groupSum(rows: FbDemographic[], key: (d: FbDemographic) => string, m: Metric): Entry[] {
  const map = new Map<string, number>();
  for (const d of rows) map.set(key(d), (map.get(key(d)) ?? 0) + val(d, m));
  return Array.from(map.entries()).map(([label, value]) => ({ label, value })).filter(e => e.value > 0);
}

/** Weighted average age from the age buckets, or null if none are known. */
function averageAge(entries: Entry[]): number | null {
  let sum = 0, n = 0;
  for (const e of entries) {
    const mid = AGE_MID[e.label];
    if (mid == null) continue;
    sum += mid * e.value;
    n += e.value;
  }
  return n > 0 ? sum / n : null;
}

/** Count orders by an arbitrary key (blank keys skipped), biggest first. */
function countBy(orders: Order[], key: (o: Order) => string): Entry[] {
  const m = new Map<string, number>();
  for (const o of orders) {
    const k = key(o);
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return Array.from(m.entries()).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

export function DemographicsTab() {
  const { demographics, loading } = useFbDemographics();
  const { orders } = useAllOrders();
  const [set, setSet] = useState<SetKey>('pro');
  const [miniMetric, setMiniMetric] = useState<Metric>('purchases');

  const metric: Metric = set === 'sharpei' ? 'leads' : set === 'pro' ? 'purchases' : miniMetric;

  const { total, byGender, byAge, byCountry, avgAge } = useMemo(() => {
    const rows = demographics.filter(d => setOf(d.campaign_name ?? '') === set);
    // Two breakdown kinds share the table: age×gender rows (country='all') and
    // country rows (age/gender='all'). Split them so we never double-count.
    const ag = rows.filter(d => d.age !== 'all' && d.gender !== 'all');
    const geo = rows.filter(d => d.country !== 'all');
    const total = ag.reduce((s, d) => s + val(d, metric), 0);
    const byGender = groupSum(ag, d => gender(d.gender), metric).sort((a, b) => b.value - a.value);
    const byAge = groupSum(ag, d => d.age, metric)
      .sort((a, b) => (AGE_ORDER.indexOf(a.label) - AGE_ORDER.indexOf(b.label)) || (b.value - a.value));
    const byCountry = groupSum(geo, d => country(d.country), metric).sort((a, b) => b.value - a.value);
    return { total, byGender, byAge, byCountry, avgAge: averageAge(byAge) };
  }, [demographics, set, metric]);

  // LILA Pro location from the actual Shopify sales (country / province / city).
  const saleLoc = useMemo(() => {
    const sales = orders.filter(o => o.kind !== 'replacement');
    return {
      total: sales.length,
      byCountry: countBy(sales, o => country(o.country ?? '')),
      byProvince: countBy(sales, o => o.region_state ?? ''),
      byCity: countBy(sales, o => o.city ?? ''),
    };
  }, [orders]);

  const metricLabel = metric === 'leads' ? 'Leads' : 'Purchases';
  const topAge = byAge.slice().sort((a, b) => b.value - a.value)[0];
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

      {/* Mini has Leads / Purchases sub-views */}
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
            <Stat label="Top age" value={topAge ? `${topAge.label} · ${pct(topAge.value, total)}` : '—'} />
            <Stat label="Average age" value={avgAge != null ? `~${Math.round(avgAge)}` : '—'} />
            <Stat label="Top location" value={topLoc ? `${topLoc.label} · ${pct(topLoc.value, locTotal)}` : '—'} />
          </div>

          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <Breakdown title="By gender" entries={byGender} total={total} />
            <Breakdown title="By age" entries={byAge} total={total} footer={avgAge != null ? `Average age ~${Math.round(avgAge)}` : undefined} />
            {set === 'pro' ? (
              <>
                <Breakdown title="By country" entries={saleLoc.byCountry} total={saleLoc.total} />
                <Breakdown title="By province / state" entries={saleLoc.byProvince} total={saleLoc.total} />
                <Breakdown title="By city" entries={saleLoc.byCity.slice(0, 15)} total={saleLoc.total} />
              </>
            ) : (
              <Breakdown title="By location" entries={byCountry} total={total} />
            )}
          </div>

          <div style={{ fontSize: 11, color: muted, marginTop: 14 }}>
            Age &amp; gender are {metricLabel.toLowerCase()} attributed by Meta to this set's campaigns (percent of total {metricLabel.toLowerCase()});
            average age is a weighted midpoint of the age buckets.{' '}
            {set === 'pro'
              ? `Location is pulled from your ${saleLoc.total.toLocaleString()} Shopify sales — country, province/state, and city (percent of sales).`
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

function Breakdown({ title, entries, total, footer }: { title: string; entries: Entry[]; total: number; footer?: string }) {
  const max = Math.max(1, ...entries.map(e => e.value));
  return (
    <div style={{ flex: '1 1 240px', minWidth: 240, border: '1px solid var(--color-border)', borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>{title}</div>
      {entries.length === 0 && <div style={{ fontSize: 12, color: subtle }}>—</div>}
      {entries.map(e => (
        <div key={e.label} style={{ marginBottom: 9 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
            <span>{e.label}</span>
            <span style={{ color: muted }}>{e.value.toLocaleString()} · {pct(e.value, total)}</span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: 'var(--color-surface)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(e.value / max) * 100}%`, background: 'var(--color-crimson)', borderRadius: 3 }} />
          </div>
        </div>
      ))}
      {footer && <div style={{ fontSize: 11, color: subtle, marginTop: 4 }}>{footer}</div>}
    </div>
  );
}
