import { useMemo } from 'react';
import { useActivityKpis, type ActivityLogEntry } from '../../lib/activityLog';
import styles from './ActivityLog.module.css';

/** Right-side KPI panel for the Activity Log module (backlog #56 V2 +
 *  #76 tile-type refresh).
 *
 *  Layout — per the 2026-04-16 design brief:
 *    • Top row: 5 "Today" KPI tiles
 *    • Fulfillment row: 3 cards (7-day window)
 *    • Customer-ops row: 3 cards (7-day window)
 *    • Team contribution: 2 columns (Top contributors / By module)
 *
 *  Tile-to-action-type mapping is driven by the TILE_DEFS array below.
 *  When the panel reads zero, the empty-state hint shows the action
 *  types the tile expects — that way the next time we evolve a logged
 *  action type (e.g. rename `fq_test_ok` → `qc_pass`), the mismatch is
 *  visible on the panel instead of months later when someone notices
 *  the number is wrong. */
export function KpiPanel() {
  const { entries, loading } = useActivityKpis(7);
  const stats = useMemo(() => compute(entries), [entries]);

  if (loading) {
    return <aside className={styles.kpiPanel}><div className={styles.kpiEmpty}>Loading KPIs…</div></aside>;
  }

  return (
    <aside className={styles.kpiPanel}>
      <h3 className={styles.kpiSection}>Today</h3>
      <div className={styles.kpiTopRow}>
        {TODAY_TILES.map(t => (
          <KpiTile key={t.key} def={t} value={stats.today[t.key]} />
        ))}
      </div>

      <h3 className={styles.kpiSection}>Fulfillment — last 7 days</h3>
      <div className={styles.kpiCardRow}>
        {FULFILLMENT_CARDS.map(c => (
          <KpiCard key={c.key} def={c} value={stats.week[c.key]} />
        ))}
      </div>

      <h3 className={styles.kpiSection}>Customer ops — last 7 days</h3>
      <div className={styles.kpiCardRow}>
        {CUSTOMER_OPS_CARDS.map(c => (
          <KpiCard key={c.key} def={c} value={stats.week[c.key]} />
        ))}
      </div>

      <h3 className={styles.kpiSection}>Team contribution — last 7 days</h3>
      <div className={styles.kpiTwoCol}>
        <div className={styles.kpiColumn}>
          <div className={styles.kpiColumnHeader}>Top contributors</div>
          {stats.byUser.length === 0 ? (
            <div className={styles.kpiEmpty}>No team activity.</div>
          ) : (
            <ul className={styles.kpiTeam}>
              {stats.byUser.slice(0, 8).map(u => (
                <li key={u.user_id} className={styles.kpiTeamRow}>
                  <span className={styles.kpiAvatar}>{u.name.charAt(0).toUpperCase()}</span>
                  <span className={styles.kpiTeamName}>{u.name}</span>
                  <span className={styles.kpiTeamCount}>{u.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className={styles.kpiColumn}>
          <div className={styles.kpiColumnHeader}>By module</div>
          {stats.byModule.length === 0 ? (
            <div className={styles.kpiEmpty}>No activity.</div>
          ) : (
            <ul className={styles.kpiModule}>
              {stats.byModule.map(m => (
                <li key={m.module} className={styles.kpiModuleRow}>
                  <span className={styles.kpiModuleName}>{m.module}</span>
                  <span className={styles.kpiModuleBar} style={{ width: `${(m.count / stats.byModule[0].count) * 100}%` }} />
                  <span className={styles.kpiModuleCount}>{m.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
}

function KpiTile({ def, value }: { def: TileDef<TodayKey>; value: number }) {
  return (
    <div className={styles.kpiTile} title={emptyHint(def, value)}>
      <div className={styles.kpiTileValue}>{value}</div>
      <div className={styles.kpiTileLabel}>{def.label}</div>
    </div>
  );
}

function KpiCard({ def, value }: { def: TileDef<WeekKey>; value: number }) {
  return (
    <div className={styles.kpiCard} title={emptyHint(def, value)}>
      <div className={styles.kpiCardValue}>{value}</div>
      <div className={styles.kpiCardLabel}>{def.label}</div>
    </div>
  );
}

function emptyHint(def: { types: readonly string[] }, value: number): string {
  if (value > 0) return def.types.join(' + ');
  return `0 in last 7d — expected types: ${def.types.join(', ')}`;
}

// ── Tile definitions ─────────────────────────────────────────────────────────
// Each tile names the action-type strings it counts. Adding a new tile is
// one entry here + one field on the stats type. When ops processes evolve
// and someone renames a logged action type, the hover tooltip on a 0-tile
// surfaces the gap immediately.

type TodayKey =
  | 'total' | 'qcReports' | 'addressesVerified' | 'statusSms' | 'ticketsResolved';

type WeekKey =
  | 'qcReports' | 'testsPassed' | 'stockFlips'
  | 'addressesVerified' | 'autoFollowups' | 'ticketsCreated';

type TileDef<K extends string> = {
  key: K;
  label: string;
  types: readonly string[];
  /** Optional: when set, the entry must also have `detail` matching this regex */
  detailMatch?: RegExp;
};

// "Today" tiles — chosen for high-volume operator actions per backlog #76.
// "Total entries" is just every row; others count specific action types.
const TODAY_TILES: readonly TileDef<TodayKey>[] = [
  { key: 'total',             label: 'Total entries',     types: ['*'] },
  { key: 'qcReports',         label: 'QC reports filed',  types: ['unit_test_report'] },
  { key: 'addressesVerified', label: 'Addresses verified',types: ['address_verified'] },
  { key: 'statusSms',         label: 'Status SMS sent',   types: ['dashboard_status_sms'] },
  { key: 'ticketsResolved',   label: 'Tickets resolved',  types: ['ticket_auto_closed', 'ticket_status_changed'], detailMatch: /closed|resolved/i },
];

const FULFILLMENT_CARDS: readonly TileDef<WeekKey>[] = [
  { key: 'qcReports',   label: 'QC reports filed',   types: ['unit_test_report'] },
  { key: 'testsPassed', label: 'FQ tests passed',    types: ['fq_test_ok'] },
  { key: 'stockFlips',  label: 'Stock status flips', types: ['stock_status', 'stock_edit'] },
];

const CUSTOMER_OPS_CARDS: readonly TileDef<WeekKey>[] = [
  { key: 'addressesVerified', label: 'Addresses verified', types: ['address_verified'] },
  { key: 'autoFollowups',     label: 'Auto follow-ups',    types: ['auto_followup_sent', 'followup_recorded'] },
  { key: 'ticketsCreated',    label: 'Tickets created',    types: ['ticket_created', 'promoted_to_ticket'] },
];

// ── Aggregator ───────────────────────────────────────────────────────────────

type Stats = {
  today: Record<TodayKey, number>;
  week:  Record<WeekKey, number>;
  byUser: { user_id: string; name: string; count: number }[];
  byModule: { module: string; count: number }[];
};

// Classify each action-type prefix into a module bucket for the
// right-column histogram. Keep this list aligned with lib/*.ts callers.
const MODULE_OF: Record<string, string> = {
  po_: 'Build', serial_: 'Build', defect_: 'Build', burnin_: 'Build', released_to_fulfillment: 'Build', freight_: 'Build',
  fq_: 'Fulfillment', shelf_: 'Fulfillment', rework_: 'Fulfillment',
  order_: 'OrderReview', address_: 'OrderReview',
  return_: 'PostShipment', refund_: 'PostShipment', repl_: 'PostShipment', cancellation_: 'PostShipment', replacement_create: 'PostShipment',
  ticket_: 'Service', inbox_: 'Service', promoted_: 'Service', gmail_: 'Service', onboarding_: 'Service',
  stock_: 'Stock', part_: 'Stock', unit_: 'Stock',
  template_: 'Templates',
  followup_: 'Customers', customer_: 'Customers', klaviyo_: 'Customers', hubspot_: 'Customers',
  auto_followup_sent: 'Customers',
  dataset_: 'Dashboard', dashboard_status_sms: 'Dashboard',
};

function moduleFor(type: string): string {
  for (const k in MODULE_OF) {
    if (type === k || type.startsWith(k)) return MODULE_OF[k];
  }
  return 'Other';
}

function matchesTile<K extends string>(def: TileDef<K>, entry: ActivityLogEntry): boolean {
  if (def.types.includes('*')) return true;
  if (!def.types.includes(entry.type)) return false;
  if (def.detailMatch && !def.detailMatch.test(entry.detail)) return false;
  return true;
}

function emptyTodayCounts(): Record<TodayKey, number> {
  return { total: 0, qcReports: 0, addressesVerified: 0, statusSms: 0, ticketsResolved: 0 };
}
function emptyWeekCounts(): Record<WeekKey, number> {
  return { qcReports: 0, testsPassed: 0, stockFlips: 0, addressesVerified: 0, autoFollowups: 0, ticketsCreated: 0 };
}

function compute(entries: ActivityLogEntry[]): Stats {
  // "Today" boundary uses the browser's local timezone — the only timezone
  // an operator can directly perceive. If we ever add a server-side
  // aggregator, it should also honor America/Toronto explicitly rather
  // than defaulting to UTC.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();

  const today = emptyTodayCounts();
  const week  = emptyWeekCounts();
  const userCounts   = new Map<string, { name: string; count: number }>();
  const moduleCounts = new Map<string, number>();

  for (const e of entries) {
    const t = Date.parse(e.ts);
    const isToday = t >= todayMs;

    if (isToday) {
      for (const def of TODAY_TILES) {
        if (matchesTile(def, e)) today[def.key]++;
      }
    }

    // 7-day cards (every entry is already inside the window per the hook).
    for (const def of FULFILLMENT_CARDS) {
      if (matchesTile(def, e)) week[def.key]++;
    }
    for (const def of CUSTOMER_OPS_CARDS) {
      if (matchesTile(def, e)) week[def.key]++;
    }

    // Team contribution.
    const existing = userCounts.get(e.user_id);
    if (existing) existing.count++;
    else userCounts.set(e.user_id, { name: e.actor_name ?? '(unknown)', count: 1 });

    const mod = moduleFor(e.type);
    moduleCounts.set(mod, (moduleCounts.get(mod) ?? 0) + 1);
  }

  const byUser = Array.from(userCounts.entries())
    .map(([user_id, v]) => ({ user_id, name: v.name, count: v.count }))
    .sort((a, b) => b.count - a.count);

  const byModule = Array.from(moduleCounts.entries())
    .map(([module, count]) => ({ module, count }))
    .sort((a, b) => b.count - a.count);

  return { today, week, byUser, byModule };
}
