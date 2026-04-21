import { useMemo } from 'react';
import { useUnits, type Unit } from '../../lib/stock';
import styles from './PostShipment.module.css';

// Region detection: parse the trailing 2-letter province/state code from a
// location string like "Trenton, ON" or "Carson City, NV". Falls back to
// "??" if the string doesn't match the City, XX format.
const CA_PROVINCES = new Set([
  'AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT',
]);
const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN',
  'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV',
  'NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN',
  'TX','UT','VT','VA','WA','WV','WI','WY','DC',
]);

function parseRegion(loc: string | null | undefined): { code: string; country: 'CA' | 'US' | '??' } {
  if (!loc) return { code: '??', country: '??' };
  const trimmed = loc.trim();
  const tail = trimmed.split(',').pop()?.trim() ?? '';
  const code = tail.toUpperCase();
  if (CA_PROVINCES.has(code)) return { code, country: 'CA' };
  if (US_STATES.has(code)) return { code, country: 'US' };
  // Whole-string fallback — sometimes location is just "ON" or "BC" with
  // no city.
  const whole = trimmed.toUpperCase();
  if (CA_PROVINCES.has(whole)) return { code: whole, country: 'CA' };
  if (US_STATES.has(whole)) return { code: whole, country: 'US' };
  return { code: '??', country: '??' };
}

export function DeliveryMapTab() {
  const { units, loading } = useUnits();

  const shipped = useMemo(
    () => units.filter(u => u.status === 'shipped' && u.shipped_at !== null),
    [units],
  );

  const stats = useMemo(() => {
    const now = Date.now();
    const last7 = now - 7 * 86_400_000;
    const last30 = now - 30 * 86_400_000;
    const carriers = new Map<string, number>();
    const regions = new Map<string, { country: 'CA' | 'US' | '??'; count: number }>();
    let ca = 0, us = 0, unknown = 0, n7 = 0, n30 = 0;
    for (const u of shipped) {
      const r = parseRegion(u.location);
      if (r.country === 'CA') ca++;
      else if (r.country === 'US') us++;
      else unknown++;
      const cur = regions.get(r.code) ?? { country: r.country, count: 0 };
      cur.count++; cur.country = r.country;
      regions.set(r.code, cur);

      const c = u.carrier ?? 'Unknown';
      carriers.set(c, (carriers.get(c) ?? 0) + 1);

      const t = new Date(u.shipped_at!).getTime();
      if (t >= last7) n7++;
      if (t >= last30) n30++;
    }
    const carrierList = [...carriers.entries()].sort((a, b) => b[1] - a[1]);
    const regionList = [...regions.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([code, v]) => ({ code, ...v }));
    return { ca, us, unknown, n7, n30, total: shipped.length, carrierList, regionList };
  }, [shipped]);

  if (loading) return <div className={styles.loading}>Loading shipments…</div>;

  return (
    <div className={styles.tabContent}>
      <div className={styles.kpiRow}>
        <KPI label="Total shipped" value={stats.total} />
        <KPI label="Last 7 days" value={stats.n7} />
        <KPI label="Last 30 days" value={stats.n30} />
        <KPI label="Canada / US" value={`${stats.ca} / ${stats.us}`} />
      </div>

      <div className={styles.mapGrid}>
        <CarrierBar list={stats.carrierList} total={stats.total} />
        <RegionBar list={stats.regionList} total={stats.total} />
      </div>

      <RegionMap regions={stats.regionList} />
      <RecentShipments shipped={shipped} />
    </div>
  );
}

function KPI({ label, value }: { label: string; value: number | string }) {
  return (
    <div className={styles.kpi}>
      <div className={styles.kpiLabel}>{label}</div>
      <div className={styles.kpiValue}>{value}</div>
    </div>
  );
}

function CarrierBar({ list, total }: { list: [string, number][]; total: number }) {
  const palette = ['#2b6cb0', '#48bb78', '#d69e2e', '#9b2c2c', '#553c9a', '#718096'];
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>By Carrier</div>
      <div className={styles.cardBody}>
        {list.map(([name, n], i) => {
          const pct = total > 0 ? Math.round((n / total) * 100) : 0;
          return (
            <div key={name} className={styles.barRow}>
              <span className={styles.barLabel}>{name}</span>
              <div className={styles.barTrack}>
                <div
                  className={styles.barFill}
                  style={{ width: `${pct}%`, background: palette[i % palette.length] }}
                />
              </div>
              <span className={styles.barNum}>{n} <span className={styles.statPct}>{pct}%</span></span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RegionBar({ list, total }: { list: { code: string; country: 'CA' | 'US' | '??'; count: number }[]; total: number }) {
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>By Province / State</div>
      <div className={styles.cardBody}>
        {list.slice(0, 10).map(r => {
          const pct = total > 0 ? Math.round((r.count / total) * 100) : 0;
          const color = r.country === 'CA' ? '#CC2D30' : r.country === 'US' ? '#3C3B6E' : '#a0aec0';
          return (
            <div key={r.code} className={styles.barRow}>
              <span className={styles.barLabel}>
                <span className={styles.regionTag} style={{ background: color }}>{r.country}</span>
                {r.code}
              </span>
              <div className={styles.barTrack}>
                <div className={styles.barFill} style={{ width: `${pct}%`, background: color }} />
              </div>
              <span className={styles.barNum}>{r.count} <span className={styles.statPct}>{pct}%</span></span>
            </div>
          );
        })}
        {list.length > 10 && (
          <div className={styles.muted} style={{ fontSize: 10, marginTop: 6 }}>
            + {list.length - 10} more region{list.length - 10 === 1 ? '' : 's'}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Region map — simplified North America with rough province/state coords.
// Not cartographically accurate; intent is "where are units going" at a glance.
// ============================================================================
const REGION_XY: Record<string, [number, number]> = {
  // Canadian provinces
  'BC': [120, 95],  'AB': [180, 110], 'SK': [220, 115], 'MB': [260, 120],
  'ON': [340, 145], 'QC': [400, 130], 'NB': [445, 145], 'NS': [465, 155],
  'PE': [460, 145], 'NL': [490, 110], 'YT': [110, 50],  'NT': [180, 50],  'NU': [280, 60],
  // US states (approximate)
  'CA': [110, 220], 'NV': [130, 215], 'OR': [120, 175], 'WA': [125, 145],
  'AZ': [165, 245], 'UT': [165, 215], 'CO': [205, 220], 'NM': [205, 250],
  'TX': [240, 280], 'OK': [240, 250], 'KS': [240, 220], 'NE': [240, 195],
  'SD': [240, 175], 'ND': [235, 150], 'MN': [275, 165], 'IA': [285, 200],
  'MO': [290, 230], 'AR': [295, 260], 'LA': [305, 290], 'MS': [320, 280],
  'AL': [340, 275], 'GA': [365, 270], 'FL': [380, 305], 'SC': [380, 255],
  'NC': [385, 235], 'TN': [330, 245], 'KY': [340, 225], 'IN': [325, 210],
  'IL': [310, 210], 'WI': [305, 180], 'MI': [340, 185], 'OH': [355, 210],
  'WV': [375, 220], 'VA': [395, 230], 'PA': [400, 200], 'NY': [415, 180],
  'NJ': [425, 200], 'CT': [435, 190], 'RI': [445, 188], 'MA': [445, 178],
  'NH': [445, 165], 'VT': [435, 165], 'ME': [460, 150], 'MD': [410, 220],
  'DE': [420, 215], 'DC': [410, 222], 'HI': [80, 320], 'AK': [50, 80],
  'ID': [155, 175], 'MT': [180, 145], 'WY': [205, 175],
};
const ORIGIN_XY: [number, number] = [340, 145]; // Markham, ON

function RegionMap({ regions }: { regions: { code: string; country: 'CA' | 'US' | '??'; count: number }[] }) {
  const maxCount = Math.max(1, ...regions.map(r => r.count));
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>Delivery Map (Markham → destinations)</div>
      <div className={styles.cardBody}>
        <svg viewBox="0 0 540 360" className={styles.mapSvg}>
          {/* Background frame */}
          <rect x="0" y="0" width="540" height="360" fill="#f5f1eb" rx="6" />
          {/* Origin */}
          <circle cx={ORIGIN_XY[0]} cy={ORIGIN_XY[1]} r="6" fill="#CC2D30" stroke="#fff" strokeWidth="2" />
          <text x={ORIGIN_XY[0] + 8} y={ORIGIN_XY[1] - 8} fontSize="9" fill="#2C2A25" fontWeight="700">Markham, ON</text>

          {regions.map(r => {
            const xy = REGION_XY[r.code];
            if (!xy) return null;
            const [x, y] = xy;
            if (x === ORIGIN_XY[0] && y === ORIGIN_XY[1]) {
              // Origin region itself — don't draw a line to itself, just emphasize origin marker
              return null;
            }
            const radius = 3 + Math.round((r.count / maxCount) * 7);
            const color = r.country === 'CA' ? '#CC2D30' : '#3C3B6E';
            return (
              <g key={r.code}>
                <line
                  x1={ORIGIN_XY[0]} y1={ORIGIN_XY[1]} x2={x} y2={y}
                  stroke={color} strokeWidth="0.5" strokeDasharray="2 2" opacity="0.4"
                />
                <circle cx={x} cy={y} r={radius} fill={color} opacity="0.85" />
                <text x={x + radius + 2} y={y + 3} fontSize="8" fill="#2C2A25">{r.code} · {r.count}</text>
              </g>
            );
          })}
        </svg>
        <div className={styles.mapLegend}>
          <span><span className={styles.legendDot} style={{ background: '#CC2D30' }} /> Canada</span>
          <span><span className={styles.legendDot} style={{ background: '#3C3B6E' }} /> US</span>
          <span className={styles.muted}>· marker size ∝ shipment count</span>
        </div>
      </div>
    </div>
  );
}

function RecentShipments({ shipped }: { shipped: Unit[] }) {
  const recent = useMemo(
    () => [...shipped]
      .sort((a, b) => (b.shipped_at ?? '').localeCompare(a.shipped_at ?? ''))
      .slice(0, 20),
    [shipped],
  );
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>Recent Shipments (latest 20)</div>
      <div className={styles.cardBody} style={{ padding: 0 }}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Customer</th>
              <th>Serial</th>
              <th>Destination</th>
              <th>Carrier</th>
            </tr>
          </thead>
          <tbody>
            {recent.map(u => (
              <tr key={u.serial}>
                <td className={styles.mono}>{new Date(u.shipped_at!).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' })}</td>
                <td>{u.customer_name ?? <span className={styles.muted}>—</span>}</td>
                <td className={styles.mono}>{u.serial}</td>
                <td>{u.location ?? <span className={styles.muted}>—</span>}</td>
                <td>{u.carrier ?? <span className={styles.muted}>—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
