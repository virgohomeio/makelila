import { useMemo, useState } from 'react';
import type { SegmentMetrics } from '../../../lib/profitability';
import { regionName } from '../../../lib/regions';
import {
  REGION_SHAPES, MAP_VIEWBOX, MAP_GUTTER, MAP_INSETS, type RegionShape,
} from '../../../lib/regionShapes';
import { DIVERGING, divergingColor, inkOn, INK } from './palette';
import styles from '../Customers.module.css';

/** A choropleth of Canada and the US, coloured by a profitability measure.
 *
 *  Real outlines, projected once at build time by scripts/generate-region-
 *  shapes.mjs, so the app ships no mapping library and makes no network call
 *  to draw a map. The projection is composite the way d3's albersUsa is: one
 *  Albers cone over Canada and the lower 48, and separate framed insets for
 *  Alaska and Hawaii.
 *
 *  Real geography costs us something a tile grid did not: Prince Edward
 *  Island is three pixels across and cannot hold its own label. Those regions
 *  get a leader line out to a chip in the right-hand gutter rather than being
 *  dropped or having their number float over a neighbour — and which regions
 *  those are is decided by measured drawing room, not a hand-kept list.
 *
 *  Regions we have never sold into are hatched rather than omitted — "no
 *  customers here" is itself worth seeing on a sales map.
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

/** Room, in px, for a two-line label at the two type sizes the map uses. Room
 *  is the radius of the largest circle that fits inside the region, so these
 *  are the radii that clear a ~34x22 and a ~28x17 box respectively. */
const BIG_ROOM = 21;
const SMALL_ROOM = 13;

const CHIP_H = 24;
const CHIP_GAP = 6;
const CHIP_W = MAP_GUTTER - 4;
const GUTTER_X = MAP_VIEWBOX.width - MAP_GUTTER;

const INSET_CODES = new Set<string>(MAP_INSETS.map(i => i.code));

type Callout = RegionShape & { chipY: number };

/** Lay the gutter chips out top to bottom, each as close to its own region as
 *  the one above it allows. Pure geometry — it does not depend on the data, so
 *  it is computed once for the module rather than per render. */
const CALLOUTS: Callout[] = (() => {
  const small = REGION_SHAPES
    .filter(s => s.room < SMALL_ROOM && !INSET_CODES.has(s.code))
    .sort((a, b) => a.labelY - b.labelY);
  let cursor = 0;
  const out = small.map(s => {
    const chipY = Math.max(s.labelY - CHIP_H / 2, cursor);
    cursor = chipY + CHIP_H + CHIP_GAP;
    return { ...s, chipY };
  });
  const overflow = cursor - CHIP_GAP - MAP_VIEWBOX.height;
  if (overflow > 0) for (const c of out) c.chipY -= overflow;
  return out;
})();

const CALLOUT_BY_CODE = new Map(CALLOUTS.map(c => [c.code, c]));

export function GeoMap({
  regions,
  measure,
  onMeasureChange,
  onSelect,
  selected,
  narrowed = false,
}: {
  regions: SegmentMetrics[];
  measure: GeoMeasure;
  onMeasureChange: (m: GeoMeasure) => void;
  onSelect: (regionCode: string | null) => void;
  selected: string | null;
  /** Whether a filter other than the region pick is narrowing the map. It
   *  changes what a hatched region means: "nobody has ever bought here" and
   *  "nobody here matches the current filters" are different facts, and the
   *  map should not report the first when it means the second. */
  narrowed?: boolean;
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

  const active = hover ?? selected;
  const activeSeg = active ? byCode.get(active) : undefined;

  const fillFor = (code: string): { fill: string; value: number | null } => {
    const seg = byCode.get(code);
    const value = seg ? measureOf(seg, measure) : null;
    if (value == null) return { fill: 'url(#geoNoData)', value: null };
    return {
      fill: divergingColor(measure === 'customers' ? Math.abs(value) : value, scale),
      value,
    };
  };

  return (
    <div className={styles.geoMapWrap}>
      <div className={styles.geoMapHead}>
        <div>
          <div className={styles.geoMapTitle}>{MEASURE_LABELS[measure]} by province / state</div>
          <div className={styles.geoMapSub}>
            Hatched regions have no customers {narrowed ? 'matching the filters' : 'yet'}.
            Regions too small to carry their own number are labelled down the
            right-hand side. Alaska and Hawaii are insets, not to scale.
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
          viewBox={`0 0 ${MAP_VIEWBOX.width} ${MAP_VIEWBOX.height}`}
          className={styles.geoMapSvg}
          role="img"
          aria-label={`${MEASURE_LABELS[measure]} by province and state`}
        >
          <defs>
            <pattern
              id="geoNoData" width="6" height="6"
              patternUnits="userSpaceOnUse" patternTransform="rotate(45)"
            >
              <rect width="6" height="6" fill="#fbfbfa" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="#dcdcd8" strokeWidth="1" />
            </pattern>
          </defs>

          {MAP_INSETS.map(inset => (
            <g key={`frame-${inset.code}`} className={styles.geoInsetFrame}>
              <rect
                x={inset.x - 9} y={inset.y - 9}
                width={inset.width + 18} height={inset.height + 18}
                rx={6} fill="none" stroke={INK.grid}
              />
              {/* Name and number on one line: the two insets sit close enough
                  that anchoring each number to its own frame's right edge
                  butts it against the next frame's caption. */}
              <text x={inset.x - 9} y={inset.y + inset.height + 22} className={styles.geoInsetLabel}>
                {inset.label.toUpperCase()}
                <tspan dx="7" className={styles.geoInsetValue}>
                  {formatValue(fillFor(inset.code).value, measure)}
                </tspan>
              </text>
            </g>
          ))}

          {/* The active region goes last so its heavier stroke is not painted
              over by whichever neighbour happens to sort after it. */}
          {[...REGION_SHAPES]
            .sort((a, b) => Number(a.code === active) - Number(b.code === active))
            .map(shape => (
              <Region
                key={shape.code}
                shape={shape}
                {...fillFor(shape.code)}
                measure={measure}
                isActive={active === shape.code}
                hasData={byCode.has(shape.code)}
                onHover={setHover}
                onSelect={onSelect}
                selected={selected}
              />
            ))}
        </svg>

        <div className={styles.geoSide}>
          <Legend measure={measure} scale={scale} narrowed={narrowed} />
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
          ) : active ? (
            <div className={styles.geoTooltip}>
              <div className={styles.geoTooltipName}>{regionName(active)}</div>
              <div className={styles.geoTooltipHint}>
                {narrowed ? 'No customers here match the current filters.' : 'No customers here yet.'}
              </div>
            </div>
          ) : (
            <div className={styles.geoTooltipHint}>
              Hover a region for the detail. Click to filter the whole tab to that region.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One province or state: its outline, and either an inline label or a leader
 *  line out to a chip in the gutter. Both live in the same &lt;g&gt; so the chip
 *  hovers and selects the region it belongs to. */
function Region({
  shape, fill, value, measure, isActive, hasData, onHover, onSelect, selected,
}: {
  shape: RegionShape;
  fill: string;
  value: number | null;
  measure: GeoMeasure;
  isActive: boolean;
  hasData: boolean;
  onHover: (code: string | null) => void;
  onSelect: (code: string | null) => void;
  selected: string | null;
}) {
  const code = shape.code.split('-')[1];
  const callout = CALLOUT_BY_CODE.get(shape.code);
  const isInset = INSET_CODES.has(shape.code);
  const ink = hasData ? inkOn(fill) : INK.muted;
  const big = shape.room >= BIG_ROOM;

  return (
    <g
      className={hasData ? styles.geoRegionActive : styles.geoRegion}
      onMouseEnter={() => onHover(shape.code)}
      onMouseLeave={() => onHover(null)}
      onClick={() => hasData && onSelect(selected === shape.code ? null : shape.code)}
    >
      <path
        d={shape.d}
        fill={fill}
        stroke={isActive ? INK.primary : '#ffffff'}
        strokeWidth={isActive ? 2 : 0.9}
        strokeLinejoin="round"
      />

      {/* Insets carry their number in the frame caption — the islands
          themselves are too small to print on. */}
      {!callout && !isInset && (
        value == null
          ? (
            <text
              x={shape.labelX} y={shape.labelY + (big ? 4 : 3)}
              textAnchor="middle" fill={ink}
              className={big ? styles.geoLabelCode : styles.geoLabelCodeSmall}
            >
              {code}
            </text>
          )
          : (
            <>
              <text
                x={shape.labelX} y={shape.labelY - 1}
                textAnchor="middle" fill={ink}
                className={big ? styles.geoLabelCode : styles.geoLabelCodeSmall}
              >
                {code}
              </text>
              <text
                x={shape.labelX} y={shape.labelY + (big ? 11 : 9)}
                textAnchor="middle" fill={ink}
                className={big ? styles.geoLabelValue : styles.geoLabelValueSmall}
              >
                {formatValue(value, measure)}
              </text>
            </>
          )
      )}

      {callout && (
        <>
          <polyline
            points={`${shape.labelX},${shape.labelY} ${GUTTER_X - 20},${callout.chipY + CHIP_H / 2} ${GUTTER_X},${callout.chipY + CHIP_H / 2}`}
            fill="none"
            stroke={isActive ? INK.primary : INK.axis}
            strokeWidth={1}
          />
          <circle cx={shape.labelX} cy={shape.labelY} r={1.8} fill={INK.muted} />
          <rect
            x={GUTTER_X} y={callout.chipY} width={CHIP_W} height={CHIP_H} rx={4}
            fill={INK.surface} stroke={isActive ? INK.primary : INK.grid}
          />
          <rect
            x={GUTTER_X + 1} y={callout.chipY + 1} width={5} height={CHIP_H - 2}
            fill={fill}
          />
          <text
            x={GUTTER_X + 14} y={callout.chipY + CHIP_H / 2 + 4}
            className={styles.geoChipCode}
          >
            {code}
          </text>
          <text
            x={GUTTER_X + CHIP_W - 10} y={callout.chipY + CHIP_H / 2 + 4}
            textAnchor="end" className={styles.geoChipValue}
          >
            {formatValue(value, measure)}
          </text>
        </>
      )}
    </g>
  );
}

function Legend({ measure, scale, narrowed }: {
  measure: GeoMeasure; scale: number; narrowed: boolean;
}) {
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
      <div className={styles.geoLegendNote}>
        <span className={styles.geoLegendHatch} aria-hidden="true" />
        {narrowed ? 'No customers matching' : 'No customers yet'}
      </div>
    </div>
  );
}

function formatValue(v: number | null, measure: GeoMeasure): string {
  if (v == null) return '—';
  if (measure === 'customers') return String(Math.round(v));
  return shortMoney(v);
}

/** Compact money for a label that has to fit inside Rhode Island: "$1.2k",
 *  "−$840". */
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
