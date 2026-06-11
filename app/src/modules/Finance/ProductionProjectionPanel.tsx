import { useMemo } from 'react';
import { useBatches, useUnits } from '../../lib/stock';
import { useOrders, type Order } from '../../lib/orders';
import { projectStockout, computeRiskLevel, type BatchProjection } from '../../lib/finance';
import styles from './Finance.module.css';

export function ProductionProjectionPanel() {
  const { batches, loading: batchesLoading } = useBatches();
  const { units, loading: unitsLoading } = useUnits();
  const { all: orders, loading: ordersLoading } = useOrders();

  const loading = batchesLoading || unitsLoading || ordersLoading;

  const projections = useMemo<BatchProjection[]>(() => {
    const twelveWeeksAgo = new Date(Date.now() - 84 * 24 * 3600_000).toISOString();

    return batches
      .map((batch): BatchProjection => {
        const readyCount = units.filter(u => u.batch === batch.id && u.status === 'ready').length;
        const reservedCount = units.filter(u => u.batch === batch.id && u.status === 'reserved').length;
        const shippedLast12w = units.filter(u =>
          u.batch === batch.id &&
          u.shipped_at !== null &&
          u.shipped_at >= twelveWeeksAgo,
        ).length;
        const weeklyVelocity = shippedLast12w / 12;

        const replacementQueueSize = orders.filter((o: Order) =>
          o.kind === 'replacement' &&
          o.awaiting_batch_id === batch.id,
        ).length;

        const inboundUnits = batch.arrived_at ? 0 : batch.unit_count;
        const inboundArrivalDate = batch.arrived_at ? null : (batch.expected_arrival_date ?? null);

        const projectedStockoutDate = projectStockout({
          ready: readyCount,
          velocity: weeklyVelocity,
          replacementQueue: replacementQueueSize,
          inboundUnits,
          inboundArrivalDate,
        });
        const riskLevel = computeRiskLevel(projectedStockoutDate);

        const batchLabel = batch.version ?? batch.manufacturer_short ?? batch.manufacturer;

        return {
          batchId: batch.id,
          batchLabel,
          readyCount,
          reservedCount,
          weeklyVelocity,
          projectedStockoutDate,
          replacementQueueSize,
          inboundUnits,
          inboundArrivalDate,
          riskLevel,
        };
      })
      .filter(p => p.readyCount + p.reservedCount > 0 || p.inboundUnits > 0);
  }, [batches, units, orders]);

  const redCount = projections.filter(p => p.riskLevel === 'red').length;

  if (loading) {
    return <div className={styles.loading}>Loading projections…</div>;
  }

  if (projections.length === 0) {
    return (
      <div className={styles.projectionPanel}>
        <p className={styles.projectionTitle}>Production Projection</p>
        <p className={styles.projectionSubtitle}>Live · updates in real time</p>
        <div className={styles.empty}>No active batches with inventory or inbound stock.</div>
      </div>
    );
  }

  return (
    <div className={styles.projectionPanel}>
      <p className={styles.projectionTitle}>Production Projection</p>
      <p className={styles.projectionSubtitle}>Live · updates in real time</p>

      {redCount > 0 && (
        <div className={styles.riskBanner}>
          Warning: {redCount} batch{redCount === 1 ? '' : 'es'} at risk of stockout within 30 days.
        </div>
      )}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Batch</th>
              <th>Ready</th>
              <th>Reserved</th>
              <th>Weekly Velocity</th>
              <th>Replacement Queue</th>
              <th>Inbound</th>
              <th>Projected Stockout</th>
              <th>Risk</th>
            </tr>
          </thead>
          <tbody>
            {projections.map(p => (
              <tr key={p.batchId} className={styles.row}>
                <td>{p.batchLabel}</td>
                <td>{p.readyCount}</td>
                <td>{p.reservedCount}</td>
                <td>{p.weeklyVelocity.toFixed(1)} / wk</td>
                <td>{p.replacementQueueSize}</td>
                <td>
                  {p.inboundUnits > 0
                    ? `${p.inboundUnits} units${p.inboundArrivalDate ? ` · ETA ${p.inboundArrivalDate}` : ''}`
                    : <span className={styles.dash}>—</span>}
                </td>
                <td>
                  {p.projectedStockoutDate
                    ? p.projectedStockoutDate
                    : <span className={styles.dash}>Never</span>}
                </td>
                <td>
                  <span className={
                    p.riskLevel === 'red'
                      ? styles.riskRed
                      : p.riskLevel === 'amber'
                        ? styles.riskAmber
                        : styles.riskGreen
                  }>
                    {p.riskLevel}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
