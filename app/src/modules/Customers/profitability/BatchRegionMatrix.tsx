import { useMemo, useState } from 'react';
import type { BatchRegionMatrix as Matrix, BatchRegionCell } from '../../../lib/batchProfitability';
import { regionName } from '../../../lib/regions';
import { divergingColor, inkOn, DIVERGING } from './palette';
import styles from '../Customers.module.css';

export type CellMeasure = 'profitPerUnit' | 'contributionMarginPct' | 'units';

const MEASURE_LABELS: Record<CellMeasure, string> = {
  profitPerUnit:        'Profit per unit',
  contributionMarginPct: 'Contribution margin %',
  units:                'Units shipped',
};

/** Below this many units in a cell, the number is one or two customers and
 *  should not be read as a regional result. Cells below it are marked, not
 *  hidden — hiding them would make a batch look narrower than it was. */
const THIN_CELL = 3;

function measureOf(cell: BatchRegionCell, m: CellMeasure): number | null {
  if (m === 'profitPerUnit') return cell.profitPerUnit;
  if (m === 'contributionMarginPct') return cell.contributionMarginPct;
  return cell.units;
}

/**
 *  Batch × region heatmap — the answer to "where did this batch do well, and
 *  where did it not".
 *
 *  Two things this grid has to keep straight, because getting either wrong
 *  turns it into a lie:
 *
 *  1. **Empty is not bad.** A batch that never shipped to a region gets a
 *     hatched cell, the same convention the map uses for a region with no
 *     customers. P150 never went to the US; without hatching, its whole US row
 *     would read as catastrophic loss instead of "not sold there".
 *  2. **Small is not significant.** Most cells are one or two machines. Cells
 *     under three units are dimmed and flagged so a $2,000 single-unit outlier
 *     does not get read as a regional trend.
 *
 *  Colour is diverging around zero and every cell is direct-labelled, so the
 *  grid never encodes a value in colour alone.
 */
export function BatchRegionMatrix({
  matrix,
  measure,
  onMeasureChange,
  maxRegions = 18,
}: {
  matrix: Matrix;
  measure: CellMeasure;
  onMeasureChange: (m: CellMeasure) => void;
  maxRegions?: number;
}) {
  const [hover, setHover] = useState<BatchRegionCell | null>(null);

  const regions = useMemo(
    () => matrix.regions.slice(0, maxRegions),
    [matrix.regions, maxRegions],
  );
  const hiddenRegions = matrix.regions.length - regions.length;

  // One scale across every cell so a small loss cannot look like a large one,
  // and so the same colour means the same number in every column.
  const scale = useMemo(() => {
    const vals: number[] = [];
    for (const b of matrix.batches) {
      for (const r of regions) {
        const c = matrix.cells.get(`${b}|${r}`);
        if (!c) continue;
        const v = measureOf(c, measure);
        if (v != null) vals.push(Math.abs(v));
      }
    }
    return vals.length > 0 ? Math.max(...vals, Number.EPSILON) : 1;
  }, [matrix, regions, measure]);

  if (matrix.batches.length === 0 || regions.length === 0) {
    return <div className={styles.empty}>No batch has a region on file yet.</div>;
  }

  return (
    <div className={styles.batchMatrixWrap}>
      <div className={styles.batchMatrixHead}>
        <div>
          <div className={styles.geoMapTitle}>{MEASURE_LABELS[measure]} by batch and region</div>
          <div className={styles.geoMapSub}>
            Hatched cells are regions the batch never shipped to — not a loss.
            Cells under {THIN_CELL} units are dimmed; they are one or two machines.
          </div>
        </div>
        <div className={styles.measureBtns}>
          {(Object.keys(MEASURE_LABELS) as CellMeasure[]).map(m => (
            <button
              key={m}
              className={m === measure ? styles.grainActive : styles.grainBtn}
              onClick={() => onMeasureChange(m)}
            >{MEASURE_LABELS[m]}</button>
          ))}
        </div>
      </div>

      <div className={styles.batchMatrixScroll}>
        <table className={styles.batchMatrix}>
          <thead>
            <tr>
              <th className={styles.batchMatrixCorner}>Province / state</th>
              {matrix.batches.map(b => (
                <th key={b} className={styles.num}>{b}</th>
              ))}
              <th className={styles.num}>All batches</th>
            </tr>
          </thead>
          <tbody>
            {regions.map(r => (
              <tr key={r}>
                <th scope="row">
                  {/* Inner flex box: a `display:flex` on the th itself would
                      drop it out of table layout and unalign the columns. */}
                  <span className={styles.batchMatrixRowHead}>
                    <span className={styles.batchRegionName}>{regionName(r)}</span>
                    <span className={styles.batchRegionCode}>{r}</span>
                  </span>
                </th>
                {matrix.batches.map(b => {
                  const cell = matrix.cells.get(`${b}|${r}`);
                  if (!cell) {
                    return (
                      <td
                        key={b}
                        className={styles.batchCellEmpty}
                        title={`${b} never shipped to ${regionName(r)}`}
                      >
                        <span className={styles.srOnly}>not sold here</span>
                      </td>
                    );
                  }
                  const v = measureOf(cell, measure);
                  const thin = cell.units < THIN_CELL;
                  const bg = measure === 'units'
                    ? divergingColor(Math.abs(v ?? 0), scale)
                    : divergingColor(v ?? 0, scale);
                  return (
                    <td
                      key={b}
                      className={`${styles.batchCell} ${thin ? styles.batchCellThin : ''}`}
                      style={{ background: bg, color: inkOn(bg) }}
                      onMouseEnter={() => setHover(cell)}
                      onMouseLeave={() => setHover(null)}
                      title={`${b} · ${regionName(r)} · ${cell.units} unit${cell.units === 1 ? '' : 's'}`}
                    >
                      <span className={styles.batchCellValue}>{format(v, measure)}</span>
                      <span className={styles.batchCellN}>
                        {cell.units}u{thin ? ' ·' : ''}
                      </span>
                    </td>
                  );
                })}
                <td className={styles.num}>{matrix.regionUnits.get(r) ?? 0}u</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.batchMatrixFoot}>
        <Legend measure={measure} scale={scale} />
        {hiddenRegions > 0 && (
          <span className={styles.geoMapSub}>
            {hiddenRegions} smaller region{hiddenRegions === 1 ? '' : 's'} not shown — all have
            fewer units than those listed.
          </span>
        )}
        {hover && (
          <span className={styles.batchHoverNote}>
            <strong>{hover.batch} · {regionName(hover.regionCode)}</strong>
            {' — '}{hover.units} unit{hover.units === 1 ? '' : 's'},{' '}
            {hover.customers} customer{hover.customers === 1 ? '' : 's'}, revenue{' '}
            {money(hover.revenue)}, contribution {money(hover.contributionMargin)}
          </span>
        )}
      </div>
    </div>
  );
}

function Legend({ measure, scale }: { measure: CellMeasure; scale: number }) {
  return (
    <div className={styles.batchLegend}>
      <span className={styles.geoMapSub}>{measure === 'units' ? 'Fewer' : 'Loss'}</span>
      <span className={styles.batchLegendRamp} aria-hidden="true">
        {(measure === 'units'
          ? [DIVERGING.neutral, DIVERGING.profitLight, DIVERGING.profit, DIVERGING.profitStrong]
          : [DIVERGING.lossStrong, DIVERGING.loss, DIVERGING.lossLight,
             DIVERGING.neutral,
             DIVERGING.profitLight, DIVERGING.profit, DIVERGING.profitStrong]
        ).map(c => (
          <span key={c} style={{ background: c }} />
        ))}
      </span>
      <span className={styles.geoMapSub}>{measure === 'units' ? 'More' : 'Profit'}</span>
      <span className={styles.batchLegendSpacer} />
      <span className={styles.batchLegendHatch} aria-hidden="true" />
      <span className={styles.geoMapSub}>Not sold in this region</span>
      <span className={styles.batchLegendSpacer} />
      <span className={styles.geoMapSub}>
        {measure === 'units' ? `Scale to ${Math.round(scale)} units` : `Scale ±${format(scale, measure)}`}
      </span>
    </div>
  );
}

function format(v: number | null, m: CellMeasure): string {
  if (v == null) return '—';
  if (m === 'units') return `${Math.round(v)}`;
  if (m === 'contributionMarginPct') return `${(v * 100).toFixed(0)}%`;
  return money(v);
}

function money(v: number | null): string {
  if (v == null) return '—';
  const sign = v < 0 ? '−' : '';
  const abs = Math.abs(v);
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  return `${sign}$${Math.round(abs)}`;
}
