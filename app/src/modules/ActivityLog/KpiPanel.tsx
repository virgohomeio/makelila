import { useMemo } from 'react';
import { useActivityKpis, type ActivityLogEntry } from '../../lib/activityLog';
import styles from './ActivityLog.module.css';

/** Right-side KPI panel for the Activity Log module (backlog #56 V2).
 *
 *  Layout — per the 2026-04-16 design brief:
 *    • Top row: 5 "Today" KPI tiles
 *    • Fulfillment row: 3 cards (7-day window)
 *    • Customer-ops row: 3 cards (7-day window)
 *    • Team contribution: 2 columns (Top contributors / By module)
 *
 *  Data: queries activity_log directly over the last 7 days via
 *  useActivityKpis(). The 200-entry feed cap from V1 led to flat-lining
 *  tiles on busy days, so we go past the feed for aggregates. */
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
        <KpiTile label="Total entries"    value={stats.today.total} />
        <KpiTile label="Orders shipped"   value={stats.today.shipped} />
        <KpiTile label="Replacements"     value={stats.today.replacements} />
        <KpiTile label="Refunds approved" value={stats.today.refunds} />
        <KpiTile label="Tickets closed"   value={stats.today.ticketsClosed} />
      </div>

      <h3 className={styles.kpiSection}>Fulfillment — last 7 days</h3>
      <div className={styles.kpiCardRow}>
        <KpiCard label="Tests passed"  value={stats.week.testsPassed} hint="fq_test_ok" />
        <KpiCard label="Released to FQ" value={stats.week.releasedToFq} hint="released_to_fulfillment" />
        <KpiCard label="Orders shipped" value={stats.week.ordersShipped} hint="order_shipped + order_delivered" />
      </div>

      <h3 className={styles.kpiSection}>Customer ops — last 7 days</h3>
      <div className={styles.kpiCardRow}>
        <KpiCard label="Tickets created"     value={stats.week.ticketsCreated} hint="ticket_created" />
        <KpiCard label="Replacement orders"  value={stats.week.replacements}   hint="replacement_create" />
        <KpiCard label="Refunds approved"    value={stats.week.refunds}        hint="refund_finance_approved" />
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

function KpiTile({ label, value }: { label: string; value: number }) {
  return (
    <div className={styles.kpiTile}>
      <div className={styles.kpiTileValue}>{value}</div>
      <div className={styles.kpiTileLabel}>{label}</div>
    </div>
  );
}

function KpiCard({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className={styles.kpiCard} title={hint}>
      <div className={styles.kpiCardValue}>{value}</div>
      <div className={styles.kpiCardLabel}>{label}</div>
    </div>
  );
}

type TodayStats = {
  total: number; shipped: number; replacements: number; refunds: number; ticketsClosed: number;
};
type WeekStats = {
  testsPassed: number; releasedToFq: number; ordersShipped: number;
  ticketsCreated: number; replacements: number; refunds: number;
};
type Stats = {
  today: TodayStats;
  week: WeekStats;
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
  dataset_: 'Dashboard',
};

function moduleFor(type: string): string {
  for (const k in MODULE_OF) {
    if (type === k || type.startsWith(k)) return MODULE_OF[k];
  }
  return 'Other';
}

function compute(entries: ActivityLogEntry[]): Stats {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();

  const today: TodayStats = { total: 0, shipped: 0, replacements: 0, refunds: 0, ticketsClosed: 0 };
  const week:  WeekStats  = {
    testsPassed: 0, releasedToFq: 0, ordersShipped: 0,
    ticketsCreated: 0, replacements: 0, refunds: 0,
  };
  const userCounts   = new Map<string, { name: string; count: number }>();
  const moduleCounts = new Map<string, number>();

  for (const e of entries) {
    const t = Date.parse(e.ts);
    const isToday = t >= todayMs;

    // Today tiles.
    if (isToday) {
      today.total++;
      if (e.type === 'order_shipped') today.shipped++;
      if (e.type === 'replacement_create') today.replacements++;
      if (e.type === 'refund_finance_approved') today.refunds++;
      if (e.type === 'ticket_auto_closed') today.ticketsClosed++;
      if (e.type === 'ticket_status_changed' && /closed|resolved/i.test(e.detail)) today.ticketsClosed++;
    }

    // 7-day cards (every entry is already inside the window per the hook).
    if (e.type === 'fq_test_ok') week.testsPassed++;
    if (e.type === 'released_to_fulfillment') week.releasedToFq++;
    if (e.type === 'order_shipped' || e.type === 'order_delivered') week.ordersShipped++;
    if (e.type === 'ticket_created') week.ticketsCreated++;
    if (e.type === 'replacement_create') week.replacements++;
    if (e.type === 'refund_finance_approved') week.refunds++;

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
