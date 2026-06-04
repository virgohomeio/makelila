import { useMemo, useState, type ReactNode } from 'react';
import PlotlyChart from './PlotlyChart';
import AssignCustomerModal from './AssignCustomerModal';
import {
  MIXING_VERDICT_META,
  STATUS_DESCRIPTIONS,
  classifyMixing,
  formatAgo,
  lastReceived,
  latestHumidity,
  useAvailableSerials,
  useDashboardData,
  useLiveSerials,
  useMachineStatus,
  useSerialToUser,
  useUnitCustomerMap,
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
  const { data: telemetryUserMap } = useSerialToUser();
  const { data: unitCustomerMap, refresh: refreshUnits } = useUnitCustomerMap();
  const { live, checked } = useLiveSerials(serials);
  const [selected, setSelected] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState<string | null>(null);

  const liveSerials = useMemo(
    () => serials.filter((sn) => live.has(sn)).sort(),
    [serials, live],
  );

  // makelila system-of-record (units.customer_name) wins over telemetry
  // (lila.user) wins over the raw serial. When the result IS the raw
  // serial, the machine has no assigned customer anywhere — that's the
  // signal to make the row clickable for assignment (#54).
  const resolveDisplay = (sn: string): { name: string; assigned: boolean } => {
    const fromUnits = unitCustomerMap[sn];
    if (fromUnits) return { name: fromUnits, assigned: true };
    const fromTelemetry = telemetryUserMap[sn];
    if (fromTelemetry && fromTelemetry !== sn) return { name: fromTelemetry, assigned: true };
    return { name: sn, assigned: false };
  };

  const handleAssigned = () => {
    setAssignTarget(null);
    refreshUnits();
  };

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
          {liveSerials.map((sn) => {
            const { name, assigned } = resolveDisplay(sn);
            return (
              <MachineRow
                key={sn}
                serialNumber={sn}
                displayName={name}
                assigned={assigned}
                active={selected === sn}
                onSelect={() => setSelected(sn)}
                onAssign={() => setAssignTarget(sn)}
              />
            );
          })}
        </ul>
      </aside>

      <main className={styles.detail}>
        {selected ? (() => {
          const { name, assigned } = resolveDisplay(selected);
          return (
            <MachineDetail
              serialNumber={selected}
              displayName={name}
              assigned={assigned}
              onAssign={() => setAssignTarget(selected)}
            />
          );
        })() : (
          <p className={styles.placeholder}>Select a live machine to view charts.</p>
        )}
      </main>

      {assignTarget && (
        <AssignCustomerModal
          serialNumber={assignTarget}
          telemetryHint={telemetryUserMap[assignTarget] && telemetryUserMap[assignTarget] !== assignTarget ? telemetryUserMap[assignTarget] : null}
          onClose={() => setAssignTarget(null)}
          onAssigned={handleAssigned}
        />
      )}
    </div>
  );
}

function MachineRow({
  serialNumber,
  displayName,
  assigned,
  active,
  onSelect,
  onAssign,
}: {
  serialNumber: string;
  displayName: string;
  assigned: boolean;
  active: boolean;
  onSelect: () => void;
  onAssign: () => void;
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
        <span className={styles.machineName}>
          {displayName}
          {!assigned && (
            <span
              role="button"
              tabIndex={0}
              className={styles.assignBadge}
              onClick={(e) => { e.stopPropagation(); onAssign(); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  onAssign();
                }
              }}
              title="Assign customer"
            >
              + assign
            </span>
          )}
        </span>
        <span className={styles.machineStatus}>{status ?? '…'}</span>
      </button>
    </li>
  );
}

function MachineDetail({
  serialNumber,
  displayName,
  assigned,
  onAssign,
}: {
  serialNumber: string;
  displayName: string;
  assigned: boolean;
  onAssign: () => void;
}) {
  const { data, loading, error, refresh } = useDashboardData(serialNumber);
  const { status, color } = useMachineStatus(serialNumber);

  const hum = latestHumidity(data.liveData);
  const seen = lastReceived(data);
  const mixing = useMemo(() => classifyMixing(data.liveData), [data.liveData]);
  const mixMeta = MIXING_VERDICT_META[mixing.verdict];

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
          <div className={styles.titleRow}>
            <h2 className={styles.machineTitle}>
              {displayName}
              {!assigned && (
                <button type="button" className={styles.assignBadge} onClick={onAssign}>
                  + assign customer
                </button>
              )}
            </h2>
            <span
              className={styles.mixingBadge}
              style={{ color: mixMeta.color, background: mixMeta.bg }}
            >
              {mixMeta.label}
            </span>
          </div>
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
