import { useMemo, useState } from 'react';
import {
  type FactoryOrder, type FreightShipment, type BuildDefect, type BurnInTest,
  PO_STATUS_META, FREIGHT_STATUS_META,
} from '../../lib/build';
import type { Unit } from '../../lib/stock';
import { BatchDetail } from './panels/BatchDetail';
import { UnitDetail } from './panels/UnitDetail';
import styles from './Build.module.css';

type Props = {
  orders: FactoryOrder[];
  shipments: FreightShipment[];
  defects: BuildDefect[];
  tests: BurnInTest[];
  units: Unit[];
  batchFilter: string;
  search: string;
};

export function TableView({ orders, shipments, defects, tests, units, batchFilter, search }: Props) {
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [selectedUnitSerial, setSelectedUnitSerial] = useState<string | null>(null);

  const matchSearch = (text: string) => !search || text.toLowerCase().includes(search.toLowerCase());

  const filteredOrders = orders.filter(o =>
    (batchFilter === 'all' || o.batch === batchFilter) &&
    matchSearch(`${o.po_number} ${o.batch}`)
  );
  const filteredUnits = units.filter(u =>
    ['inbound','ca-test','rework','ready'].includes(u.status) &&
    (batchFilter === 'all' || u.batch === batchFilter) &&
    matchSearch(`${u.serial} ${u.batch}`)
  );

  const freightByPo = useMemo(() => {
    const m = new Map<string, FreightShipment>();
    for (const s of shipments) m.set(s.po_id, s);
    return m;
  }, [shipments]);
  const defectsBySerial = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of defects) {
      if (d.status === 'open' || d.status === 'in_rework') {
        m.set(d.unit_serial, (m.get(d.unit_serial) ?? 0) + 1);
      }
    }
    return m;
  }, [defects]);
  const burnInBySerial = useMemo(() => {
    const m = new Map<string, BurnInTest>();
    for (const t of tests) if (!t.ended_at) m.set(t.unit_serial, t);
    return m;
  }, [tests]);

  const selectedOrder = selectedOrderId ? orders.find(o => o.id === selectedOrderId) ?? null : null;
  const selectedUnit = selectedUnitSerial ? units.find(u => u.serial === selectedUnitSerial) ?? null : null;

  return (
    <>
      <div className={styles.tableWrap}>
        <h4 style={{ margin: '4px 0 8px', fontSize: 13 }}>Factory POs ({filteredOrders.length})</h4>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>PO #</th><th>Batch</th><th>Qty</th><th>Status</th>
              <th>Freight</th><th>ETA</th>
            </tr>
          </thead>
          <tbody>
            {filteredOrders.map(o => {
              const f = freightByPo.get(o.id);
              const poMeta = PO_STATUS_META[o.status];
              const fMeta = f ? FREIGHT_STATUS_META[f.status] : null;
              return (
                <tr key={o.id} className={styles.row} onClick={() => setSelectedOrderId(o.id)}>
                  <td className={styles.cardMono}>{o.po_number}</td>
                  <td>{o.batch}</td>
                  <td>{o.qty_ordered}</td>
                  <td><span className={styles.pill} style={{ background: poMeta.bg, color: poMeta.color }}>{poMeta.label}</span></td>
                  <td>{fMeta && <span className={styles.pill} style={{ background: fMeta.bg, color: fMeta.color }}>{fMeta.label}</span>}</td>
                  <td>{f?.eta_canada ? new Date(f.eta_canada).toLocaleDateString() : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <h4 style={{ margin: '20px 0 8px', fontSize: 13 }}>Units in Build ({filteredUnits.length})</h4>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Serial</th><th>Batch</th><th>Status</th>
              <th>Open defects</th><th>Burn-in</th>
            </tr>
          </thead>
          <tbody>
            {filteredUnits.map(u => {
              const dCount = defectsBySerial.get(u.serial) ?? 0;
              const bt = burnInBySerial.get(u.serial);
              const elapsed = bt ? Math.round((Date.now() - new Date(bt.started_at).getTime()) / 3_600_000) : null;
              return (
                <tr key={u.serial} className={styles.row} onClick={() => setSelectedUnitSerial(u.serial)}>
                  <td className={styles.cardMono}>{u.serial}</td>
                  <td>{u.batch}</td>
                  <td>{u.status}</td>
                  <td>{dCount > 0 ? dCount : '—'}</td>
                  <td>{bt ? `${elapsed}h / ${bt.duration_target_hours}h` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selectedOrder && (
        <BatchDetail
          order={selectedOrder}
          freight={freightByPo.get(selectedOrder.id) ?? null}
          unitsLanded={units.filter(u => u.batch === selectedOrder.batch).length}
          onClose={() => setSelectedOrderId(null)} />
      )}
      {selectedUnit && (
        <UnitDetail
          unit={selectedUnit}
          defects={defects.filter(d => d.unit_serial === selectedUnit.serial)}
          tests={tests.filter(t => t.unit_serial === selectedUnit.serial)}
          onClose={() => setSelectedUnitSerial(null)} />
      )}
    </>
  );
}
