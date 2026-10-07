import type { BatchMetrics } from '../../../lib/batchProfitability';
import { USD_CAD, landedCostPerUnit, sellableBand } from '../../../lib/batchLandedCost';
import type { FutureBatchRow } from '../../../lib/customers';
import styles from '../Customers.module.css';

/**
 *  The batch leaderboard.
 *
 *  Ordered by production chronology rather than by profit, because batches are
 *  a product timeline — P50 → P150 → P50N → P100 — and the interesting reading
 *  is the trend across them, not a ranking. The best and worst are called out
 *  above the table instead, so the ranking is still one glance away.
 *
 *  The market column is context, not a dimension: batch and geography are the
 *  same variable here, so the tab compares batches to batches and never breaks
 *  one down by region.
 *
 *  Cost per unit is shown next to the batch's invoiced landed cost, because
 *  the two disagree and operators need to see that they do: order COGS is
 *  booked on a `schedule` basis for the older batches, so a P150 shows well
 *  above the $345 the factory actually invoiced.
 */
export function BatchTable({
  batches,
  onSelect,
  selected,
}: {
  batches: BatchMetrics[];
  onSelect?: (key: string) => void;
  selected?: string | null;
}) {
  if (batches.length === 0) {
    return <div className={styles.empty}>No shipped units carry a batch yet.</div>;
  }

  return (
    <div className={styles.segTableWrap}>
      <table className={styles.segTable}>
        <thead>
          <tr>
            <th>Batch</th>
            <th>Shipping era</th>
            <th>Market</th>
            <th className={styles.num}>Units</th>
            <th className={styles.num}>Customers</th>
            <th className={styles.num}>Revenue</th>
            <th className={styles.num}>COGS / unit</th>
            <th className={styles.num}>COGS basis</th>
            <th className={styles.num}>Landed / unit</th>
            <th className={styles.num}>Cost / sellable</th>
            <th className={styles.num}>Yield</th>
            <th className={styles.num}>Freight / unit</th>
            <th className={styles.num}>Warranty</th>
            <th className={styles.num}>Contribution</th>
            <th className={styles.num}>CM %</th>
            <th className={styles.num}>Profit / unit</th>
            <th className={styles.num}>Attributed</th>
          </tr>
        </thead>
        <tbody>
          {batches.map(b => (
            <tr
              key={b.key}
              className={[
                b.lifetimeProfit < 0 ? styles.segLoss : '',
                selected === b.key ? styles.segSelected : '',
                onSelect ? styles.segClickable : '',
              ].filter(Boolean).join(' ')}
              onClick={() => onSelect?.(b.key)}
            >
              <td className={styles.segName}>
                {b.lifetimeProfit < 0 && (
                  <span className={styles.lossMark} aria-label="loss-making">▼</span>
                )}
                {b.label}
              </td>
              <td className={styles.batchEra}>{era(b)}</td>
              <td className={styles.batchMarket} title={marketTitle(b.marketMix)}>{market(b.marketMix)}</td>
              <td className={styles.num}>{b.units}</td>
              <td className={styles.num}>
                {b.customers}
                {b.mixedBatchCustomers > 0 && (
                  <span
                    className={styles.batchMixedMark}
                    title={`${b.mixedBatchCustomers} of these customers also own a unit from another batch — their costs are split across batches`}
                  >*</span>
                )}
              </td>
              <td className={styles.num}>{money(b.revenue)}</td>
              <td className={styles.num}>{money(perUnit(b.costs.cogs, b.units))}</td>
              <td className={styles.num}>
                {b.cogsModelledPct == null ? (
                  <span className={styles.unpriced}>unknown</span>
                ) : b.cogsModelledPct >= 0.9 ? (
                  <span
                    className={styles.cogsModelled}
                    title="Cost is a modelled schedule figure, not the factory invoice — for the pre-P100 batches that schedule is a flat legacy number that does not track this batch's landed cost. Treat the margin as indicative only."
                  >modelled</span>
                ) : b.cogsModelledPct > 0 ? (
                  <span title={`${Math.round((1 - b.cogsModelledPct) * 100)}% of orders costed from the factory invoice`}>
                    {Math.round((1 - b.cogsModelledPct) * 100)}% invoiced
                  </span>
                ) : (
                  <span title="Every order costed from the factory invoice">invoiced</span>
                )}
              </td>
              <td className={styles.num}><LandedCell batch={b} /></td>
              <td className={styles.num}><SellableCell batch={b} /></td>
              <td className={styles.num}><YieldCell batch={b} /></td>
              <td className={styles.num}>{money(perUnit(b.costs.shipping, b.units))}</td>
              <td className={styles.num}>{money(b.warrantyCost)}</td>
              <td className={`${styles.num} ${b.contributionMargin < 0 ? styles.negative : ''}`}>
                {money(b.contributionMargin)}
              </td>
              <td className={styles.num}>{pct(b.contributionMarginPct)}</td>
              <td className={`${styles.num} ${(b.profitPerUnit ?? 0) < 0 ? styles.negative : styles.positive}`}>
                {money(b.profitPerUnit)}
              </td>
              <td className={styles.num}>
                <span
                  title={
                    b.coverage.unattributed > 0
                      ? `${b.coverage.unattributed} shipped unit(s) could not be traced to a customer and carry no margin here`
                      : 'Every shipped unit is traced to a customer'
                  }
                  className={b.coverage.unattributed > 0 ? styles.unpriced : undefined}
                >
                  {b.coverage.attributed}/{b.coverage.shipped}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Batches that exist but have shipped nothing — P100X. Rendered as a separate
 *  panel rather than a table row with zeroes, because a zero in a profit
 *  column reads as "broke even" and this batch has simply not sold yet. */
export function FutureBatchPanel({ batches }: { batches: FutureBatchRow[] }) {
  if (batches.length === 0) return null;

  return (
    <div className={styles.futureBatchPanel}>
      <div className={styles.futureBatchTitle}>Not yet shipped</div>
      <p className={styles.sectionNote}>
        These batches have no units in customers' hands, so they have no margin — not a
        margin of zero. They appear here so the production pipeline is visible beside the
        batches that have sold.
      </p>
      <div className={styles.futureBatchGrid}>
        {batches.map(b => (
          <div key={b.id} className={styles.futureBatchCard}>
            <div className={styles.futureBatchName}>{b.id}</div>
            <dl className={styles.futureBatchFacts}>
              <div><dt>Units on order</dt><dd>{b.unitCount}</dd></div>
              <div>
                <dt>Landed cost / unit</dt>
                <dd><FutureLandedCost batch={b} /></dd>
              </div>
              <div>
                <dt>Expected arrival</dt>
                <dd>
                  {b.arrivedAt ?? b.expectedArrival ?? <span className={styles.unpriced}>unscheduled</span>}
                </dd>
              </div>
              {b.manufacturer && <div><dt>Manufacturer</dt><dd>{b.manufacturer}</dd></div>}
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A batch that has not sold yet still has a cost — P100X is priced at P100
 *  parity until the factory invoices it. Labelled `est` so nobody mistakes the
 *  assumption for a number LC has actually quoted. */
function FutureLandedCost({ batch }: { batch: FutureBatchRow }) {
  const l = landedCostPerUnit({
    batchId: batch.id,
    invoiceUnitCostUsd: batch.unitCostUsd,
    unitCount: batch.unitCount,
  });
  if (!l) return <span className={styles.unpriced}>not invoiced yet</span>;

  return (
    <span title={l.note ?? undefined}>
      ${round(l.landedUsd)} USD
      {l.basis === 'estimated' && (
        <span className={styles.cogsModelled} style={{ marginLeft: 4 }}>est</span>
      )}
    </span>
  );
}

/**
 *  Landed cost per unit — the factory invoice normalised onto one basis.
 *
 *  Shown next to booked COGS because the two answer different questions:
 *  COGS is what the order was costed at, landed is what the machine actually
 *  cost to put on a shelf in Toronto. For the pre-P100 batches they disagree
 *  by roughly 2x, and the gap is the point of the column.
 */
function LandedCell({ batch }: { batch: BatchMetrics }) {
  const l = batch.landed;
  if (!l) return <span className={styles.unpriced}>unpriced</span>;

  const parts = [
    `Factory invoice $${round(l.invoiceUsd)}${l.invoiceAssumed ? ' (assumed — not invoiced yet)' : ''}`,
    l.freightUsd > 0
      ? `+ inbound freight $${round(l.freightUsd)}`
      : `freight already inside the price (${l.incoterm})`,
    `+ customs brokerage $${l.clearanceUsd.toFixed(2)}`,
    `= $${l.landedUsd.toFixed(2)} USD / $${round(l.landedCad)} CAD landed Toronto`,
    l.note ?? '',
    `Duty charged at 0% (HS 8479.89.90, MFN duty-free). If it classifies as an appliance instead, add ~$${round(l.dutyExposureUsd)}/unit.`,
  ].filter(Boolean);

  return (
    <span title={parts.join('\n')}>
      {money(l.landedCad)}
      {l.basis === 'estimated' && (
        <span className={styles.cogsModelled} style={{ marginLeft: 4 }}>est</span>
      )}
    </span>
  );
}

/** Landed cost spread over the units that survived production. This is the
 *  column that actually separates the batches — the invoice prices are within
 *  9% of each other, the yield-adjusted costs are not. */
function SellableCell({ batch }: { batch: BatchMetrics }) {
  const c = batch.costPerSellable;
  const census = batch.census;
  if (!c || !census) return <span className={styles.unpriced}>—</span>;

  const wide = c.high - c.low > c.low * 0.1;
  const title = wide
    ? `$${round(c.low)}–$${round(c.high)} CAD depending on how ${census.rework + census.lost} `
      + `unresolved unit(s) settle. Low: rework recovered and "lost" units found. `
      + `High: both written off. The batch paid for all ${census.total} units either way.`
    : `The batch's landed cost spread over the ${census.total - census.scrap} units that survived.`;

  return (
    <span title={title} className={wide ? styles.cogsModelled : undefined}>
      {wide
        ? `${money(c.low * USD_CAD)}–${money(c.high * USD_CAD)}`
        : money(c.high * USD_CAD)}
    </span>
  );
}

/** Good units over units bought. The single number that explains why P100
 *  beats P150 by far more than their invoice prices suggest. */
function YieldCell({ batch }: { batch: BatchMetrics }) {
  const census = batch.census;
  if (!census || census.total === 0) return <span className={styles.unpriced}>—</span>;

  const band = sellableBand(census);
  const lowPct = band.low / census.total;
  const highPct = band.high / census.total;
  const wide = highPct - lowPct > 0.05;

  const title = [
    `${census.total} units bought`,
    census.scrap > 0 ? `${census.scrap} scrapped` : '',
    census.lost > 0 ? `${census.lost} lost` : '',
    census.rework > 0 ? `${census.rework} in rework` : '',
    `${census.shipped} shipped, ${census.ready} ready`,
  ].filter(Boolean).join(' · ');

  return (
    <span title={title} className={lowPct < 0.5 ? styles.negative : undefined}>
      {wide ? `${pct(lowPct)}–${pct(highPct)}` : pct(highPct)}
    </span>
  );
}

function round(v: number): string {
  return Math.round(v).toLocaleString('en-CA');
}

/** "100% CA" / "55% US · 45% CA" — context for comparing two batches, never a
 *  basis for a per-region margin. */
function market(mix: BatchMetrics['marketMix']): string {
  const known = mix.filter(m => m.country !== 'unknown');
  const total = known.reduce((s, m) => s + m.units, 0);
  if (total === 0) return '—';
  return known
    .slice(0, 2)
    .map(m => `${Math.round((m.units / total) * 100)}% ${m.country}`)
    .join(' · ');
}

function marketTitle(mix: BatchMetrics['marketMix']): string {
  return mix.map(m => `${m.country}: ${m.units}`).join(', ');
}

function era(b: BatchMetrics): string {
  if (!b.firstShipped) return '—';
  const from = b.firstShipped.slice(0, 7);
  const to = b.lastShipped ? b.lastShipped.slice(0, 7) : from;
  return from === to ? from : `${from} → ${to}`;
}

function perUnit(total: number, units: number): number | null {
  return units > 0 ? total / units : null;
}

function money(v: number | null): string {
  if (v == null) return '—';
  const sign = v < 0 ? '−' : '';
  return `${sign}$${Math.abs(Math.round(v)).toLocaleString('en-CA')}`;
}

function pct(v: number | null): string {
  if (v == null) return '—';
  return `${(v * 100).toFixed(0)}%`;
}
