// app/src/modules/Products/DashboardTab.tsx
import { PRODUCTS } from './data';
import { computeFleetStats, type Issue } from '../../lib/products';
import { IssueChatPanel } from './IssueChatPanel';
import styles from './Products.module.css';

const DASHBOARD_PRODUCTS = [
  { id: 'pro',         label: 'LILA Pro' },
  { id: 'mini',        label: 'LILA Mini' },
  { id: 'mega',        label: 'LILA Mega' },
  { id: 'makelila',    label: 'makeLILA' },
  { id: 'lovely',      label: 'Lovely App' },
  { id: 'shop',        label: 'LILA Shop' },
  { id: 'marketplace', label: 'LILA Marketplace' },
];

const KNOWN_TEAM = Array.from(new Set(
  DASHBOARD_PRODUCTS.flatMap(p => PRODUCTS[p.id].team.map(m => m.name)),
)).sort();

export function DashboardTab({
  issuesByProduct,
  onSelectProduct,
}: {
  issuesByProduct: Record<string, Issue[]>;
  onSelectProduct: (id: string) => void;
}) {
  const products = DASHBOARD_PRODUCTS.map(p => ({
    id: p.id,
    stage: PRODUCTS[p.id].currentLabel,
  }));
  const stats = computeFleetStats(issuesByProduct, products);

  return (
    <div className={styles.productPage}>
      <div className={styles.sectionHead}>Fleet Summary</div>
      <div className={styles.kpiStrip}>
        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>Open Issues</div>
          <div className={`${styles.kpiVal} ${stats.totalOpen > 0 ? styles.vCrit : ''}`}>{stats.totalOpen}</div>
          <div className={styles.kpiSub}>across {stats.lineCount} product lines</div>
        </div>
        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>Critical</div>
          <div className={`${styles.kpiVal} ${stats.totalCritical > 0 ? styles.vCrit : ''}`}>{stats.totalCritical}</div>
          <div className={styles.kpiSub}>needs immediate attention</div>
        </div>
        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>MP Blockers</div>
          <div className={`${styles.kpiVal} ${stats.totalMpBlockers > 0 ? styles.vMed : ''}`}>{stats.totalMpBlockers}</div>
          <div className={styles.kpiSub}>blocking mass production</div>
        </div>
        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>Product Lines</div>
          <div className={styles.kpiVal}>{stats.lineCount}</div>
          <div className={styles.kpiSub}>tracked in this dashboard</div>
        </div>
      </div>

      <div className={styles.sectionHead} style={{ marginTop: 24 }}>Product Lines</div>
      <div className={styles.dashLineGrid}>
        {stats.perLine.map(line => {
          const label = DASHBOARD_PRODUCTS.find(p => p.id === line.productId)?.label ?? line.productId;
          return (
            <button
              key={line.productId}
              className={styles.dashLineCard}
              onClick={() => onSelectProduct(line.productId)}
            >
              <div className={styles.dashLineName}>{label}</div>
              <div className={styles.dashLineStage}>{line.stage}</div>
              <div className={styles.dashLineCounts}>
                <span className={line.openCount > 0 ? styles.dashCountOpen : styles.dashCountZero}>
                  {line.openCount} open
                </span>
                {line.criticalCount > 0 && (
                  <span className={styles.dashCountCrit}>{line.criticalCount} critical</span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className={styles.sectionHead} style={{ marginTop: 24 }}>File an Issue</div>
      <IssueChatPanel products={DASHBOARD_PRODUCTS} knownTeam={KNOWN_TEAM} />
    </div>
  );
}
