import { useMemo } from 'react';
import { MapContainer, TileLayer, CircleMarker, Polyline, Popup, Marker } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
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
// Region map — Leaflet + OpenStreetMap tiles. Province/state centroid
// lookup gives us real lat/lng so we can render proper geographic markers
// scaled by shipment count, with dashed great-circle lines from Markham.
// ============================================================================

// Approximate province / state centroid lat/lng. Good enough for "ship
// destinations are spread roughly here" visualization without bringing in
// a topojson dependency.
const REGION_LATLNG: Record<string, [number, number]> = {
  // Canadian provinces
  'BC': [54.0, -125.0], 'AB': [55.0, -115.0], 'SK': [55.0, -106.0], 'MB': [55.0,  -98.0],
  'ON': [50.0,  -85.0], 'QC': [52.0,  -71.5], 'NB': [46.5,  -66.5], 'NS': [45.0,  -63.0],
  'PE': [46.4,  -63.2], 'NL': [53.0,  -60.0], 'YT': [64.0, -135.0], 'NT': [65.0, -120.0], 'NU': [70.0,  -90.0],
  // US states (approx centroids)
  'AL': [32.8, -86.8],  'AK': [64.2, -149.5], 'AZ': [34.5, -111.7], 'AR': [34.9, -92.4],
  'CA': [37.2, -119.7], 'CO': [39.1, -105.5], 'CT': [41.6, -72.7],  'DE': [38.9, -75.5],
  'FL': [28.6, -82.5],  'GA': [32.7, -83.4],  'HI': [20.7, -156.5], 'ID': [44.4, -114.6],
  'IL': [40.0, -89.2],  'IN': [39.9, -86.3],  'IA': [42.1, -93.2],  'KS': [38.5, -98.4],
  'KY': [37.5, -85.3],  'LA': [31.1, -91.9],
  'ME': [45.4, -69.2],  'MD': [39.0, -76.7],  'MA': [42.3, -71.8],  'MI': [44.3, -85.4],
  'MN': [46.3, -94.3],  'MS': [32.7, -89.7],  'MO': [38.4, -92.5],  'MT': [47.0, -109.6],
  'NE': [41.5, -99.8],  'NV': [38.5, -116.6], 'NH': [43.7, -71.6],  'NJ': [40.2, -74.5],
  'NM': [34.4, -106.1], 'NY': [42.9, -75.6],  'NC': [35.6, -79.4],  'ND': [47.5, -100.3],
  'OH': [40.3, -82.8],  'OK': [35.6, -97.5],  'OR': [44.0, -120.6], 'PA': [40.9, -77.8],
  'RI': [41.7, -71.6],  'SC': [33.9, -80.9],  'SD': [44.4, -100.2], 'TN': [35.9, -86.4],
  'TX': [31.5, -99.3],  'UT': [39.3, -111.7], 'VT': [44.1, -72.7],  'VA': [37.5, -78.9],
  'WA': [47.4, -120.4], 'WV': [38.6, -80.6],  'WI': [44.5, -89.6],  'WY': [43.0, -107.5],
  'DC': [38.9, -77.0],
};

const ORIGIN_LATLNG: [number, number] = [43.8561, -79.3370]; // Markham, ON

const ORIGIN_ICON = L.divIcon({
  className: 'lila-origin-marker',
  html: `<div style="background:#CC2D30;color:#fff;border:2px solid #fff;border-radius:50%;width:18px;height:18px;box-shadow:0 0 0 2px #CC2D30;"></div>`,
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

function RegionMap({ regions }: { regions: { code: string; country: 'CA' | 'US' | '??'; count: number }[] }) {
  const maxCount = Math.max(1, ...regions.map(r => r.count));

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>Delivery Map (Markham → destinations)</div>
      <div className={styles.cardBody} style={{ padding: 0 }}>
        <MapContainer
          center={[42, -95]}
          zoom={3}
          scrollWheelZoom={false}
          style={{ height: 380, width: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <Marker position={ORIGIN_LATLNG} icon={ORIGIN_ICON}>
            <Popup>Markham, ON · Origin</Popup>
          </Marker>
          {regions.map(r => {
            const ll = REGION_LATLNG[r.code];
            if (!ll) return null;
            const radius = 5 + Math.round((r.count / maxCount) * 14);
            const color = r.country === 'CA' ? '#CC2D30' : '#3C3B6E';
            return (
              <CircleMarker
                key={r.code}
                center={ll}
                radius={radius}
                pathOptions={{ color, fillColor: color, fillOpacity: 0.55, weight: 1 }}
              >
                <Popup>
                  <strong>{r.code}</strong> · {r.country}<br />
                  {r.count} shipment{r.count === 1 ? '' : 's'}
                </Popup>
              </CircleMarker>
            );
          })}
          {regions.map(r => {
            const ll = REGION_LATLNG[r.code];
            if (!ll) return null;
            const color = r.country === 'CA' ? '#CC2D30' : '#3C3B6E';
            return (
              <Polyline
                key={`line-${r.code}`}
                positions={[ORIGIN_LATLNG, ll]}
                pathOptions={{ color, weight: 1, opacity: 0.35, dashArray: '4 4' }}
              />
            );
          })}
        </MapContainer>
        <div className={styles.mapLegend}>
          <span><span className={styles.legendDot} style={{ background: '#CC2D30' }} /> Canada</span>
          <span><span className={styles.legendDot} style={{ background: '#3C3B6E' }} /> US</span>
          <span className={styles.muted}>· marker size ∝ shipment count · click for details</span>
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
