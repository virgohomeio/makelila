import { useMemo, useState } from 'react';
import { useCustomers } from '../../lib/customers';
import { useUnits } from '../../lib/stock';
import { useCustomerLifecycle, useServiceTickets } from '../../lib/service';
import { useAuth } from '../../lib/auth';
import {
  buildTimelines, consecutiveGaps, coverage, gapDays, gapSeverity, toDay, timelinesCsv,
  setMilestoneOverride, clearMilestoneOverride,
  useCustomerDeliveries, useDiagnosisCalls, useTimelineOverrides,
  useCustomerAppLinks, useLovelyEvents, useTimelineOrders,
  MILESTONES,
  type CustomerTimeline, type MilestoneKey, type MilestoneValue, type DiagnosisCall,
} from '../../lib/customerTimeline';
import { Button, EmptyState } from '../../components/ui';
import styles from './Timelines.module.css';

// Customers > Timelines. A matrix of every customer against the six milestones,
// and a per-customer rail behind each row.
//
// Spec: docs/superpowers/specs/2026-10-07-customer-timelines-tab-design.md

type Mode = 'dates' | 'durations';
type Scope = 'owners' | 'all';
type SortKey = MilestoneKey | 'name' | 'calls';

// ── Formatting ──────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' → 'Mar 18'. Built from the string's own parts rather than a
 *  Date, which would shift the day in any timezone behind UTC. */
function shortDate(day: string | null): string {
  if (!day) return '';
  const [y, m, d] = day.split('-');
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const month = MONTHS[Number(m) - 1];
  if (!month) return day;
  const thisYear = String(new Date().getFullYear());
  // The year only earns its space when it is not the current one.
  return y === thisYear ? `${month} ${Number(d)}` : `${month} ${Number(d)}, ${y}`;
}

function longDate(day: string | null): string {
  if (!day) return '—';
  const [y, m, d] = day.split('-');
  const MONTHS = ['January','February','March','April','May','June','July',
                  'August','September','October','November','December'];
  return `${MONTHS[Number(m) - 1] ?? m} ${Number(d)}, ${y}`;
}

/** Severity → class. The thresholds themselves live in lib/customerTimeline so
 *  they are testable; this only paints them. */
const GAP_CLASS: Record<ReturnType<typeof gapSeverity>, string> = {
  unknown:   styles.gap,
  normal:    styles.gap,
  slow:      `${styles.gap} ${styles.gapSlow}`,
  stalled:   `${styles.gap} ${styles.gapStalled}`,
  backwards: `${styles.gap} ${styles.gapBackwards}`,
};

const GAP_TITLE: Partial<Record<ReturnType<typeof gapSeverity>, string>> = {
  slow:      'Longer than usual between these two milestones.',
  stalled:   'A month or more between these two milestones.',
  backwards: 'Out of order — this milestone is dated BEFORE the previous one. Usually a mis-linked unit or a replacement dated against the original order.',
};

// ── Tab ─────────────────────────────────────────────────────────────────────

export function TimelinesTab() {
  const { customers, loading: loadingCustomers } = useCustomers();
  const { orders } = useTimelineOrders();
  const { units } = useUnits();
  const { rows: lifecycle } = useCustomerLifecycle();
  const { tickets } = useServiceTickets();
  const { events } = useLovelyEvents();
  const { appLinks } = useCustomerAppLinks();
  const { deliveries } = useCustomerDeliveries();
  const { calls } = useDiagnosisCalls();
  const { overrides, refresh: refreshOverrides } = useTimelineOverrides();

  const [mode, setMode] = useState<Mode>('dates');
  const [scope, setScope] = useState<Scope>('owners');
  const [missing, setMissing] = useState<MilestoneKey | 'none'>('none');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('shipped');
  const [desc, setDesc] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

  const timelines = useMemo(() => buildTimelines({
    customers, orders, units, lifecycle, tickets, events, appLinks,
    deliveries, diagnosisCalls: calls, overrides,
  }), [customers, orders, units, lifecycle, tickets, events, appLinks, deliveries, calls, overrides]);

  // The coverage strip counts across the SCOPE, not the search: it is a
  // statement about the data we hold, and it should not move as you type.
  const scoped = useMemo(
    () => (scope === 'owners' ? timelines.filter(t => t.ownsMachine) : timelines),
    [timelines, scope],
  );
  const cov = useMemo(() => coverage(scoped), [scoped]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = scoped;
    if (q) {
      out = out.filter(t =>
        t.customer.full_name.toLowerCase().includes(q) ||
        (t.customer.email ?? '').toLowerCase().includes(q));
    }
    if (missing !== 'none') out = out.filter(t => !t.milestones[missing].date);

    const dir = desc ? -1 : 1;
    return out.slice().sort((a, b) => {
      if (sort === 'name') return a.customer.full_name.localeCompare(b.customer.full_name) * dir;
      if (sort === 'calls') return (a.diagnosisCalls.length - b.diagnosisCalls.length) * dir;
      const da = a.milestones[sort].date;
      const db = b.milestones[sort].date;
      // Customers with no date for the sorted column sink to the bottom in both
      // directions. Sorting them to the top of ascending order would bury the
      // rows the operator asked to see under every blank in the table.
      if (!da && !db) return a.customer.full_name.localeCompare(b.customer.full_name);
      if (!da) return 1;
      if (!db) return -1;
      return da.localeCompare(db) * dir;
    });
  }, [scoped, search, missing, sort, desc]);

  const open = useMemo(
    () => rows.find(t => t.customer.id === openId) ?? timelines.find(t => t.customer.id === openId) ?? null,
    [rows, timelines, openId],
  );

  const toggleSort = (key: SortKey) => {
    if (key === sort) setDesc(d => !d);
    else { setSort(key); setDesc(key !== 'name'); }
  };

  const handleExport = () => {
    const blob = new Blob([timelinesCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `customer-timelines-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loadingCustomers) return <div className={styles.loading}>Loading timelines…</div>;

  return (
    <div className={styles.tab}>
      <div className={styles.coverage}>
        {MILESTONES.map(def => (
          <div key={def.key} className={styles.coverageCell} title={def.description}>
            <span className={styles.coverageLabel}>{def.label}</span>
            <span className={styles.coverageValue}>
              {cov[def.key]}
              <span className={styles.coverageOf}> / {scoped.length}</span>
            </span>
            <div className={styles.coverageBar}>
              <div
                className={styles.coverageBarFill}
                style={{ width: scoped.length ? `${(cov[def.key] / scoped.length) * 100}%` : '0%' }}
              />
            </div>
          </div>
        ))}
      </div>

      <div className={styles.controls}>
        <input
          className={styles.search}
          placeholder="Search name or email…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className={styles.modeSwitch} role="tablist" aria-label="Timeline reading">
          {(['dates', 'durations'] as Mode[]).map(m => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              className={`${styles.modeBtn} ${mode === m ? styles.modeBtnActive : ''}`}
              onClick={() => setMode(m)}
            >
              {m === 'dates' ? 'Dates' : 'Durations'}
            </button>
          ))}
        </div>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={scope === 'owners'}
            onChange={e => setScope(e.target.checked ? 'owners' : 'all')}
          />
          Machine owners only
        </label>
        <select
          className={styles.select}
          value={missing}
          onChange={e => setMissing(e.target.value as MilestoneKey | 'none')}
          aria-label="Filter to customers missing a milestone"
        >
          <option value="none">No milestone filter</option>
          {MILESTONES.map(def => (
            <option key={def.key} value={def.key}>Missing: {def.label}</option>
          ))}
        </select>
        <Button onClick={handleExport}>Export CSV</Button>
        <span className={styles.count}>{rows.length} customers</span>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No customers match"
          body="Clear the search or the milestone filter, or switch off “machine owners only”."
        />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.nameCell}>
                  <button className={styles.sortBtn} onClick={() => toggleSort('name')}>
                    Customer{sort === 'name' && <span className={styles.sortArrow}>{desc ? '↓' : '↑'}</span>}
                  </button>
                </th>
                {MILESTONES.map(def => (
                  <th key={def.key} title={def.description}>
                    <button className={styles.sortBtn} onClick={() => toggleSort(def.key)}>
                      {def.short}
                      {sort === def.key && <span className={styles.sortArrow}>{desc ? '↓' : '↑'}</span>}
                    </button>
                  </th>
                ))}
                <th title="Diagnosis calls on record, from Fireflies.">
                  <button className={styles.sortBtn} onClick={() => toggleSort('calls')}>
                    Diag.{sort === 'calls' && <span className={styles.sortArrow}>{desc ? '↓' : '↑'}</span>}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(t => (
                <MatrixRow
                  key={t.customer.id}
                  timeline={t}
                  mode={mode}
                  onOpen={() => setOpenId(t.customer.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <div className={styles.backdrop} onClick={() => setOpenId(null)}>
          {/* Keyed by customer id: an unkeyed panel keeps the previous row's
              edit and banner state when you click the next customer, which is
              how a "saved" message ended up following operators down a list. */}
          <TimelineDetail
            key={open.customer.id}
            timeline={open}
            onClose={() => setOpenId(null)}
            onSaved={refreshOverrides}
          />
        </div>
      )}
    </div>
  );
}

// ── Matrix row ──────────────────────────────────────────────────────────────

function MatrixRow({ timeline, mode, onOpen }: {
  timeline: CustomerTimeline;
  mode: Mode;
  onOpen: () => void;
}) {
  const gaps = useMemo(() => consecutiveGaps(timeline), [timeline]);
  const noShows = timeline.diagnosisCalls.filter(c => c.attended === false).length;

  return (
    <tr onClick={onOpen}>
      <td className={styles.nameCell}>
        {timeline.customer.full_name || '(no name)'}
        <span className={styles.nameSub}>{timeline.customer.email ?? '—'}</span>
      </td>
      {MILESTONES.map(def => {
        const v = timeline.milestones[def.key];
        if (mode === 'durations') {
          const g = gaps[def.key];
          const sev = gapSeverity(g);
          return (
            <td key={def.key} className={GAP_CLASS[sev]} title={GAP_TITLE[sev]}>
              {g == null ? <span className={styles.missing}>—</span> : `${g}d`}
            </td>
          );
        }
        return (
          <td key={def.key}>
            {v.date ? (
              <span className={styles.date}>
                {shortDate(v.date)}
                {v.manual && <span className={styles.manualMark} title="Set by an operator">✎</span>}
              </span>
            ) : (
              <span className={styles.missing}>—</span>
            )}
          </td>
        );
      })}
      <td className={styles.callCount}>
        {timeline.diagnosisCalls.length || <span className={styles.missing}>—</span>}
        {noShows > 0 && (
          <span className={styles.noShow} title={`${noShows} no-show${noShows > 1 ? 's' : ''}`}>
            {noShows} n/s
          </span>
        )}
      </td>
    </tr>
  );
}

// ── Detail panel ────────────────────────────────────────────────────────────

/** One dated thing on the rail: a milestone or a diagnosis call. */
type RailEntry =
  | { kind: 'milestone'; day: string | null; def: typeof MILESTONES[number]; value: MilestoneValue }
  | { kind: 'call'; day: string; call: DiagnosisCall };

function TimelineDetail({ timeline, onClose, onSaved }: {
  timeline: CustomerTimeline;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { user } = useAuth();
  const [editing, setEditing] = useState<MilestoneKey | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const customerId = timeline.customer.id;

  // Milestones in their canonical order, then every call interleaved by date.
  // The calls are not milestones and are never editable — they come from
  // Fireflies and makeLILA only reads them.
  const rail: RailEntry[] = useMemo(() => {
    const entries: RailEntry[] = MILESTONES.map(def => ({
      kind: 'milestone' as const, def, value: timeline.milestones[def.key],
      day: timeline.milestones[def.key].date,
    }));
    const callEntries: RailEntry[] = timeline.diagnosisCalls
      .map(c => ({ kind: 'call' as const, call: c, day: toDay(c.occurred_at) }))
      .filter((e): e is { kind: 'call'; day: string; call: DiagnosisCall } => !!e.day);

    // Dated things sort by date; an undated milestone keeps its position in the
    // canonical sequence so the rail still reads as a journey with holes in it
    // rather than collapsing every blank to the end.
    const dated = [...entries.filter(e => e.day), ...callEntries]
      .sort((a, b) => (a.day ?? '').localeCompare(b.day ?? ''));
    const undated = entries.filter(e => !e.day);
    return [...dated, ...undated];
  }, [timeline]);

  const startEdit = (key: MilestoneKey) => {
    setError(null);
    setEditing(key);
    setDraft(timeline.milestones[key].date ?? '');
  };

  const save = async (key: MilestoneKey) => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await setMilestoneOverride(customerId, key, draft, { setBy: user?.email ?? null });
      await onSaved();
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that date.');
    } finally {
      setBusy(false);
    }
  };

  const clear = async (key: MilestoneKey) => {
    setBusy(true);
    setError(null);
    try {
      await clearMilestoneOverride(customerId, key);
      await onSaved();
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not clear that date.');
    } finally {
      setBusy(false);
    }
  };

  let prevDay: string | null = null;

  return (
    <div className={styles.panel} onClick={e => e.stopPropagation()}>
      <div className={styles.panelHead}>
        <div>
          <h2 className={styles.panelTitle}>{timeline.customer.full_name || '(no name)'}</h2>
          <p className={styles.panelSub}>
            {timeline.customer.email ?? 'no email'}
            {timeline.ownsMachine ? ' · machine owner' : ' · no machine shipped'}
          </p>
        </div>
        <button className={styles.closeBtn} onClick={onClose} aria-label="Close">✕</button>
      </div>

      {error && <div className={styles.panelError}>{error}</div>}

      <div>
        <h3 className={styles.sectionTitle}>Timeline</h3>
        <ul className={styles.rail}>
          {rail.map(entry => {
            if (entry.kind === 'call') {
              const gap = gapDays(prevDay, entry.day);
              prevDay = entry.day;
              const mins = entry.call.duration_minutes;
              return (
                <li key={`call-${entry.call.id}`} className={styles.railItem}>
                  <span className={`${styles.dot} ${styles.dotCall}`} />
                  <div className={styles.railBody}>
                    <div className={styles.railLabel}>
                      Diagnosis call
                      {entry.call.attended === false && (
                        <span className={styles.noShow}>no-show</span>
                      )}
                    </div>
                    <span className={styles.railDate}>{longDate(entry.day)}</span>
                    {gap != null && <span className={styles.railGap}>+{gap}d</span>}
                    <span className={styles.railMeta}>
                      {mins != null ? `${mins} min` : 'duration unknown'}
                      {entry.call.title ? ` · ${entry.call.title}` : ''}
                    </span>
                  </div>
                </li>
              );
            }

            const { def, value, day } = entry;
            const gap = day ? gapDays(prevDay, day) : null;
            if (day) prevDay = day;

            return (
              <li key={def.key} className={styles.railItem}>
                <span className={day ? styles.dot : `${styles.dot} ${styles.dotMissing}`} />
                <div className={styles.railBody}>
                  <div className={styles.railLabel}>{def.label}</div>
                  {day ? (
                    <>
                      <span className={styles.railDate}>{longDate(day)}</span>
                      {gap != null && (
                        <span
                          className={gapSeverity(gap) === 'backwards'
                            ? `${styles.railGap} ${styles.gapBackwards}` : styles.railGap}
                          title={GAP_TITLE[gapSeverity(gap)]}
                        >
                          {gap >= 0 ? '+' : ''}{gap}d
                        </span>
                      )}
                    </>
                  ) : (
                    <span className={styles.railDateMissing}>Not recorded</span>
                  )}
                  <span className={styles.railMeta}>
                    {value.manual
                      ? `Set by ${value.setBy ?? 'an operator'}${
                          // Worth printing only when the data disagrees with the
                          // operator — otherwise it is noise on every row.
                          value.derived && value.derived !== day ? ` · data says ${longDate(value.derived)}` : ''
                        }`
                      : value.source ?? def.description}
                  </span>
                  {value.note && <span className={styles.railMeta}>“{value.note}”</span>}

                  {editing === def.key ? (
                    <div className={styles.railEdit}>
                      <input
                        className={styles.dateInput}
                        type="date"
                        value={draft}
                        onChange={e => setDraft(e.target.value)}
                        aria-label={`${def.label} date`}
                      />
                      <button
                        className={styles.miniBtn}
                        onClick={() => void save(def.key)}
                        disabled={busy || !draft}
                      >
                        {busy ? 'Saving…' : 'Save'}
                      </button>
                      {value.manual && (
                        <button
                          className={`${styles.miniBtn} ${styles.clearBtn}`}
                          onClick={() => void clear(def.key)}
                          disabled={busy}
                        >
                          Clear
                        </button>
                      )}
                      <button
                        className={styles.miniBtn}
                        onClick={() => setEditing(null)}
                        disabled={busy}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className={styles.railEdit}>
                      <button className={styles.miniBtn} onClick={() => startEdit(def.key)}>
                        {day ? 'Change date' : 'Set date'}
                      </button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {timeline.diagnosisCalls.length === 0 && (
        <p className={styles.empty}>No diagnosis calls on record for this customer.</p>
      )}
    </div>
  );
}
