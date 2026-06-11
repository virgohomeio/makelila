import { useMemo, useEffect, useState } from 'react';
import {
  useBuildQCStat,
  type StationPassStation,
  type BuildQCStat,
  type TechnicianStat,
  type StationPass,
} from '../../lib/build';
import { supabase } from '../../lib/supabase';
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

/** Fetch all passes in range for day-level FPY trend (last 30 days). */
function useDailyPassTrend(date_from: string, date_to: string): {
  days: { date: string; fpy: number; total: number }[];
  loading: boolean;
} {
  const [rows, setRows] = useState<StationPass[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('build_station_passes')
        .select('unit_serial, station, pass_status, attempt_seq, created_at')
        .gte('created_at', date_from)
        .lte('created_at', date_to);
      if (cancelled) return;
      if (!error && data) setRows(data as StationPass[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [date_from, date_to]);

  const days = useMemo(() => {
    // Group by calendar day
    const byDay = new Map<string, StationPass[]>();
    for (const row of rows) {
      const day = row.created_at.slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(row);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, dayRows]) => {
        const units = [...new Set(dayRows.map(r => r.unit_serial))];
        const firstAttemptPasses = dayRows.filter(r => r.attempt_seq === 1 && r.pass_status === 'pass');
        const fpy = units.length > 0 ? (firstAttemptPasses.length / units.length) * 100 : 0;
        return { date, fpy, total: dayRows.length };
      });
  }, [rows]);

  return { days, loading };
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
