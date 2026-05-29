import { useMemo, useState, type ReactNode } from 'react';
import PlotlyChart from './PlotlyChart';
import {
  STATUS_DESCRIPTIONS,
  formatAgo,
  lastReceived,
  latestHumidity,
  useAvailableSerials,
  useDashboardData,
  useLiveSerials,
  useMachineStatus,
  useSerialToUser,
  RecordType,
} from '../../lib/dashboard';
import {
  buildBmeHumidityChart,
  buildBmeTemperatureChart,
  buildCurrentsChart,
  buildEventCharts,
  buildMachineHealthChart,
  buildTemperaturesChart,
} from '../../lib/charts';
import styles from './Dashboard.module.css';

export default function Dashboard() {
  const { data: serials, loading: serialsLoading, error: serialsErr } = useAvailableSerials();
  const { data: userMap } = useSerialToUser();
  const { live, checked } = useLiveSerials(serials);
  const [selected, setSelected] = useState<string | null>(null);

  const liveSerials = useMemo(
    () => serials.filter((sn) => live.has(sn)).sort(),
    [serials, live],
  );

  return (
    <div className={styles.dashboard}>
      <aside className={styles.sidebar}>
        <header className={styles.sidebarHeader}>
          <h1>LILA Dashboard</h1>
          <p className={styles.subtitle}>
            {checked
              ? `${liveSerials.length} live / ${serials.length} total`
              : 'checking…'}
          </p>
        </header>

        {serialsErr && <p className={styles.error}>Failed to load: {serialsErr.message}</p>}
        {serialsLoading && <p className={styles.muted}>Loading machines…</p>}

        {checked && liveSerials.length === 0 && (
          <p className={styles.muted}>No machines have transmitted in the last 10 minutes.</p>
        )}

        <ul className={styles.machineList}>
          {liveSerials.map((sn) => (
            <MachineRow
              key={sn}
              serialNumber={sn}
              displayName={userMap[sn] ?? sn}
              active={selected === sn}
              onSelect={() => setSelected(sn)}
            />
          ))}
        </ul>
      </aside>

      <main className={styles.detail}>
        {selected ? (
          <MachineDetail serialNumber={selected} displayName={userMap[selected] ?? selected} />
        ) : (
          <p className={styles.placeholder}>Select a live machine to view charts.</p>
        )}
      </main>
    </div>
  );
}

function MachineRow({
  serialNumber,
  displayName,
  active,
  onSelect,
}: {
  serialNumber: string;
  displayName: string;
  active: boolean;
  onSelect: () => void;
}) {
  const { status, color } = useMachineStatus(serialNumber);
  return (
    <li>
      <button
        className={`${styles.machineRow} ${active ? styles.active : ''}`}
        onClick={onSelect}
      >
        <span
          className={styles.statusDot}
          style={{ background: color ?? '#bbb' }}
          title={status ?? 'classifying…'}
        />
        <span className={styles.machineName}>{displayName}</span>
        <span className={styles.machineStatus}>{status ?? '…'}</span>
      </button>
    </li>
  );
}

function MachineDetail({
  serialNumber,
  displayName,
}: {
  serialNumber: string;
  displayName: string;
}) {
  const { data, loading, error, refresh } = useDashboardData(serialNumber);
  const { status, color } = useMachineStatus(serialNumber);

  const hum = latestHumidity(data.liveData);
  const seen = lastReceived(data);

  const eventCharts = useMemo(() => buildEventCharts(data.events), [data.events]);
  const currents = useMemo(() => buildCurrentsChart(data.liveData), [data.liveData]);
  const temperatures = useMemo(() => buildTemperaturesChart(data.liveData), [data.liveData]);
  const machineHealth = useMemo(() => buildMachineHealthChart(data.liveData), [data.liveData]);
  const bmeHumidity = useMemo(() => buildBmeHumidityChart(data.liveData), [data.liveData]);
  const bmeTemp = useMemo(() => buildBmeTemperatureChart(data.liveData), [data.liveData]);

  return (
    <section>
      <header className={styles.detailHeader}>
        <div>
          <h2 className={styles.machineTitle}>{displayName}</h2>
          <p className={styles.muted}>{serialNumber}</p>
        </div>
        <button className={styles.refreshBtn} onClick={refresh} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </header>

      {error && <p className={styles.error}>Failed to load: {error.message}</p>}

      {status && (
        <div className={styles.statusBanner} style={{ borderLeftColor: color ?? '#bbb' }}>
          <strong>{status}</strong> — {STATUS_DESCRIPTIONS[status]}
        </div>
      )}

      <dl className={styles.metricGrid}>
        <Metric label="Latest humidity" value={hum != null ? `${hum.toFixed(0)}%` : '—'} />
        <Metric label="Last seen" value={formatAgo(seen)} />
        <Metric label="Events" value={String(data.events.length)} />
        <Metric label="BME samples" value={String(
          data.liveData[RecordType.BmeLeft].length + data.liveData[RecordType.BmeRight].length,
        )} />
      </dl>

      {loading && !data.lastFetched && (
        <p className={styles.muted}>Fetching 48h of data…</p>
      )}

      {bmeHumidity && (
        <ChartSection title={bmeHumidity.title}>
          <PlotlyChart data={bmeHumidity.data} layout={bmeHumidity.layout} height={320} />
        </ChartSection>
      )}

      {bmeTemp && (
        <ChartSection title={bmeTemp.title}>
          <PlotlyChart data={bmeTemp.data} layout={bmeTemp.layout} />
        </ChartSection>
      )}

      {currents && (
        <ChartSection title={currents.title}>
          <PlotlyChart data={currents.data} layout={currents.layout} />
        </ChartSection>
      )}

      {temperatures && (
        <ChartSection title={temperatures.title}>
          <PlotlyChart data={temperatures.data} layout={temperatures.layout} height={320} />
        </ChartSection>
      )}

      {machineHealth && (
        <ChartSection title={machineHealth.title}>
          <PlotlyChart data={machineHealth.data} layout={machineHealth.layout} />
        </ChartSection>
      )}

      {eventCharts.length > 0 && (
        <section className={styles.chartGroup}>
          <h3 className={styles.groupHeading}>Events</h3>
          {eventCharts.map((spec) => (
            <ChartSection key={spec.title} title={spec.title} compact>
              <PlotlyChart data={spec.data} layout={spec.layout} height={220} />
            </ChartSection>
          ))}
        </section>
      )}
    </section>
  );
}

function ChartSection({
  title,
  children,
  compact,
}: {
  title: string;
  children: ReactNode;
  compact?: boolean;
}) {
  return (
    <section className={`${styles.chartCard} ${compact ? styles.chartCardCompact : ''}`}>
      <h4 className={styles.chartTitle}>{title}</h4>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.metric}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
