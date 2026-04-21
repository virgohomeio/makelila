import { useMemo, useState } from 'react';
import {
  useParts, usePartShipments, adjustPartStock,
  type Part, type PartCategory,
} from '../../lib/parts';
import styles from './Stock.module.css';

type CatFilter = 'all' | PartCategory;

export function PartsTab() {
  const { parts, loading: pLoading } = useParts();
  const { shipments, loading: sLoading } = usePartShipments();
  const [catFilter, setCatFilter] = useState<CatFilter>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(
    () => catFilter === 'all' ? parts : parts.filter(p => p.category === catFilter),
    [parts, catFilter],
  );

  const shipCountByPart = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of shipments) {
      m.set(s.part_id, (m.get(s.part_id) ?? 0) + s.quantity);
    }
    return m;
  }, [shipments]);

  const stats = useMemo(() => {
    const replacement = parts.filter(p => p.category === 'replacement');
    const consumable  = parts.filter(p => p.category === 'consumable');
    const lowStock = replacement.filter(p => p.on_hand <= p.reorder_point && p.reorder_point > 0).length;
    const inventoryValue = replacement.reduce(
      (sum, p) => sum + (p.on_hand * Number(p.cost_per_unit_usd ?? 0)), 0,
    );
    const now = Date.now();
    const d30 = now - 30 * 86_400_000;
    const recentShips = shipments.filter(s => {
      const t = s.shipped_at ? new Date(s.shipped_at).getTime() : 0;
      return t >= d30;
    }).reduce((n, s) => n + s.quantity, 0);
    return {
      totalParts: parts.length,
      replacementCount: replacement.length,
      consumableCount: consumable.length,
      lowStock,
      inventoryValue: Math.round(inventoryValue),
      recentShips,
      totalShipments: shipments.length,
    };
  }, [parts, shipments]);

  const adjust = async (p: Part, delta: number, reason: string) => {
    setBusy(p.id); setError(null);
    try { await adjustPartStock(p.id, delta, reason); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  if (pLoading || sLoading) return <div className={styles.loading}>Loading parts…</div>;

  return (
    <div className={styles.stockLayout}>
      <div className={styles.kpiRowParts}>
        <KPI label="Total SKUs" value={stats.totalParts} sub={`${stats.replacementCount} repl · ${stats.consumableCount} consum`} />
        <KPI label="Low stock" value={stats.lowStock} tone={stats.lowStock > 0 ? 'warn' : undefined} sub={stats.lowStock > 0 ? 'reorder needed' : 'all healthy'} />
        <KPI label="Inventory $" value={`$${stats.inventoryValue.toLocaleString('en-US')}`} sub="replacement parts on hand" />
        <KPI label="Shipped (30d)" value={stats.recentShips} sub={`${stats.totalShipments} all-time`} />
      </div>

      <div className={styles.filterBar}>
        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Category:</span>
          {(['all','replacement','consumable'] as const).map(c => (
            <button
              key={c}
              onClick={() => setCatFilter(c)}
              className={`${styles.chip} ${catFilter === c ? styles.chipActive : ''}`}
            >{c === 'all' ? 'All' : c.charAt(0).toUpperCase() + c.slice(1)}</button>
          ))}
        </div>
        {error && <div className={styles.errorBar}>{error}</div>}
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Name</th>
              <th>Category</th>
              <th>Supplier</th>
              <th className={styles.numCol}>On hand</th>
              <th className={styles.numCol}>Reorder at</th>
              <th className={styles.numCol}>Cost</th>
              <th className={styles.numCol}>Shipped</th>
              <th>Adjust</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(p => {
              const low = p.on_hand <= p.reorder_point && p.reorder_point > 0 && p.category === 'replacement';
              return (
                <tr key={p.id} className={low ? styles.rowLowStock : ''}>
                  <td className={styles.serial}>{p.sku}</td>
                  <td>{p.name}</td>
                  <td>
                    <span className={p.category === 'replacement' ? styles.badgeRepl : styles.badgeCons}>
                      {p.category}
                    </span>
                  </td>
                  <td>{p.supplier ?? <span className={styles.muted}>—</span>}</td>
                  <td className={styles.numCol}>
                    {p.category === 'replacement'
                      ? <strong className={low ? styles.lowText : ''}>{p.on_hand}</strong>
                      : <span className={styles.muted}>n/a</span>}
                  </td>
                  <td className={styles.numCol}>{p.reorder_point > 0 ? p.reorder_point : <span className={styles.muted}>—</span>}</td>
                  <td className={styles.numCol}>
                    {p.cost_per_unit_usd != null ? `$${Number(p.cost_per_unit_usd).toFixed(2)}` : <span className={styles.muted}>—</span>}
                  </td>
                  <td className={styles.numCol}>{shipCountByPart.get(p.id) ?? 0}</td>
                  <td>
                    {p.category === 'replacement' && (
                      <span className={styles.adjustGroup}>
                        <button
                          className={styles.adjustBtn}
                          onClick={() => void adjust(p, -1, 'manual decrement')}
                          disabled={busy === p.id || p.on_hand === 0}
                        >−1</button>
                        <button
                          className={styles.adjustBtn}
                          onClick={() => void adjust(p, +1, 'manual increment')}
                          disabled={busy === p.id}
                        >+1</button>
                        <button
                          className={styles.adjustBtn}
                          onClick={() => void adjust(p, +10, 'restock')}
                          disabled={busy === p.id}
                        >+10</button>
                      </span>
                    )}
                  </td>
                  <td className={styles.notes} title={p.notes ?? ''}>
                    {p.notes ?? <span className={styles.muted}>—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className={styles.partsShipHeader}>Recent Part Shipments</div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Part</th>
              <th>Qty</th>
              <th>Customer</th>
              <th>Linked unit</th>
              <th>Carrier</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {shipments.slice(0, 30).map(s => {
              const part = parts.find(p => p.id === s.part_id);
              return (
                <tr key={s.id}>
                  <td className={styles.serial}>
                    {s.shipped_at
                      ? new Date(s.shipped_at).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' })
                      : <span className={styles.muted}>—</span>}
                  </td>
                  <td>{part?.name ?? s.part_id}</td>
                  <td className={styles.numCol}>{s.quantity}</td>
                  <td>{s.customer_name ?? <span className={styles.muted}>—</span>}</td>
                  <td className={styles.serial}>
                    {s.linked_unit_serial ?? <span className={styles.muted}>—</span>}
                  </td>
                  <td>{s.carrier ?? <span className={styles.muted}>—</span>}</td>
                  <td className={styles.notes} title={s.notes ?? ''}>
                    {s.notes ?? <span className={styles.muted}>—</span>}
                  </td>
                </tr>
              );
            })}
            {shipments.length === 0 && (
              <tr><td colSpan={7} className={styles.empty}>No part shipments yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function KPI({ label, value, tone, sub }: { label: string; value: number | string; tone?: 'warn'; sub?: string }) {
  return (
    <div className={styles.kpi}>
      <div className={styles.kpiLabel}>{label}</div>
      <div className={`${styles.kpiValue} ${tone === 'warn' ? styles.kpiWarn : ''}`}>{value}</div>
      {sub && <div className={styles.kpiSub}>{sub}</div>}
    </div>
  );
}
