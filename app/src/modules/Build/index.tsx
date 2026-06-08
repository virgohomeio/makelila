import { useMemo, useState } from 'react';
import {
  useFactoryOrders, useFreightShipments, useBuildDefects, useBurnInTests,
  assignSerial,
} from '../../lib/build';
import { useUnits } from '../../lib/stock';
import { PipelineBoard } from './PipelineBoard';
import { TableView } from './TableView';
import { NewPOModal } from './NewPOModal';
import { useIsMobile } from '../../lib/useMediaQuery';
import { MobileTabbedModule, type MobileTab } from '../../components/MobileTabbedModule';
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
  const isMobile = useIsMobile();
  const [showNewPO, setShowNewPO] = useState(false);
  const [showClaimSerial, setShowClaimSerial] = useState<{ batch: string } | null>(null);
  const [claimSerial, setClaimSerial] = useState('');
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

  async function submitClaim() {
    if (!showClaimSerial) return;
    const s = claimSerial.trim();
    if (!/^LL01-\d{11}$/.test(s)) { setClaimError('Format: LL01-NNNNNNNNNNN'); return; }
    setClaimBusy(true); setClaimError(null);
    try {
      await assignSerial({ serial: s, batch: showClaimSerial.batch });
      setShowClaimSerial(null); setClaimSerial('');
    } catch (e) { setClaimError((e as Error).message); }
    finally { setClaimBusy(false); }
  }

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

  // Mobile: hide the KPI strip + filter row (they wrap awkwardly on 375px)
  // and present the Pipeline Board / Table View toggle as two NavCards.
  // Search lives in each tab's own header.
  if (isMobile) {
    const mobileTabs: MobileTab<View>[] = [
      {
        key: 'board',
        label: 'Pipeline Board',
        subtitle: 'Kanban across PO → production → ship → CA-test',
        icon: '🏗️',
        iconBg: '#e6f4ea',
        content: loading
          ? <div className={styles.loading}>Loading Build pipeline…</div>
          : <PipelineBoard
              orders={orders}
              shipments={shipments}
              defects={defects}
              tests={tests}
              units={units}
              batchFilter={batchFilter}
              search={search}
            />,
      },
      {
        key: 'table',
        label: 'Table View',
        subtitle: 'Sortable list of all units in-flight',
        icon: '📋',
        iconBg: '#e3f0fb',
        content: loading
          ? <div className={styles.loading}>Loading Build pipeline…</div>
          : <TableView
              orders={orders}
              shipments={shipments}
              defects={defects}
              tests={tests}
              units={units}
              batchFilter={batchFilter}
              search={search}
            />,
      },
    ];
    return (
      <>
        <div className={styles.layout}>
          <MobileTabbedModule tabs={mobileTabs} />
        </div>
        {showNewPO && <NewPOModal onClose={() => setShowNewPO(false)} />}
      </>
    );
  }

  return (
    <>
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
          <button className={styles.btnPrimary} onClick={() => setShowNewPO(true)}>+ New PO</button>
          <button className={styles.btnSecondary} onClick={() => { setShowClaimSerial({ batch: 'P100' }); setClaimSerial(''); setClaimError(null); }}>+ Claim serial</button>
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
    {showNewPO && <NewPOModal onClose={() => setShowNewPO(false)} />}
    {showClaimSerial && (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
           onClick={() => setShowClaimSerial(null)}>
        <div onClick={e => e.stopPropagation()}
          style={{ background: '#fff', borderRadius: 'var(--radius-md)', padding: 20, width: 380 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>Claim a serial</h3>
          <div style={{ marginBottom: 10 }}>
            <label style={{ display: 'block', fontSize: 12, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Batch</label>
            <select
              className={styles.input}
              value={showClaimSerial.batch}
              onChange={e => setShowClaimSerial({ batch: e.target.value })}
            >
              {(['P50N', 'P100', 'P100X', 'P200'] as const).map(b => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
          <input className={styles.input} placeholder="LL01-00000000XYZ"
            value={claimSerial}
            onChange={e => setClaimSerial(e.target.value.toUpperCase())} />
          {claimError && <div style={{ color: 'var(--color-error)', fontSize: 11, marginTop: 6 }}>{claimError}</div>}
          <div className={styles.actionsRow}>
            <button className={styles.btnPrimary} disabled={claimBusy} onClick={submitClaim}>Create unit</button>
            <button className={styles.btnSecondary} disabled={claimBusy} onClick={() => setShowClaimSerial(null)}>Cancel</button>
          </div>
        </div>
      </div>
    )}
    </>
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
