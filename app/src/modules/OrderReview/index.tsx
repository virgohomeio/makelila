import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { OrderStatus, AreaType } from '../../lib/orders';
import {
  useOrders, syncShopifyOrders,
  ORDER_STATUS_META, OPEN_ORDER_STATUSES, AREA_TYPE_LABEL,
} from '../../lib/orders';
import { useIsMobile } from '../../lib/useMediaQuery';
import { MobileBackHeader } from '../../components/MobileBackHeader';
import { Sidebar } from './Sidebar';
import { Detail } from './Detail';
import Templates from '../Templates';
import Upload from '../Upload';
import {
  filterOrders, statusCounts, savedViewCounts, activeFilterCount, EMPTY_FILTERS,
} from './filters';
import type { OrderFilters, SavedView } from './filters';
import { OVERDUE_DAYS } from './sla';
import styles from './OrderReview.module.css';

type SyncState =
  | { kind: 'idle' }
  | { kind: 'syncing' }
  | { kind: 'done'; imported: number; skipped: number }
  | { kind: 'error'; message: string };

const COUNTRIES = [
  { value: 'CA', label: 'Canada' },
  { value: 'US', label: 'United States' },
];
const AREAS: AreaType[] = ['urban', 'suburban', 'rural'];

export default function OrderReview() {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { all, cancelled, loading } = useOrders();

  const [view, setView] = useState<'orders' | 'templates' | 'upload'>('orders');
  const [sync, setSync] = useState<SyncState>({ kind: 'idle' });
  // The page owns every filter, the way SupportTab does — the queue bar, the
  // saved-view chips and the list all have to count the same pool.
  const [filters, setFilters] = useState<OrderFilters>(EMPTY_FILTERS);
  const set = <K extends keyof OrderFilters>(k: K, v: OrderFilters[K]) =>
    setFilters(f => ({ ...f, [k]: v }));

  // Resolved once per mount, not once per render. Every row on screen has to
  // measure its SLA against the same instant — but `now` also feeds the memo
  // that produces `visible`, and `visible` is a dependency of the auto-select
  // effect below. A fresh Date.now() each render would give that memo a new
  // identity every time, re-firing the effect and re-navigating on a loop.
  const [now] = useState(() => Date.now());

  // Cancelled sits outside `all` (it is out of the live queue) but still has to
  // be findable, so the pool the filters see is both.
  const pool = useMemo(() => [...all, ...cancelled], [all, cancelled]);
  const counts = useMemo(() => statusCounts(pool), [pool]);
  const saved = useMemo(() => savedViewCounts(pool, now), [pool, now]);
  const visible = useMemo(() => filterOrders(pool, filters, now), [pool, filters, now]);

  const selected = orderId ? pool.find(o => o.id === orderId) ?? null : null;
  const activeCount = activeFilterCount(filters);
  const openTotal = OPEN_ORDER_STATUSES.reduce((n, s) => n + counts[s], 0);

  // Desktop auto-loads the first row so the right pane isn't empty on first
  // paint. On mobile we keep the list visible (no order selected) so the
  // operator chooses what to drill into.
  useEffect(() => {
    if (!isMobile && !loading && !orderId && visible.length > 0) {
      navigate(`/order-review/${visible[0].id}`, { replace: true });
    }
  }, [isMobile, loading, orderId, visible, navigate]);

  const afterDisposition = () => {
    const remaining = visible.filter(o => o.id !== orderId);
    if (remaining.length > 0) navigate(`/order-review/${remaining[0].id}`);
    else navigate('/order-review');
  };

  const runSync = async () => {
    setSync({ kind: 'syncing' });
    try {
      const r = await syncShopifyOrders();
      setSync({ kind: 'done', imported: r.imported, skipped: r.skipped });
    } catch (e) {
      setSync({ kind: 'error', message: (e as Error).message });
    }
  };

  // Status and saved view are two ways of slicing the same queue; picking one
  // clears the other rather than silently intersecting to nothing.
  const pickStatus = (s: OrderStatus | 'all') =>
    setFilters(f => ({ ...f, status: f.status === s ? 'all' : s, savedView: null }));
  const pickSaved = (v: SavedView) =>
    setFilters(f => ({ ...f, savedView: f.savedView === v ? null : v, status: 'all' }));

  const header = (
    <div className={styles.pageHead}>
      <div>
        <h2 className={styles.pageTitle}>Sales</h2>
        <p className={styles.pageSub}>
          {loading ? 'Loading orders…' : (
            <>
              <b>{openTotal}</b> in the queue
              {' · '}<b>{counts.pending}</b> awaiting confirmation
              {' · '}<b>{saved.blocked}</b> blocked
              {' · '}<b>{saved.overdue}</b> overdue
            </>
          )}
        </p>
      </div>
      <div className={styles.pageActions}>
        {view === 'orders' && (
          <>
            <span className={styles.syncStatus}>
              {sync.kind === 'done' && `${sync.imported} new · ${sync.skipped} skipped`}
              {sync.kind === 'error' && (
                <span className={styles.syncError}>Sync failed: {sync.message}</span>
              )}
            </span>
            <button
              className={styles.addBtn}
              onClick={() => void runSync()}
              disabled={sync.kind === 'syncing'}
              title="Pull new orders from Shopify"
            >{sync.kind === 'syncing' ? 'Syncing…' : '⟲ Sync from Shopify'}</button>
          </>
        )}
        <div className={styles.viewSwitch} role="group" aria-label="View">
          <button className={view === 'orders' ? styles.viewSegOn : styles.viewSeg}
            aria-pressed={view === 'orders'} onClick={() => setView('orders')}>Orders</button>
          <button className={view === 'templates' ? styles.viewSegOn : styles.viewSeg}
            aria-pressed={view === 'templates'} onClick={() => setView('templates')}>Templates</button>
          <button className={view === 'upload' ? styles.viewSegOn : styles.viewSeg}
            aria-pressed={view === 'upload'} onClick={() => setView('upload')}>Upload</button>
        </div>
      </div>
    </div>
  );

  if (view === 'templates') return <div>{header}<Templates /></div>;
  if (view === 'upload')    return <div>{header}<Upload /></div>;

  const emptyHint = activeCount > 0
    ? 'No order matches these filters.'
    : 'Nothing in this queue.';

  const list = (
    <Sidebar
      orders={visible}
      now={now}
      selectedId={orderId ?? null}
      onSelect={(id) => navigate(`/order-review/${id}`)}
      emptyHint={emptyHint}
    />
  );

  // Mobile with a selection: single column, detail only.
  if (isMobile && selected) {
    return (
      <div className={styles.layout}>
        <MobileBackHeader
          label={`${selected.order_ref} · ${selected.customer_name}`}
          onBack={() => navigate('/order-review')}
        />
        <Detail order={selected} now={now} onAfterDisposition={afterDisposition} />
      </div>
    );
  }

  return (
    <div>
      {header}

      <QueueBar counts={counts} openTotal={openTotal} active={filters.status} onPick={pickStatus} />

      <div className={styles.savedViews}>
        <SavedViewChip label="Blocked" count={saved.blocked} tone="blocked"
          active={filters.savedView === 'blocked'} onClick={() => pickSaved('blocked')} />
        <SavedViewChip label={`Overdue ${OVERDUE_DAYS} days+`} count={saved.overdue} tone="overdue"
          active={filters.savedView === 'overdue'} onClick={() => pickSaved('overdue')} />
        <SavedViewChip label="Replacement queue" count={saved.replacement} tone="replacement"
          active={filters.savedView === 'replacement'} onClick={() => pickSaved('replacement')} />

        {filters.savedView === 'replacement' && (
          <span className={styles.savedSub}>
            <button
              className={filters.replacementSub === 'ready' ? styles.savedChipOn : styles.savedChip}
              aria-pressed={filters.replacementSub === 'ready'}
              onClick={() => set('replacementSub', 'ready')}
            >Ready to ship</button>
            <button
              className={filters.replacementSub === 'awaiting' ? styles.savedChipOn : styles.savedChip}
              aria-pressed={filters.replacementSub === 'awaiting'}
              onClick={() => set('replacementSub', 'awaiting')}
            >Awaiting stock</button>
          </span>
        )}
      </div>

      <div className={styles.toolbar}>
        <input
          className={styles.search}
          placeholder="Search name, email, order # or city…"
          aria-label="Search orders"
          value={filters.query}
          onChange={e => set('query', e.target.value)}
        />

        <Dropdown
          label={filters.country === 'all'
            ? 'Country'
            : COUNTRIES.find(c => c.value === filters.country)?.label ?? filters.country}
          active={filters.country !== 'all'}
        >
          {close => (
            <>
              <div className={styles.menuLabel}>Country</div>
              <MenuItem checked={filters.country === 'all'} label="Anywhere"
                onClick={() => { set('country', 'all'); close(); }} />
              {COUNTRIES.map(c => (
                <MenuItem key={c.value} checked={filters.country === c.value} label={c.label}
                  count={pool.filter(o => o.country === c.value).length}
                  onClick={() => { set('country', c.value); close(); }} />
              ))}
            </>
          )}
        </Dropdown>

        <Dropdown
          label={filters.area === 'all' ? 'Area' : AREA_TYPE_LABEL[filters.area]}
          active={filters.area !== 'all'}
        >
          {close => (
            <>
              <div className={styles.menuLabel}>Area type</div>
              <MenuItem checked={filters.area === 'all'} label="Any area"
                onClick={() => { set('area', 'all'); close(); }} />
              {AREAS.map(a => (
                <MenuItem key={a} checked={filters.area === a} label={AREA_TYPE_LABEL[a]}
                  count={pool.filter(o => o.area_type === a).length}
                  onClick={() => { set('area', a); close(); }} />
              ))}
            </>
          )}
        </Dropdown>

        {activeCount > 0 && (
          <button className={styles.clearBtn} onClick={() => setFilters(EMPTY_FILTERS)}>
            Clear {activeCount} filter{activeCount === 1 ? '' : 's'}
          </button>
        )}
        <span className={styles.toolbarSpacer} />
      </div>

      {isMobile ? (
        <div className={styles.layout}>{list}</div>
      ) : (
        <div className={styles.layout}>
          {list}
          {selected ? (
            <Detail order={selected} now={now} onAfterDisposition={afterDisposition} />
          ) : (
            <section className={styles.empty}>
              {loading ? 'Loading…' : 'Pick an order from the list to review it.'}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** One segmented bar sized to the real distribution, where each segment is
 *  also the filter. Same construction as the Support Tickets queue bar. */
function QueueBar({ counts, openTotal, active, onPick }: {
  counts: Record<OrderStatus, number>;
  openTotal: number;
  active: OrderStatus | 'all';
  onPick: (s: OrderStatus | 'all') => void;
}) {
  const withRows = OPEN_ORDER_STATUSES.filter(s => counts[s] > 0);
  const legend: OrderStatus[] = [...OPEN_ORDER_STATUSES, 'cancelled'];

  return (
    <div className={styles.queueBar}>
      <div className={styles.queueTrack} role="group" aria-label="Orders by status">
        {withRows.length === 0 ? (
          <span className={styles.queueEmpty}>No live orders</span>
        ) : withRows.map(s => {
          const m = ORDER_STATUS_META[s];
          const pct = openTotal > 0 ? (counts[s] / openTotal) * 100 : 0;
          return (
            <button
              key={s}
              className={styles.queueSeg}
              style={{ flexBasis: `${pct}%`, background: m.color }}
              aria-pressed={active === s}
              aria-label={`${m.label}: ${counts[s]}`}
              title={`${m.label} — ${counts[s]}`}
              onClick={() => onPick(s)}
            >
              {pct > 7 && <span className={styles.queueSegN}>{counts[s]}</span>}
            </button>
          );
        })}
      </div>

      <div className={styles.queueLegend}>
        {legend.map(s => {
          const m = ORDER_STATUS_META[s];
          const n = counts[s];
          return (
            <button
              key={s}
              className={[
                styles.legendItem,
                n === 0 ? styles.legendZero : '',
                active === s ? styles.legendOn : '',
                s === 'cancelled' ? styles.legendSep : '',
              ].filter(Boolean).join(' ')}
              aria-pressed={active === s}
              title={n === 0 ? 'No orders currently hold this status' : undefined}
              onClick={() => onPick(s)}
            >
              <span className={styles.legendDot} style={{ background: m.color }} />
              {m.label} <b>{n}</b>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SavedViewChip({ label, count, tone, active, onClick }: {
  label: string; count: number; tone: SavedView;
  active: boolean; onClick: () => void;
}) {
  return (
    <button
      className={active ? styles.savedChipOn : styles.savedChip}
      aria-pressed={active}
      // Without this the count runs into the label and the chip announces as
      // "Blocked1".
      aria-label={`${label}: ${count} order${count === 1 ? '' : 's'}`}
      onClick={onClick}
    >
      <span className={`${styles.savedDot} ${styles[`savedDot_${tone}`]}`} />
      {label}
      <span className={styles.savedCount}>{count}</span>
    </button>
  );
}

/** Popover filter. Closes on outside click and on Escape. */
function Dropdown({ label, active, children }: {
  label: string;
  active: boolean;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={styles.dropdown} ref={ref}>
      <button
        className={active ? styles.filterChipOn : styles.filterChip}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        {label}
        <span className={styles.caret} aria-hidden="true">▾</span>
      </button>
      {open && <div className={styles.menu} role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

function MenuItem({ checked, label, count, onClick }: {
  checked: boolean; label: string; count?: number; onClick: () => void;
}) {
  return (
    <button className={styles.menuItem} role="menuitemcheckbox" aria-checked={checked} onClick={onClick}>
      <span className={styles.menuCheck} aria-hidden="true">{checked ? '✓' : ''}</span>
      <span className={styles.menuItemLabel}>{label}</span>
      {count !== undefined && <span className={styles.menuCount}>{count}</span>}
    </button>
  );
}

