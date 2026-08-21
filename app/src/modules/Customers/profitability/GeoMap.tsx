import { useMemo, useState } from 'react';
import type { SegmentMetrics } from '../../../lib/profitability';
import { REGION_TILES, TILE_GRID_COLS, TILE_GRID_ROWS, regionName } from '../../../lib/regions';
import { DIVERGING, divergingColor, inkOn, INK } from './palette';
import styles from '../Customers.module.css';

/** A tile-grid map of Canada and the US, coloured by a profitability measure.
 *
 *  One square per province/state, placed roughly where it sits on the
 *  continent. Not a true choropleth on purpose: real geography would give
 *  Nunavut forty times the ink of New Jersey and hide Prince Edward Island
 *  entirely, and this map is comparing profit per customer, not land area.
 *
 *  Regions we have never sold into are drawn as empty outlines rather than
 *  omitted — "no customers here" is itself worth seeing on a sales map.
 */

export type GeoMeasure = 'profitPerCustomer' | 'contributionMargin' | 'customers' | 'arpu';

const MEASURE_LABELS: Record<GeoMeasure, string> = {
  profitPerCustomer:  'Lifetime profit per customer',
  contributionMargin: 'Total contribution margin',
  customers:          'Customers',
  arpu:               'Revenue per unit',
};

function measureOf(seg: SegmentMetrics, measure: GeoMeasure): number | null {
  switch (measure) {
    case 'profitPerCustomer':  return seg.profitPerCustomer;
    case 'contributionMargin': return seg.contributionMargin;
    case 'customers':          return seg.customers;
    case 'arpu':               return seg.arpu;
  }
}

const CELL = 46;
const GAP = 4;
/** Every tile is pushed down by this much to clear the country captions, so the
 *  viewBox has to be that much taller — without it the bottom row (Hawaii,
 *  Texas, Florida) is clipped off the canvas. */
const TOP_OFFSET = 20;

export function GeoMap({
  regions,
  measure,
  onMeasureChange,
  onSelect,
  selected,
}: {
  regions: SegmentMetrics[];
  measure: GeoMeasure;
  onMeasureChange: (m: GeoMeasure) => void;
  onSelect: (regionCode: string | null) => void;
  selected: string | null;
}) {
  const [hover, setHover] = useState<string | null>(null);

  const byCode = useMemo(() => {
    const m = new Map<string, SegmentMetrics>();
    for (const r of regions) m.set(r.key, r);
    return m;
  }, [regions]);

  // Both arms share one scale so a small loss cannot look like a large one.
  // "Customers" is a count, not a signed value, so it gets the profit arm only.
  const scale = useMemo(() => {
    const values = regions
      .map(r => measureOf(r, measure))
      .filter((v): v is number => v != null);
    if (values.length === 0) return 1;
    return Math.max(...values.map(Math.abs), 1);
  }, [regions, measure]);

  const width = TILE_GRID_COLS * (CELL + GAP);
  const height = TILE_GRID_ROWS * (CELL + GAP) + TOP_OFFSET;
  const active = hover ?? selected;
  const activeSeg = active ? byCode.get(active) : undefined;

  return (
    <div className={styles.geoMapWrap}>
      <div className={styles.geoMapHead}>
        <div>
          <div className={styles.geoMapTitle}>{MEASURE_LABELS[measure]} by province / state</div>
          <div className={styles.geoMapSub}>
            One square per region, placed roughly geographically. Outlined squares are
            regions we have never sold into.
          </div>
        </div>
        <select
          className={styles.geoMeasureSelect}
          value={measure}
          onChange={e => onMeasureChange(e.target.value as GeoMeasure)}
          aria-label="Map measure"
        >
          {(Object.keys(MEASURE_LABELS) as GeoMeasure[]).map(k => (
            <option key={k} value={k}>{MEASURE_LABELS[k]}</option>
          ))}
        </select>
      </div>

      <div className={styles.geoMapBody}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className={styles.geoMapSvg}
          role="img"
          aria-label={`${MEASURE_LABELS[measure]} by province and state`}
        >
          <text x={2} y={14} className={styles.geoCountryLabel} fill={INK.muted}>CANADA</text>
          <text x={2} y={4 * (CELL + GAP) + TOP_OFFSET - 6} className={styles.geoCountryLabel} fill={INK.muted}>
            UNITED STATES
          </text>
          {REGION_TILES.map(tile => {
            const seg = byCode.get(tile.code);
            const value = seg ? measureOf(seg, measure) : null;
            const fill = seg == null || value == null
              ? 'transparent'
              : divergingColor(measure === 'customers' ? Math.abs(value) : value, scale);
            const code = tile.code.split('-')[1];
            const isActive = active === tile.code;
            return (
              <g
                key={tile.code}
                transform={`translate(${tile.col * (CELL + GAP)}, ${tile.row * (CELL + GAP) + TOP_OFFSET})`}
                onMouseEnter={() => setHover(tile.code)}
                onMouseLeave={() => setHover(null)}
                onClick={() => seg && onSelect(selected === tile.code ? null : tile.code)}
                className={seg ? styles.geoTileActive : styles.geoTileEmpty}
              >
                <rect
                  width={CELL} height={CELL} rx={5}
                  fill={fill}
                  stroke={isActive ? INK.primary : seg ? 'rgba(11,11,11,0.10)' : INK.axis}
                  strokeWidth={isActive ? 2 : 1}
                  strokeDasharray={seg ? undefined : '3 3'}
                />
                <text
                  x={CELL / 2} y={CELL / 2 - 2}
                  textAnchor="middle"
                  className={styles.geoTileCode}
                  fill={seg ? inkOn(fill) : INK.muted}
                >
                  {code}
                </text>
                {seg && value != null && (
                  <text
                    x={CELL / 2} y={CELL / 2 + 12}
                    textAnchor="middle"
                    className={styles.geoTileValue}
                    fill={inkOn(fill)}
                  >
                    {shortValue(value, measure)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        <div className={styles.geoSide}>
          <Legend measure={measure} scale={scale} />
          {activeSeg ? (
            <div className={styles.geoTooltip}>
              <div className={styles.geoTooltipName}>{regionName(activeSeg.key)}</div>
              <dl>
                <div><dt>Customers</dt><dd>{activeSeg.customers}</dd></div>
                <div><dt>Units</dt><dd>{activeSeg.units}</dd></div>
                <div><dt>Revenue</dt><dd>{money(activeSeg.revenue)}</dd></div>
                <div><dt>Contribution</dt><dd>{money(activeSeg.contributionMargin)}</dd></div>
                <div><dt>Profit / customer</dt><dd>{money(activeSeg.profitPerCustomer)}</dd></div>
                <div><dt>Warranty cost</dt><dd>{money(activeSeg.warrantyCost)}</dd></div>
              </dl>
            </div>
          ) : (
            <div className={styles.geoTooltipHint}>
              Hover a square for the detail. Click to filter the whole tab to that region.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Legend({ measure, scale }: { measure: GeoMeasure; scale: number }) {
  const steps = measure === 'customers'
    ? [DIVERGING.neutral, DIVERGING.profitLight, DIVERGING.profit, DIVERGING.profitStrong]
    : [DIVERGING.lossStrong, DIVERGING.loss, DIVERGING.lossLight,
       DIVERGING.neutral, DIVERGING.profitLight, DIVERGING.profit, DIVERGING.profitStrong];
  return (
    <div className={styles.geoLegend}>
      <div className={styles.geoLegendScale}>
        {steps.map(c => <span key={c} style={{ background: c }} />)}
      </div>
      <div className={styles.geoLegendLabels}>
        <span>{measure === 'customers' ? '0' : `−${shortMoney(scale)}`}</span>
        <span>{measure === 'customers' ? `${Math.round(scale)}` : shortMoney(scale)}</span>
      </div>
    </div>
  );
}

function shortValue(v: number, measure: GeoMeasure): string {
  if (measure === 'customers') return String(Math.round(v));
  return shortMoney(v);
}

/** Compact money for a 46px tile: "$1.2k", "−$840". */
function shortMoney(v: number): string {
  const sign = v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (a >= 1000) return `${sign}$${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k`;
  return `${sign}$${Math.round(a)}`;
}

function money(v: number | null): string {
  if (v == null) return '—';
  return `$${v.toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
