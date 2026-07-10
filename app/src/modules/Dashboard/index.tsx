import { useMemo, useState, type ReactNode } from 'react';
import PlotlyChart from './PlotlyChart';
import AssignCustomerModal from './AssignCustomerModal';
import StatusSmsModal from './StatusSmsModal';
import LabelWindowModal from './LabelWindowModal';
import {
  MIXING_VERDICT_META,
  STATUS_DESCRIPTIONS,
  STATUS_SMS_KIND,
  STATUS_SMS_TEMPLATES,
  classifyMixing,
  formatAgo,
  lastReceived,
  latestHumidity,
  useAvailableSerials,
  useDashboardData,
  useDatasetLabels,
  useLiveSerials,
  useMachineStatus,
  useSerialToUser,
  useTeamTestSerials,
  useUnitCustomerMap,
  deleteDatasetLabel,
  RecordType,
  type MachineStatus,
} from '../../lib/dashboard';
import {
  buildBmeHumidityChart,
  buildBmeTemperatureChart,
  buildCurrentsChart,
  buildEventCharts,
  buildMachineHealthChart,
  buildTemperaturesChart,
} from '../../lib/charts';
import { useIsMobile } from '../../lib/useMediaQuery';
import { NavCard } from '../../components/NavCard';
import { MobileBackHeader } from '../../components/MobileBackHeader';
import styles from './Dashboard.module.css';

export default function Dashboard() {
  const { data: serials, loading: serialsLoading, error: serialsErr } = useAvailableSerials();
  const { data: telemetryUserMap } = useSerialToUser();
  const { data: unitCustomerMap, refresh: refreshUnits } = useUnitCustomerMap();
  const { data: teamSerials } = useTeamTestSerials();
  const { live, checked } = useLiveSerials(serials);
  const [selected, setSelected] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState<string | null>(null);
  // Backlog #59 — team test units default-hidden so internal noise doesn't
  // distort what an operator scanning the sidebar sees.
  const [showTeamUnits, setShowTeamUnits] = useState(false);

  const liveSerials = useMemo(
    () => serials
      .filter((sn) => live.has(sn))
      .filter((sn) => showTeamUnits || !teamSerials.has(sn))
      .sort(),
    [serials, live, teamSerials, showTeamUnits],
  );
  // Machines known to telemetry that aren't transmitting in the live window.
  // Shown after the live ones so the whole fleet is visible, not just what's
  // online this minute.
  const offlineSerials = useMemo(
    () => serials
      .filter((sn) => !live.has(sn))
      .filter((sn) => showTeamUnits || !teamSerials.has(sn))
      .sort(),
    [serials, live, teamSerials, showTeamUnits],
  );
  const hiddenTeamCount = useMemo(
    () => showTeamUnits ? 0 : serials.filter((sn) => teamSerials.has(sn)).length,
    [serials, teamSerials, showTeamUnits],
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

  const isMobile = useIsMobile();

  // Mobile: one NavCard per live unit. Tap a card → MachineDetail in a
  // full-screen takeover with a back chevron returning to the unit list.
  // The team-units toggle + header live above the cards so the operator can
  // still filter without drilling in.
  if (isMobile) {
    if (selected) {
      const { name, assigned } = resolveDisplay(selected);
      return (
        <div className={styles.dashboard}>
          <MobileBackHeader label={`${name} · ${selected}`} onBack={() => setSelected(null)} />
          <MachineDetail
            serialNumber={selected}
            displayName={name}
            assigned={assigned}
            onAssign={() => setAssignTarget(selected)}
          />
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
    return (
      <div className={styles.dashboard}>
        <header className={styles.sidebarHeader} style={{ background: 'transparent', padding: '12px 4px' }}>
          <h1 style={{ color: 'var(--color-ink)', fontSize: 17 }}>LILA Dashboard</h1>
          <p className={styles.subtitle} style={{ color: 'var(--color-ink-muted)' }}>
            {checked ? `${liveSerials.length} live / ${serials.length} total` : 'checking…'}
          </p>
          <label className={styles.teamToggle} style={{ color: 'var(--color-ink-muted)' }}>
            <input
              type="checkbox"
              checked={showTeamUnits}
              onChange={(e) => setShowTeamUnits(e.target.checked)}
            />
            <span>
              Show team test units
              {hiddenTeamCount > 0 && <em> ({hiddenTeamCount} hidden)</em>}
            </span>
          </label>
        </header>
        {serialsErr && <p className={styles.error}>Failed to load: {serialsErr.message}</p>}
        {serialsLoading && <p className={styles.muted}>Loading machines…</p>}
        {checked && serials.length === 0 && (
          <p className={styles.muted}>No machines found.</p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 4 }}>
          {liveSerials.map((sn) => {
            const { name, assigned } = resolveDisplay(sn);
            return (
              <MobileMachineCard
                key={sn}
                serialNumber={sn}
                displayName={name}
                assigned={assigned}
                onSelect={() => setSelected(sn)}
                onAssign={() => setAssignTarget(sn)}
              />
            );
          })}
          {offlineSerials.length > 0 && (
            <p className={styles.muted} style={{ margin: '6px 4px 0' }}>
              Offline · {offlineSerials.length}
            </p>
          )}
          {offlineSerials.map((sn) => {
            const { name, assigned } = resolveDisplay(sn);
            return (
              <OfflineMobileCard
                key={sn}
                serialNumber={sn}
                displayName={name}
                assigned={assigned}
                onSelect={() => setSelected(sn)}
                onAssign={() => setAssignTarget(sn)}
              />
            );
          })}
        </div>
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
          <label className={styles.teamToggle}>
            <input
              type="checkbox"
              checked={showTeamUnits}
              onChange={(e) => setShowTeamUnits(e.target.checked)}
            />
            <span>
              Show team test units
              {hiddenTeamCount > 0 && <em> ({hiddenTeamCount} hidden)</em>}
            </span>
          </label>
        </header>

        {serialsErr && <p className={styles.error}>Failed to load: {serialsErr.message}</p>}
        {serialsLoading && <p className={styles.muted}>Loading machines…</p>}

        {checked && serials.length === 0 && (
          <p className={styles.muted}>No machines found.</p>
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
          {offlineSerials.length > 0 && (
            <li className={styles.machineListDivider}>Offline · {offlineSerials.length}</li>
          )}
          {offlineSerials.map((sn) => {
            const { name, assigned } = resolveDisplay(sn);
            return (
              <OfflineMachineRow
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
          <p className={styles.placeholder}>Select a machine to view charts.</p>
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

// Mobile-only NavCard variant. Status color resolved here (one hook per row)
// so the unit list can show the live dot without re-reading the giant
// telemetry payload at the module level.
function MobileAssignButton({ onAssign }: { onAssign: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onAssign(); }}
      style={{
        position: 'absolute',
        top: 10, right: 56,
        background: 'var(--color-warning-bg)',
        color: 'var(--color-warning)',
        border: '1px solid var(--color-warning-border)',
        borderRadius: 999,
        padding: '4px 10px',
        fontSize: 11,
        fontWeight: 700,
        cursor: 'pointer',
      }}
    >+ assign</button>
  );
}

function MobileMachineCard({
  serialNumber,
  displayName,
  assigned,
  onSelect,
  onAssign,
}: {
  serialNumber: string;
  displayName: string;
  assigned: boolean;
  onSelect: () => void;
  onAssign: () => void;
}) {
  const { status, color } = useMachineStatus(serialNumber);
  const subtitle = assigned ? `${serialNumber} · ${status ?? 'classifying…'}` : `${serialNumber} · unassigned`;
  return (
    <div style={{ position: 'relative' }}>
      <NavCard
        onClick={onSelect}
        title={displayName}
        subtitle={subtitle}
        icon={
          <span
            style={{
              display: 'inline-block',
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: color ?? '#bbb',
            }}
          />
        }
        iconBg="transparent"
      />
      {!assigned && <MobileAssignButton onAssign={onAssign} />}
    </div>
  );
}

// Offline machine card — no per-machine data fetch (see OfflineMachineRow).
function OfflineMobileCard({
  serialNumber,
  displayName,
  assigned,
  onSelect,
  onAssign,
}: {
  serialNumber: string;
  displayName: string;
  assigned: boolean;
  onSelect: () => void;
  onAssign: () => void;
}) {
  return (
    <div style={{ position: 'relative', opacity: 0.65 }}>
      <NavCard
        onClick={onSelect}
        title={displayName}
        subtitle={`${serialNumber} · offline`}
        icon={
          <span
            style={{
              display: 'inline-block',
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: '#cbd5e0',
            }}
          />
        }
        iconBg="transparent"
      />
      {!assigned && <MobileAssignButton onAssign={onAssign} />}
    </div>
  );
}

function AssignBadge({ onAssign }: { onAssign: () => void }) {
  return (
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
          {!assigned && <AssignBadge onAssign={onAssign} />}
        </span>
        <span className={styles.machineStatus}>{status ?? '…'}</span>
      </button>
    </li>
  );
}

// Offline machines — no telemetry in the live window. Rendered WITHOUT the
// per-machine data fetch (useMachineStatus → useDashboardData), so listing the
// whole fleet doesn't fan out one query per machine. Selecting a row loads its
// data on demand in the detail pane.
function OfflineMachineRow({
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
  return (
    <li>
      <button
        className={`${styles.machineRow} ${styles.machineRowOffline} ${active ? styles.active : ''}`}
        onClick={onSelect}
      >
        <span
          className={styles.statusDot}
          style={{ background: '#cbd5e0' }}
          title={`Offline — ${serialNumber} has no telemetry in the last 10 minutes`}
        />
        <span className={styles.machineName}>
          {displayName}
          {!assigned && <AssignBadge onAssign={onAssign} />}
        </span>
        <span className={styles.machineStatus}>offline</span>
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
  // The status the SMS modal was opened for. Usually the live machine status,
  // but partial-mixing (LEFT_ONLY / RIGHT_ONLY) opens it as NOT_MIXING so it
  // reuses the wellness template + 48h cooldown (see the mixing-wellness button).
  const [smsStatus, setSmsStatus] = useState<MachineStatus | null>(null);
  const [labelOpen, setLabelOpen] = useState(false);
  const smsKind = status ? STATUS_SMS_KIND[status] : null;
  const { labels: existingLabels, refresh: refreshLabels } = useDatasetLabels(serialNumber);

  const hum = latestHumidity(data.liveData);
  const seen = lastReceived(data);
  const mixing = useMemo(() => classifyMixing(data.liveData), [data.liveData]);
  const mixMeta = MIXING_VERDICT_META[mixing.verdict];

  // Partial mixing (one chamber side stalled) warrants the same wellness
  // check-in as NEITHER — which already surfaces via the NOT_MIXING status
  // button. Only offer the extra button when the live status isn't already
  // offering a wellness SMS, so a machine never shows two identical buttons.
  const showMixingWellness =
    assigned &&
    smsKind !== 'wellness' &&
    (mixing.verdict === 'LEFT_ONLY' || mixing.verdict === 'RIGHT_ONLY');

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
            {showMixingWellness && (
              <button
                type="button"
                className={styles.statusSmsBtn}
                onClick={() => setSmsStatus('NOT_MIXING')}
              >
                ✉️ {STATUS_SMS_TEMPLATES.wellness.label}
              </button>
            )}
          </div>
          <p className={styles.muted}>{serialNumber}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className={styles.labelBtn} onClick={() => setLabelOpen(true)}>
            🏷️ Label window
          </button>
          <button className={styles.refreshBtn} onClick={refresh} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </header>

      {error && <p className={styles.error}>Failed to load: {error.message}</p>}

      {status && (
        <div className={styles.statusBanner} style={{ borderLeftColor: color ?? '#bbb' }}>
          <strong>{status}</strong> — {STATUS_DESCRIPTIONS[status]}
          {smsKind && assigned && (
            <button type="button" className={styles.statusSmsBtn} onClick={() => setSmsStatus(status)}>
              ✉️ {STATUS_SMS_TEMPLATES[smsKind].label}
            </button>
          )}
        </div>
      )}

      {existingLabels.length > 0 && (
        <details className={styles.labelList}>
          <summary>{existingLabels.length} label{existingLabels.length === 1 ? '' : 's'} on this serial</summary>
          <ul>
            {existingLabels.map(l => (
              <li key={l.id}>
                <span className={`${styles.labelChip} ${styles[`labelChip_${l.label}`] ?? ''}`}>{l.label}</span>
                <span className={styles.labelMeta}>
                  {new Date(l.started_at).toLocaleDateString()} → {new Date(l.ended_at).toLocaleDateString()}
                  {' '}· {l.source} · {l.confidence}
                </span>
                {l.notes && <span className={styles.labelNotes}>{l.notes}</span>}
                <button
                  className={styles.labelDelete}
                  onClick={async () => {
                    if (!window.confirm(`Delete the "${l.label}" label?`)) return;
                    await deleteDatasetLabel(l.id, serialNumber);
                    refreshLabels();
                  }}
                >×</button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {labelOpen && (
        <LabelWindowModal
          serialNumber={serialNumber}
          onClose={() => setLabelOpen(false)}
          onSaved={() => { setLabelOpen(false); refreshLabels(); }}
        />
      )}

      {smsStatus && (
        <StatusSmsModal
          serialNumber={serialNumber}
          status={smsStatus}
          onClose={() => setSmsStatus(null)}
        />
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
