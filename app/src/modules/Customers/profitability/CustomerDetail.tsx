import type { CustomerProfitability } from '../../../lib/customers';
import {
  channelLabel, costCoverage, type CustomerMetrics,
} from '../../../lib/profitability';
import { regionName } from '../../../lib/regions';
import { DIVERGING } from './palette';
import styles from '../Customers.module.css';

/** The full profitability picture for one customer: what they paid us, what
 *  they cost us bucket by bucket, and whether the two add up to a customer
 *  worth having had.
 *
 *  Every figure traces to a bucket in the `customer_profitability` view, and
 *  anything we know to be incomplete says so at the bottom rather than being
 *  quietly rounded into the total.
 */
export function CustomerDetail({
  row, metrics, onClose,
}: {
  row: CustomerProfitability;
  metrics: CustomerMetrics;
  onClose: () => void;
}) {
  const coverage = costCoverage(row);
  const profit = metrics.lifetimeProfit;

  return (
    <div className={styles.detailPanel} role="dialog" aria-label={`Profitability for ${row.full_name}`}>
      <div className={styles.detailHead}>
        <div>
          <div className={styles.detailName}>{row.full_name}</div>
          <div className={styles.detailMeta}>
            {row.email ?? 'no email on file'}
            {row.region_code && <> · {regionName(row.region_code)}</>}
            {' · '}{channelLabel(row.acquisition_channel)}
            {row.acquired_on && <> · acquired {row.acquired_on}</>}
          </div>
        </div>
        <button className={styles.detailClose} onClick={onClose} aria-label="Close">×</button>
      </div>

      <div className={styles.detailHero} style={{ color: profit < 0 ? DIVERGING.loss : DIVERGING.profitStrong }}>
        {money(profit)}
        <span className={styles.detailHeroLabel}>lifetime contribution profit</span>
      </div>

      <div className={styles.detailCols}>
        <section>
          <h4>Revenue</h4>
          <dl className={styles.detailList}>
            <Row label="Initial purchase" value={money(metrics.initialRevenue)} />
            <Row label="Upsells since"    value={money(metrics.upsellRevenue)} />
            <Row label="Recurring"        value={metrics.recurringRevenue === 0
                                                  ? <span className={styles.unpriced}>not offered</span>
                                                  : money(metrics.recurringRevenue)} />
            <Row label="Discounts given"  value={money(-metrics.discount)} />
            <Row label="Total revenue"    value={money(metrics.revenue)} strong />
            {metrics.discountRate != null && metrics.discountRate > 0 && (
              <Row label="Discount rate" value={`${(metrics.discountRate * 100).toFixed(1)}%`} />
            )}
          </dl>
        </section>

        <section>
          <h4>Costs</h4>
          <dl className={styles.detailList}>
            <Row label="Product COGS"    value={money(metrics.costs.cogs)} />
            <Row label="Shipping"        value={money(metrics.costs.shipping)} />
            <Row label="Warranty"        value={money(metrics.costs.warranty)} />
            <Row label="Refunds"         value={money(metrics.costs.refunds)} />
            <Row label="Support"         value={row.support_cost_cad == null && row.diagnosis_call_count > 0
                                                 ? <span className={styles.unpriced}>rate not set</span>
                                                 : money(metrics.costs.support)} />
            <Row label="Return handling" value={money(metrics.costs.returnHandling)} />
            <Row label="Payment fees"    value={<Unpriced amount={metrics.costs.paymentFees} />} />
            <Row label="Sales commission" value={<Unpriced amount={metrics.costs.commission} />} />
            <Row label="Installation"    value={<Unpriced amount={metrics.costs.installation} />} />
            <Row label="Variable costs"  value={money(metrics.variableCosts)} strong />
            <Row label="CAC"             value={cacCell(metrics)} />
          </dl>
        </section>

        <section>
          <h4>Profitability</h4>
          <dl className={styles.detailList}>
            <Row label="Contribution margin" value={money(metrics.contributionMargin)} />
            <Row label="Contribution margin %"
                 value={metrics.contributionMarginPct == null ? '—'
                        : `${(metrics.contributionMarginPct * 100).toFixed(0)}%`} />
            <Row label="Realized LTV"  value={money(metrics.realizedLtv)} />
            <Row label="Projected LTV" value={
              metrics.projectedLtv === metrics.realizedLtv
                ? <span className={styles.unpriced}>same as realized — no recurring revenue</span>
                : money(metrics.projectedLtv)} />
            <Row label="LTV:CAC" value={metrics.ltvCac == null ? '—' : `${metrics.ltvCac.toFixed(1)}×`} />
            <Row label="CAC payback" value={paybackLabel(metrics)} />
            <Row label="Lifetime profit" value={money(profit)} strong />
          </dl>
        </section>

        <section>
          <h4>Reliability &amp; service</h4>
          <dl className={styles.detailList}>
            <Row label="Orders"            value={String(row.order_count)} />
            <Row label="Units shipped"     value={String(row.units_shipped_count)} />
            <Row label="Replacements"      value={String(row.replacement_count)} />
            <Row label="Open replacements" value={String(row.open_replacement_count)} />
            <Row label="Returns handled"   value={String(row.returns_handled)} />
            <Row label="Refunds"           value={String(row.refund_count)} />
            <Row label="Support tickets"   value={String(row.ticket_count)} />
            <Row label="Diagnosis calls"
                 value={row.diagnosis_call_count === 0 ? '0'
                        : `${row.diagnosis_call_count} (${Math.round(row.diagnosis_minutes)} min)`} />
          </dl>
        </section>
      </div>

      <div className={styles.detailUsage}>
        <h4>Usage</h4>
        <p>
          No usage data reaches this database. Cycles, waste processed and active-usage
          rate live in the Lovely machine dashboard and are not joined to financial
          records, so they are left out rather than estimated.
        </p>
      </div>

      {!coverage.complete && (
        <div className={styles.detailGaps}>
          <strong>This margin is an upper bound.</strong>
          <ul>{coverage.gaps.map(g => <li key={g}>{g}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className={strong ? styles.detailRowStrong : undefined}>
      <dt>{label}</dt><dd>{value}</dd>
    </div>
  );
}

/** A zero here means Finance has not set the rate, not that the cost is nil. */
function Unpriced({ amount }: { amount: number }) {
  if (amount === 0) return <span className={styles.unpriced}>unpriced</span>;
  return <>{money(amount)}</>;
}

function cacCell(m: CustomerMetrics): React.ReactNode {
  if (m.cacBasis === 'unknown') return <span className={styles.unpriced}>no acquisition date</span>;
  if (m.cacBasis === 'no_spend') return <span className={styles.unpriced}>no spend on file</span>;
  return money(m.cac ?? 0);
}

function paybackLabel(m: CustomerMetrics): React.ReactNode {
  switch (m.payback.status) {
    case 'no_cac':    return <span className={styles.unpriced}>nothing spent to acquire</span>;
    case 'unknown':   return <span className={styles.unpriced}>CAC unknown</span>;
    case 'immediate': return 'recovered at the sale';
    case 'not_recovered':
      return `${money(m.payback.remainingCad)} still to recover`;
  }
}

function money(v: number | null): string {
  if (v == null) return '—';
  const sign = v < 0 ? '−' : '';
  return `${sign}$${Math.abs(v).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
