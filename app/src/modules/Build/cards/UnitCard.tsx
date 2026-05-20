import {
  type BuildDefect, type BurnInTest, SEVERITY_META,
} from '../../../lib/build';
import type { Unit } from '../../../lib/stock';
import styles from '../Build.module.css';

type Mode = 'iqc' | 'rework' | 'burnin' | 'ready';

type Props = {
  mode: Mode;
  unit: Unit;
  defects: BuildDefect[];
  test?: BurnInTest;
  onClick: () => void;
};

export function UnitCard({ mode, unit, defects, test, onClick }: Props) {
  const openDefects = defects.filter(d => d.status === 'open' || d.status === 'in_rework');
  const worstSeverity = openDefects.reduce<string>((acc, d) => {
    const order = { critical: 4, high: 3, medium: 2, low: 1 };
    if (order[d.severity] > (order[acc as keyof typeof order] || 0)) return d.severity;
    return acc;
  }, '');

  let bottom: React.ReactNode = null;
  if (mode === 'iqc') {
    bottom = openDefects.length === 0
      ? <span style={{ color: 'var(--color-success)' }}>Pass — release to burn-in</span>
      : (
        <span>
          {openDefects.length} open
          {worstSeverity && (
            <span className={styles.pill}
              style={{
                marginLeft: 6,
                background: SEVERITY_META[worstSeverity as keyof typeof SEVERITY_META].color,
                color: '#fff',
              }}>
              {SEVERITY_META[worstSeverity as keyof typeof SEVERITY_META].label}
            </span>
          )}
        </span>
      );
  } else if (mode === 'rework') {
    const summary = openDefects[0]?.subject ?? '—';
    const days = Math.floor((Date.now() - new Date(unit.status_updated_at).getTime()) / 86_400_000);
    bottom = <span>{summary} · {days}d in rework</span>;
  } else if (mode === 'burnin') {
    if (test) {
      const elapsedMs = (test.ended_at ? new Date(test.ended_at).getTime() : Date.now())
                        - new Date(test.started_at).getTime();
      const hours = Math.round(elapsedMs / 3_600_000);
      const pct = Math.min(100, Math.round((hours / test.duration_target_hours) * 100));
      bottom = (
        <>
          <span>{hours}h / {test.duration_target_hours}h</span>
          <div className={styles.cardProgress}>
            <div className={styles.cardProgressFill} style={{ width: `${pct}%` }} />
          </div>
        </>
      );
    } else {
      bottom = <span>(no burn-in yet)</span>;
    }
  } else {
    bottom = <span style={{ color: 'var(--color-success)' }}>&#10003; Ready</span>;
  }

  return (
    <div className={styles.card} onClick={onClick}>
      <div className={styles.cardTitle + ' ' + styles.cardMono}>{unit.serial}</div>
      <div style={{ fontSize: 10, color: 'var(--color-ink-subtle)', marginTop: 2 }}>
        {unit.batch} {unit.color ? `· ${unit.color}` : ''}
      </div>
      <div style={{ fontSize: 10, color: 'var(--color-ink-muted)', marginTop: 6 }}>
        {bottom}
      </div>
    </div>
  );
}
