import {
  useBuildQCStat,
  useDailyPassTrend,
  type StationPassStation,
  type BuildQCStat,
  type TechnicianStat,
} from '../../lib/build';
import styles from './Build.module.css';

const STATION_LABELS: Record<StationPassStation, string> = {
  electrical:    'Electrical',
  mechanical:    'Mechanical',
  firmware_flash:'Firmware Flash',
  final_qa:      'Final QA',
};

type Props = {
  batch?: string;
  dateRange: { from: string; to: string };
};

function defaultDateRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}

export function BuildQCDashboard({ batch, dateRange }: Props) {
  const range = dateRange ?? defaultDateRange();
  const { qcStats, techStats, loading } = useBuildQCStat(range.from, range.to, batch);
  const { days, loading: trendLoading } = useDailyPassTrend(range.from, range.to);

  if (loading) {
    return <div className={styles.loading}>Loading QC data…</div>;
  }

  return (
    <div className={styles.qcDashboard}>
      <div className={styles.qcSection}>
        <div className={styles.detailSectionLabel}>Defects by station</div>
        <div className={styles.qcStationGrid}>
          {qcStats.map(stat => (
            <StationCard key={stat.station} stat={stat} />
          ))}
        </div>
      </div>

      <div className={styles.qcSection}>
        <div className={styles.detailSectionLabel}>Technician breakdown</div>
        {techStats.length === 0 ? (
          <div className={styles.empty}>No data for this period.</div>
        ) : (
          <div className={styles.qcTechTable}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Technician</th>
                  <th>Total passes</th>
                  <th>Pass</th>
                  <th>Fail</th>
                  <th>Top defect category</th>
                </tr>
              </thead>
              <tbody>
                {techStats.map(t => {
                  const topCat = Object.entries(t.by_category)
                    .sort(([, a], [, b]) => b - a)[0]?.[0] ?? '—';
                  return (
                    <tr key={t.technician_id} className={styles.row}>
                      <td className={styles.cardMono}>{t.technician_name ?? t.technician_id.slice(0, 8) + '…'}</td>
                      <td>{t.total}</td>
                      <td className={styles.qcPassText}>{t.pass}</td>
                      <td className={styles.qcFailText}>{t.fail}</td>
                      <td>{topCat}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className={styles.qcSection}>
        <div className={styles.detailSectionLabel}>First-pass yield trend (by day)</div>
        {trendLoading ? (
          <div className={styles.loading}>Loading trend…</div>
        ) : days.length === 0 ? (
          <div className={styles.empty}>No data for this period.</div>
        ) : (
          <div className={styles.qcTrendChart}>
            {days.map(d => (
              <div key={d.date} className={styles.qcTrendRow}>
                <div className={styles.qcTrendDate}>{d.date.slice(5)}</div>
                <div className={styles.qcBarTrack}>
                  <div
                    className={styles.qcBarFill}
                    style={{ width: `${Math.round(d.fpy)}%` }}
                  />
                </div>
                <div className={styles.qcTrendPct}>{Math.round(d.fpy)}%</div>
                <div className={styles.qcTrendTotal}>({d.total})</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StationCard({ stat }: { stat: BuildQCStat }) {
  const fpyPct = Math.round(stat.first_pass_yield);
  const tierCls = fpyPct >= 90 ? 'Good' : fpyPct >= 70 ? 'Warn' : 'Bad';
  return (
    <div className={styles.qcStationCard}>
      <div className={styles.qcStationName}>{STATION_LABELS[stat.station]}</div>
      <div className={`${styles.qcStationFpy} ${styles[`qcStationFpy${tierCls}`]}`}>
        {fpyPct}% FPY
      </div>
      <div className={styles.qcBarTrack}>
        <div
          className={`${styles.qcBarFill} ${styles[`qcBarFill${tierCls}`]}`}
          style={{ width: `${fpyPct}%` }}
        />
      </div>
      <div className={styles.qcStationMeta}>
        <span className={styles.qcPassText}>{stat.pass} pass</span>
        <span className={styles.qcFailText}>{stat.fail} fail</span>
        <span className={styles.qcReworkText}>{stat.rework} rework</span>
        <span>{stat.total} total</span>
      </div>
    </div>
  );
}
