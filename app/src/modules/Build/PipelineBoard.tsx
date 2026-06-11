import { useMemo, useState } from 'react';
import type { FactoryOrder, FreightShipment, BuildDefect, BurnInTest } from '../../lib/build';
import type { Unit } from '../../lib/stock';
import { BatchCard } from './cards/BatchCard';
import { UnitCard } from './cards/UnitCard';
import { BatchDetail } from './panels/BatchDetail';
import { UnitDetail } from './panels/UnitDetail';
import styles from './Build.module.css';

export type BuildDemandRow = { batch: string; toBuild: number; isNextBatch: boolean };

type Props = {
  orders: FactoryOrder[];
  shipments: FreightShipment[];
  defects: BuildDefect[];
  tests: BurnInTest[];
  units: Unit[];
  batchFilter: string;
  search: string;
  // Replacement units still needed that we have no stock of (queued demand −
  // ready). Surfaced as the left-most "To Build" column. P100X / pending
  // batches are flagged isNextBatch so they queue separately.
  buildDemand: BuildDemandRow[];
  onStartPO: (batch: string, qty: number) => void;
};

export function PipelineBoard({ orders, shipments, defects, tests, units, batchFilter, search, buildDemand, onStartPO }: Props) {
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [selectedUnitSerial, setSelectedUnitSerial] = useState<string | null>(null);

  const filterMatch = (text: string) => !search || text.toLowerCase().includes(search.toLowerCase());

  const cols = useMemo(() => {
    const inProduction = orders.filter(o =>
      (o.status === 'placed' || o.status === 'in_production') &&
      (batchFilter === 'all' || o.batch === batchFilter) &&
      filterMatch(`${o.po_number} ${o.batch}`)
    );
    const inFreight = shipments
      .filter(s => s.status !== 'arrived')
      .map(s => ({ s, o: orders.find(o => o.id === s.po_id) }))
      .filter(x => x.o &&
        (batchFilter === 'all' || x.o.batch === batchFilter) &&
        filterMatch(`${x.o.po_number} ${x.s.container_no ?? ''} ${x.o.batch}`)
      ) as { s: FreightShipment; o: FactoryOrder }[];

    const filteredUnits = units.filter(u =>
      (batchFilter === 'all' || u.batch === batchFilter) &&
      filterMatch(`${u.serial} ${u.batch} ${u.customer_name ?? ''}`)
    );
    const iqc    = filteredUnits.filter(u => u.status === 'inbound' || u.status === 'ca-test');
    const rework = filteredUnits.filter(u => u.status === 'rework');
    const ready  = filteredUnits.filter(u => u.status === 'ready');

    const inBurnIn = tests
      .filter(t => !t.ended_at)
      .map(t => ({ t, u: filteredUnits.find(u => u.serial === t.unit_serial) }))
      .filter(x => x.u) as { t: BurnInTest; u: Unit }[];

    const toBuild = buildDemand
      .filter(r => (batchFilter === 'all' || r.batch === batchFilter) && filterMatch(r.batch))
      // current batches first, next-batch (P100X) queued separately at the end
      .sort((a, b) => Number(a.isNextBatch) - Number(b.isNextBatch) || a.batch.localeCompare(b.batch));

    return { toBuild, inProduction, inFreight, iqc, rework, inBurnIn, ready };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, shipments, units, tests, batchFilter, search, buildDemand]);

  const defectsBySerial = useMemo(() => {
    const m = new Map<string, BuildDefect[]>();
    for (const d of defects) {
      const list = m.get(d.unit_serial) ?? [];
      list.push(d);
      m.set(d.unit_serial, list);
    }
    return m;
  }, [defects]);

  const selectedOrder = selectedOrderId ? orders.find(o => o.id === selectedOrderId) ?? null : null;
  const selectedUnit = selectedUnitSerial ? units.find(u => u.serial === selectedUnitSerial) ?? null : null;

  return (
    <>
      <div className={styles.board}>
        <Column title="To Build" count={cols.toBuild.length}>
          {cols.toBuild.map(r => (
            <div key={r.batch} className={styles.buildDemandCard} data-next={r.isNextBatch ? 'true' : undefined}>
              <div className={styles.buildDemandTop}>
                <strong>{r.batch}</strong>
                {r.isNextBatch && <span className={styles.buildDemandNext}>next batch</span>}
              </div>
              <div className={styles.buildDemandQty}>{r.toBuild} unit{r.toBuild !== 1 ? 's' : ''} to build</div>
              <div className={styles.buildDemandSub}>for queued replacements</div>
              <button className={styles.buildDemandBtn} onClick={() => onStartPO(r.batch, r.toBuild)}>Start a PO</button>
            </div>
          ))}
        </Column>
        <Column title="PO / Production" count={cols.inProduction.length}>
          {cols.inProduction.map(o => (
            <BatchCard key={o.id} mode="po" order={o}
              unitsMadeCount={units.filter(u => u.batch === o.batch).length}
              onClick={() => setSelectedOrderId(o.id)} />
          ))}
        </Column>
        <Column title="Freight" count={cols.inFreight.length}>
          {cols.inFreight.map(({ s, o }) => (
            <BatchCard key={s.id} mode="freight" order={o} freight={s}
              onClick={() => setSelectedOrderId(o.id)} />
          ))}
        </Column>
        <Column title="IQC" count={cols.iqc.length}>
          {cols.iqc.map(u => (
            <UnitCard key={u.serial} mode="iqc" unit={u}
              defects={defectsBySerial.get(u.serial) ?? []}
              onClick={() => setSelectedUnitSerial(u.serial)} />
          ))}
        </Column>
        <Column title="Rework" count={cols.rework.length}>
          {cols.rework.map(u => (
            <UnitCard key={u.serial} mode="rework" unit={u}
              defects={defectsBySerial.get(u.serial) ?? []}
              onClick={() => setSelectedUnitSerial(u.serial)} />
          ))}
        </Column>
        <Column title="Burn-in" count={cols.inBurnIn.length}>
          {cols.inBurnIn.map(({ t, u }) => (
            <UnitCard key={u.serial} mode="burnin" unit={u}
              defects={defectsBySerial.get(u.serial) ?? []}
              test={t}
              onClick={() => setSelectedUnitSerial(u.serial)} />
          ))}
        </Column>
        <Column title="Ready" count={cols.ready.length}>
          {cols.ready.map(u => (
            <UnitCard key={u.serial} mode="ready" unit={u}
              defects={defectsBySerial.get(u.serial) ?? []}
              onClick={() => setSelectedUnitSerial(u.serial)} />
          ))}
        </Column>
      </div>
      {selectedOrder && (
        <BatchDetail
          order={selectedOrder}
          freight={shipments.find(s => s.po_id === selectedOrder.id) ?? null}
          unitsLanded={units.filter(u => u.batch === selectedOrder.batch).length}
          onClose={() => setSelectedOrderId(null)} />
      )}
      {selectedUnit && (
        <UnitDetail
          unit={selectedUnit}
          defects={defectsBySerial.get(selectedUnit.serial) ?? []}
          tests={tests.filter(t => t.unit_serial === selectedUnit.serial)}
          onClose={() => setSelectedUnitSerial(null)} />
      )}
    </>
  );
}

function Column({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className={styles.column}>
      <div className={styles.columnHead}>
        <span>{title}</span>
        <span className={styles.columnCount}>{count}</span>
      </div>
      <div className={styles.columnBody}>
        {count === 0 ? <div style={{ fontSize: 10, color: 'var(--color-ink-faint)' }}>(empty)</div> : children}
      </div>
    </div>
  );
}
