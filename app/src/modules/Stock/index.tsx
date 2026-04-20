import { useMemo, useState } from 'react';
import {
  useBatches, useUnits, useStatusCountsByBatch,
  STATUS_META, STATUS_ORDER, getStatusMeta,
  type UnitStatus, type StatusCategory,
} from '../../lib/stock';
import { BatchCards } from './BatchCards';
import { UnitTable } from './UnitTable';
import styles from './Stock.module.css';

type CategoryFilter = 'all' | StatusCategory;

export default function Stock() {
  const { batches, loading: bLoading } = useBatches();
  const { units, loading: uLoading } = useUnits();
  const countsByBatch = useStatusCountsByBatch(units);

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

      <UnitTable units={filtered} />
    </div>
  );
}
