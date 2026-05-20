import { useMemo, useState } from 'react';
import {
  useFactoryOrders, useFreightShipments, useBuildDefects, useBurnInTests,
} from '../../lib/build';
import { useUnits } from '../../lib/stock';
import { PipelineBoard } from './PipelineBoard';
import { TableView } from './TableView';
import styles from './Build.module.css';

type View = 'board' | 'table';
const BATCH_FILTERS = ['all', 'P50N', 'P100', 'P100X', 'P200'] as const;
type BatchFilter = typeof BATCH_FILTERS[number];

export default function Build() {
  const { orders, loading: oLoading } = useFactoryOrders();
  const { shipments, loading: sLoading } = useFreightShipments();
  const { defects, loading: dLoading } = useBuildDefects();
  const { tests, loading: tLoading } = useBurnInTests();
  const { units, loading: uLoading } = useUnits();
  const [view, setView] = useState<View>('board');
  const [batchFilter, setBatchFilter] = useState<BatchFilter>('all');
  const [search, setSearch] = useState('');

  const stats = useMemo(() => {
    const inFlight = orders.filter(o => ['placed','in_production','ready_to_ship','shipped'].includes(o.status));
    const inFlightBatches = [...new Set(inFlight.map(o => o.batch))];
    const unitsInCA = units.filter(u => ['inbound','ca-test','rework'].includes(u.status)).length;
    const openDefects = defects.filter(d => d.status === 'open' || d.status === 'in_rework');
    const criticalDefects = openDefects.filter(d => d.severity === 'critical').length;
    const burnInQueue = tests.filter(t => !t.ended_at).length;
    const ready = units.filter(u => u.status === 'ready').length;
    return {
      inFlightCount: inFlight.length,
      inFlightBatches,
      unitsInCA,
      openDefects: openDefects.length,
      criticalDefects,
      burnInQueue,
      ready,
    };
  }, [orders, units, defects, tests]);

  const loading = oLoading || sLoading || dLoading || tLoading || uLoading;

  return (
    <div className={styles.layout}>
      <div className={styles.header}>
        <div className={styles.kpiStrip}>
          <Kpi label="Batches in flight" value={stats.inFlightCount}
            sub={stats.inFlightBatches.join(' · ') || '—'} />
          <Kpi label="Units in CA" value={stats.unitsInCA} sub="inbound → ready" />
          <Kpi label="Open defects" value={stats.openDefects}
            sub={stats.criticalDefects > 0 ? `${stats.criticalDefects} critical` : 'all <critical'} />
          <Kpi label="Burn-in queue" value={stats.burnInQueue} sub="running" />
          <Kpi label="Ready" value={stats.ready} sub="→ fulfillment" />
        </div>
        <div className={styles.filterRow}>
          {BATCH_FILTERS.map(b => (
            <button
              key={b}
              className={`${styles.chip} ${batchFilter === b ? styles.chipActive : ''}`}
              onClick={() => setBatchFilter(b)}
            >{b === 'all' ? 'All' : b}</button>
          ))}
          <input
            className={styles.search}
            placeholder="Search serial, PO, container…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div className={styles.viewToggle}>
            <button
              className={`${styles.chip} ${view === 'board' ? styles.chipActive : ''}`}
              onClick={() => setView('board')}
            >Board</button>
            <button
              className={`${styles.chip} ${view === 'table' ? styles.chipActive : ''}`}
              onClick={() => setView('table')}
            >Table</button>
          </div>
        </div>
      </div>
      {loading ? (
        <div className={styles.loading}>Loading Build pipeline…</div>
      ) : view === 'board' ? (
        <PipelineBoard
          orders={orders}
          shipments={shipments}
          defects={defects}
          tests={tests}
          units={units}
          batchFilter={batchFilter}
          search={search}
        />
      ) : (
        <TableView
          orders={orders}
          shipments={shipments}
          defects={defects}
          tests={tests}
          units={units}
          batchFilter={batchFilter}
          search={search}
        />
      )}
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className={styles.kpiCard}>
      <div className={styles.kpiLabel}>{label}</div>
      <div className={styles.kpiValue}>{value}</div>
      {sub && <div className={styles.kpiSub}>{sub}</div>}
    </div>
  );
}
