import { useMemo, useState } from 'react';
import {
  useBatches, useUnits, useStatusCountsByBatch,
  STATUS_META, STATUS_ORDER, getStatusMeta,
  type UnitStatus, type StatusCategory,
} from '../../lib/stock';
import { BatchCards } from './BatchCards';
import { UnitTable } from './UnitTable';
import { TestReportUploader } from './TestReportUploader';
import { useReplacementOrders } from '../../lib/orders';
import { replacementUnitDemandByBatch } from '../../lib/replacementTags';
import styles from './Stock.module.css';

type CategoryFilter = 'all' | StatusCategory;

export function UnitsTab() {
  const { batches, loading: bLoading } = useBatches();
  const { units, loading: uLoading } = useUnits();
  const { orders: replacementOrders } = useReplacementOrders();
  const countsByBatch = useStatusCountsByBatch(units);
  const validSerials = useMemo(() => new Set(units.map(u => u.serial)), [units]);

  // Replacement demand for whole units (Service > Replacement) vs ready supply.
  // toBuild = queued unit demand not yet covered by ready stock for that batch.
  const unitSupplyDemand = useMemo(() => {
    const demandByBatch = replacementUnitDemandByBatch(replacementOrders);
    const totalReady = units.filter(u => u.status === 'ready').length;
    // Show every batch that has ready stock or queued demand, plus always P100X.
    const batchIds = new Set<string>([...demandByBatch.keys(), 'P100X']);
    for (const b of batches) if ((countsByBatch.get(b.id)?.ready ?? 0) > 0) batchIds.add(b.id);
    const order = (id: string) => ({ P100: 0, P100X: 1, P150: 2 } as Record<string, number>)[id] ?? 9;
    const rows = [...batchIds]
      .map(id => {
        const ready = countsByBatch.get(id)?.ready ?? 0;
        const demand = demandByBatch.get(id) ?? 0;
        return { batch: id, ready, demand, toBuild: Math.max(0, demand - ready) };
      })
      .filter(r => r.ready > 0 || r.demand > 0)
      .sort((a, b) => order(a.batch) - order(b.batch) || a.batch.localeCompare(b.batch));
    const totalToBuild = rows.reduce((n, r) => n + r.toBuild, 0);
    return { rows, totalReady, totalToBuild, p100x: demandByBatch.get('P100X') ?? 0 };
  }, [replacementOrders, units, batches, countsByBatch]);

  const [batchFilter, setBatchFilter] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [statusFilter, setStatusFilter] = useState<UnitStatus | null>(null);
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return units.filter(u => {
      if (batchFilter && u.batch !== batchFilter) return false;
      if (statusFilter && u.status !== statusFilter) return false;
      if (categoryFilter !== 'all' && getStatusMeta(u.status).category !== categoryFilter) return false;
      if (q && !(
        u.serial.toLowerCase().includes(q) ||
        (u.customer_name?.toLowerCase().includes(q)) ||
        (u.customer_order_ref?.toLowerCase().includes(q)) ||
        (u.carrier?.toLowerCase().includes(q)) ||
        (u.location?.toLowerCase().includes(q))
      )) return false;
      return true;
    });
  }, [units, batchFilter, statusFilter, categoryFilter, search]);

  if (bLoading || uLoading) return <div className={styles.loading}>Loading stock…</div>;

  return (
    <div className={styles.stockLayout}>
      {/* Replacement demand ↔ unit supply (Service > Replacement). Read-only summary. */}
      <div className={styles.unitDemandPanel}>
        <div className={styles.unitDemandHeader}>Replacement demand — units ready vs needed</div>
        <div className={styles.unitDemandKpis}>
          <div className={styles.unitDemandKpi}>
            <div className={styles.unitDemandKpiValue}>{unitSupplyDemand.totalReady}</div>
            <div className={styles.unitDemandKpiLabel}>Ready now</div>
          </div>
          <div className={styles.unitDemandKpi}>
            <div className={`${styles.unitDemandKpiValue} ${unitSupplyDemand.totalToBuild > 0 ? styles.unitDemandWarn : ''}`}>{unitSupplyDemand.totalToBuild}</div>
            <div className={styles.unitDemandKpiLabel}>Need to build / get ready</div>
          </div>
          <div className={styles.unitDemandKpi}>
            <div className={`${styles.unitDemandKpiValue} ${unitSupplyDemand.p100x > 0 ? styles.unitDemandWarn : ''}`}>{unitSupplyDemand.p100x}</div>
            <div className={styles.unitDemandKpiLabel}>Next batch (P100X)</div>
          </div>
        </div>
        {unitSupplyDemand.rows.length > 0 && (
          <table className={styles.unitDemandTable}>
            <thead>
              <tr><th>Model / batch</th><th>Ready</th><th>Queued (replacements)</th><th>To build / get ready</th></tr>
            </thead>
            <tbody>
              {unitSupplyDemand.rows.map(r => (
                <tr key={r.batch}>
                  <td>{r.batch}</td>
                  <td>{r.ready}</td>
                  <td>{r.demand}</td>
                  <td>{r.toBuild > 0 ? <strong className={styles.unitDemandWarn}>{r.toBuild}</strong> : 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <BatchCards
        batches={batches}
        countsByBatch={countsByBatch}
        activeBatch={batchFilter}
        onSelect={(id) => setBatchFilter(prev => prev === id ? null : id)}
      />

      <div className={styles.filterBar}>
        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Category:</span>
          {(['all','inbound','warehouse','out'] as const).map(c => (
            <button
              key={c}
              onClick={() => { setCategoryFilter(c); setStatusFilter(null); }}
              className={`${styles.chip} ${categoryFilter === c ? styles.chipActive : ''}`}
            >{c === 'all' ? 'All' : c.charAt(0).toUpperCase() + c.slice(1)}</button>
          ))}
        </div>

        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Status:</span>
          <button
            onClick={() => setStatusFilter(null)}
            className={`${styles.chip} ${!statusFilter ? styles.chipActive : ''}`}
          >All</button>
          {STATUS_ORDER.filter(s =>
            categoryFilter === 'all' || STATUS_META[s].category === categoryFilter
          ).map(s => {
            const meta = STATUS_META[s];
            return (
              <button
                key={s}
                onClick={() => setStatusFilter(prev => prev === s ? null : s)}
                className={`${styles.chip} ${statusFilter === s ? styles.chipActive : ''}`}
                style={statusFilter === s ? {
                  background: meta.bg,
                  color: meta.color,
                  borderColor: meta.border,
                } : undefined}
              >{meta.label}</button>
            );
          })}
        </div>

        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search serial, customer, carrier, location…"
          className={styles.searchInput}
        />

        <div className={styles.resultCount}>
          {filtered.length} {filtered.length === 1 ? 'unit' : 'units'}
          {filtered.length !== units.length && <> of {units.length}</>}
        </div>
      </div>

      <TestReportUploader validSerials={validSerials} />

      <UnitTable units={filtered} />
    </div>
  );
}
