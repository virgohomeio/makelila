import { useState } from 'react';
import type { CustomerMetrics, ProfitBucket, SegmentMetrics, WaterfallStep } from '../../../lib/profitability';
import { DIVERGING, INK } from './palette';
import styles from '../Customers.module.css';

/** The three charts the profitability overview needs, as plain inline SVG.
 *
 *  All three are single-encoding: the only thing colour says is the sign of a
 *  number, red for money leaving and blue for money staying. Nothing here uses
 *  colour to tell one category from another, so there is no categorical
 *  palette to get wrong, and every mark is labelled with its own value.
 */

// ── Waterfall: revenue → each cost → contribution → CAC → profit ────────────

export function WaterfallChart({ steps }: { steps: WaterfallStep[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (steps.length === 0) return null;

  // Running position of each bar. Totals are drawn from zero; cost steps hang
  // off wherever the running balance had got to.
  let running = 0;
  const bars = steps.map(s => {
    if (s.isTotal) {
      running = s.value;
      return { ...s, from: 0, to: s.value };
    }
    const from = running;
    running += s.value;
    return { ...s, from, to: running };
  });

  const max = Math.max(...bars.map(b => Math.max(b.from, b.to)), 0);
  const min = Math.min(...bars.map(b => Math.min(b.from, b.to)), 0);
  const span = max - min || 1;

  const H = 220, W = 100 / bars.length;
  const y = (v: number) => ((max - v) / span) * H;

  return (
    <figure className={styles.chartFigure}>
      <figcaption className={styles.chartTitle}>
        Where the revenue goes
        <span className={styles.chartSub}>
          Every dollar booked, less each cost bucket, down to profit after acquisition.
        </span>
      </figcaption>
      <div className={styles.chartCanvas}>
        <svg viewBox={`0 0 100 ${H + 34}`} preserveAspectRatio="none" className={styles.waterfallSvg}>
          <line x1={0} y1={y(0)} x2={100} y2={y(0)} stroke={INK.axis} strokeWidth={0.3} />
          {bars.map((b, i) => {
            const top = Math.min(y(b.from), y(b.to));
            const h = Math.max(Math.abs(y(b.to) - y(b.from)), 1.5);
            const fill = b.isTotal
              ? (b.to >= 0 ? DIVERGING.profit : DIVERGING.loss)
              : (b.value >= 0 ? DIVERGING.profitLight : DIVERGING.loss);
            return (
              <g key={b.label}
                 onMouseEnter={() => setHover(i)}
                 onMouseLeave={() => setHover(null)}>
                <rect x={i * W} y={0} width={W} height={H + 34} fill="transparent" />
                <rect
                  x={i * W + W * 0.18} y={top}
                  width={W * 0.64} height={h}
                  rx={1}
                  fill={fill}
                  opacity={hover == null || hover === i ? 1 : 0.55}
                />
              </g>
            );
          })}
        </svg>
        <div className={styles.waterfallLabels}>
          {bars.map((b, i) => (
            <div key={b.label}
                 className={`${styles.waterfallLabel} ${b.isTotal ? styles.waterfallTotal : ''}`}
                 onMouseEnter={() => setHover(i)}
                 onMouseLeave={() => setHover(null)}>
              <span className={styles.waterfallValue}>{signedShort(b.value)}</span>
              <span className={styles.waterfallName}>{b.label}</span>
            </div>
          ))}
        </div>
      </div>
    </figure>
  );
}

// ── Distribution: how many customers land in each profit band ───────────────

export function ProfitDistribution({
  buckets, onSelectBucket,
}: {
  buckets: ProfitBucket[];
  onSelectBucket?: (b: ProfitBucket) => void;
}) {
  const max = Math.max(...buckets.map(b => b.count), 1);
  const total = buckets.reduce((s, b) => s + b.count, 0);
  return (
    <figure className={styles.chartFigure}>
      <figcaption className={styles.chartTitle}>
        Customers by lifetime profit
        <span className={styles.chartSub}>
          {total} customers. Bands left of zero are customers we have lost money on.
        </span>
      </figcaption>
      <div className={styles.histogram}>
        {buckets.map(b => (
          <div
            key={b.label}
            className={styles.histRow}
            onClick={() => onSelectBucket?.(b)}
            role={onSelectBucket ? 'button' : undefined}
            tabIndex={onSelectBucket ? 0 : undefined}
            onKeyDown={e => { if (e.key === 'Enter') onSelectBucket?.(b); }}
          >
            <span className={styles.histLabel}>{b.label}</span>
            <span className={styles.histTrack}>
              <span
                className={styles.histBar}
                style={{
                  width: `${(b.count / max) * 100}%`,
                  background: b.max <= 0 ? DIVERGING.loss : DIVERGING.profit,
                }}
              />
            </span>
            <span className={styles.histCount}>{b.count}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}

// ── LTV vs CAC scatter, one point per segment ───────────────────────────────

export function LtvCacScatter({ segments, label }: { segments: SegmentMetrics[]; label: string }) {
  const [hover, setHover] = useState<string | null>(null);
  const points = segments.filter(s => s.cac != null && s.ltv != null);

  if (points.length === 0) {
    return (
      <figure className={styles.chartFigure}>
        <figcaption className={styles.chartTitle}>
          LTV vs CAC by {label}
          <span className={styles.chartSub}>No segment has both an LTV and a traceable CAC yet.</span>
        </figcaption>
        <div className={styles.chartEmpty}>
          Acquisition spend is only on file for Meta campaigns. Add spend rows for the
          other channels and every point appears here.
        </div>
      </figure>
    );
  }

  const maxCac = Math.max(...points.map(p => p.cac ?? 0), 1);
  const ltvs = points.map(p => p.ltv ?? 0);
  const maxLtv = Math.max(...ltvs, 1);
  const minLtv = Math.min(...ltvs, 0);
  const spanLtv = maxLtv - minLtv || 1;

  const W = 100, H = 76, PAD = 6;
  const px = (v: number) => PAD + (v / maxCac) * (W - PAD * 2);
  const py = (v: number) => H - PAD - ((v - minLtv) / spanLtv) * (H - PAD * 2);

  // The break-even diagonal: LTV = CAC. Points above it earn back what they cost.
  const diagMax = Math.min(maxCac, maxLtv);

  return (
    <figure className={styles.chartFigure}>
      <figcaption className={styles.chartTitle}>
        LTV vs CAC by {label}
        <span className={styles.chartSub}>
          Above the dashed line, a segment earns back more than it cost to acquire.
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.scatterSvg} role="img"
           aria-label={`Lifetime value against acquisition cost by ${label}`}>
        {minLtv < 0 && (
          <line x1={PAD} y1={py(0)} x2={W - PAD} y2={py(0)}
                stroke={INK.axis} strokeWidth={0.3} />
        )}
        <line x1={px(0)} y1={py(0)} x2={px(diagMax)} y2={py(diagMax)}
              stroke={INK.muted} strokeWidth={0.3} strokeDasharray="1.5 1.5" />
        {points.map(p => {
          const cx = px(p.cac ?? 0), cy = py(p.ltv ?? 0);
          const good = (p.ltv ?? 0) >= (p.cac ?? 0);
          return (
            <g key={p.key}
               onMouseEnter={() => setHover(p.key)}
               onMouseLeave={() => setHover(null)}>
              <circle cx={cx} cy={cy} r={hover === p.key ? 3 : 2.2}
                      fill={good ? DIVERGING.profit : DIVERGING.loss}
                      stroke="#fff" strokeWidth={0.6} />
              <text x={cx + 3.5} y={cy + 1.2} className={styles.scatterLabel} fill={INK.secondary}>
                {p.label}
              </text>
            </g>
          );
        })}
        <text x={W - PAD} y={H - 0.5} textAnchor="end" className={styles.axisLabel} fill={INK.muted}>
          CAC →
        </text>
        <text x={PAD} y={5} className={styles.axisLabel} fill={INK.muted}>↑ LTV</text>
      </svg>
      {hover && (() => {
        const p = points.find(x => x.key === hover)!;
        return (
          <div className={styles.scatterReadout}>
            <strong>{p.label}</strong> · {p.customers} customers · CAC {money(p.cac)} ·
            LTV {money(p.ltv)} · LTV:CAC {p.ltvCac == null ? '—' : `${p.ltvCac.toFixed(1)}×`}
          </div>
        );
      })()}
    </figure>
  );
}

// ── Cumulative lifetime profit by cohort ────────────────────────────────────

export function CohortProfitChart({ cohorts }: { cohorts: SegmentMetrics[] }) {
  if (cohorts.length < 2) return null;
  const values = cohorts.map(c => c.lifetimeProfit);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const H = 90;

  return (
    <figure className={styles.chartFigure}>
      <figcaption className={styles.chartTitle}>
        Lifetime profit by acquisition cohort
        <span className={styles.chartSub}>
          Each bar is everyone we won that month, and what they are worth to date.
        </span>
      </figcaption>
      <div className={styles.cohortChart}>
        {cohorts.map(c => {
          const h = (Math.abs(c.lifetimeProfit) / span) * H;
          const positive = c.lifetimeProfit >= 0;
          return (
            <div key={c.key} className={styles.cohortCol}
                 title={`${c.label}: ${c.customers} customers, ${money(c.lifetimeProfit)} lifetime profit`}>
              <div className={styles.cohortBarArea}>
                <div
                  className={styles.cohortBar}
                  style={{
                    height: `${Math.max(h, 1)}px`,
                    background: positive ? DIVERGING.profit : DIVERGING.loss,
                    alignSelf: positive ? 'flex-end' : 'flex-start',
                  }}
                />
              </div>
              <span className={styles.cohortLabel}>{c.label.slice(2)}</span>
            </div>
          );
        })}
      </div>
    </figure>
  );
}

function signedShort(v: number): string {
  const sign = v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (a >= 1000) return `${sign}$${(a / 1000).toFixed(1)}k`;
  return `${sign}$${Math.round(a)}`;
}

function money(v: number | null): string {
  if (v == null) return '—';
  return `$${Math.round(v).toLocaleString('en-CA')}`;
}

export type { CustomerMetrics };
