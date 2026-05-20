import { useState } from 'react';
import type { Unit } from '../../../lib/stock';
import {
  type BuildDefect, type BurnInTest,
  SEVERITY_META, DEFECT_CATEGORY_META, DEFECT_STATUS_META,
  logDefect, startBurnIn, endBurnIn, releaseToFulfillment,
} from '../../../lib/build';
import { DefectDetail } from './DefectDetail';
import styles from '../Build.module.css';

type Props = {
  unit: Unit;
  defects: BuildDefect[];
  tests: BurnInTest[];
  onClose: () => void;
};

const CATEGORY_OPTIONS = [
  'electrical','mechanical','aesthetic','firmware','assembly','packaging','other',
] as const;

export function UnitDetail({ unit, defects, tests, onClose }: Props) {
  const [selectedDefectId, setSelectedDefectId] = useState<string | null>(null);
  const [showNewDefect, setShowNewDefect] = useState(false);
  const [newDefect, setNewDefect] = useState({ category: 'mechanical' as typeof CATEGORY_OPTIONS[number], subject: '', description: '', severity: 'medium' as 'critical'|'high'|'medium'|'low' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openDefects = defects.filter(d => d.status === 'open' || d.status === 'in_rework');
  const activeBurnIn = tests.find(t => !t.ended_at) ?? null;

  async function run<T>(p: Promise<T>) {
    setBusy(true); setError(null);
    try { await p; }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function submitNewDefect() {
    if (!newDefect.subject.trim()) { setError('Subject required'); return; }
    await run(logDefect({
      unit_serial: unit.serial,
      category: newDefect.category,
      subject: newDefect.subject,
      description: newDefect.description || undefined,
      severity: newDefect.severity,
      status: 'in_rework',
    }));
    setShowNewDefect(false);
    setNewDefect({ category: 'mechanical', subject: '', description: '', severity: 'medium' });
  }

  const selectedDefect = selectedDefectId ? defects.find(d => d.id === selectedDefectId) ?? null : null;

  return (
    <div className={styles.detailOverlay}>
      <div className={styles.detailHead}>
        <div>
          <h3 className={`${styles.detailTitle} ${styles.cardMono}`}>{unit.serial}</h3>
          <div className={styles.detailSub}>{unit.batch} · {unit.status} · {unit.color ?? ''}</div>
        </div>
        <button className={styles.detailClose} onClick={onClose}>✕</button>
      </div>

      <div className={styles.detailBody}>

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Quick actions</div>
          <div className={styles.actionsRow}>
            <button className={styles.btnSecondary} disabled={busy} onClick={() => setShowNewDefect(s => !s)}>
              + Log defect
            </button>
            {!activeBurnIn && openDefects.length === 0 && (
              <button className={styles.btnPrimary} disabled={busy}
                onClick={() => run(startBurnIn(unit.serial, 24))}>
                Start 24h burn-in
              </button>
            )}
            {activeBurnIn && (
              <>
                <button className={styles.btnPrimary} disabled={busy}
                  onClick={() => run(endBurnIn(activeBurnIn.id, 'pass'))}>
                  Burn-in PASS
                </button>
                <button className={styles.btnSecondary} disabled={busy}
                  onClick={() => {
                    const reason = window.prompt('Failure mode (required):') ?? '';
                    if (reason) void run(endBurnIn(activeBurnIn.id, 'fail', reason));
                  }}>
                  Burn-in FAIL
                </button>
                <button className={styles.btnSecondary} disabled={busy}
                  onClick={() => run(endBurnIn(activeBurnIn.id, 'aborted'))}>
                  Abort burn-in
                </button>
              </>
            )}
            {unit.status === 'ready' && (
              <button className={styles.btnPrimary} disabled={busy}
                onClick={() => run(releaseToFulfillment(unit.serial))}>
                Release to Fulfillment ✓
              </button>
            )}
          </div>
        </div>

        {showNewDefect && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionLabel}>New defect</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <select className={styles.select}
                value={newDefect.category}
                onChange={e => setNewDefect(s => ({ ...s, category: e.target.value as typeof s.category }))}>
                {CATEGORY_OPTIONS.map(c => (
                  <option key={c} value={c}>{DEFECT_CATEGORY_META[c].label}</option>
                ))}
              </select>
              <select className={styles.select}
                value={newDefect.severity}
                onChange={e => setNewDefect(s => ({ ...s, severity: e.target.value as typeof s.severity }))}>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
              <input className={styles.input} placeholder="Subject (short)"
                value={newDefect.subject}
                onChange={e => setNewDefect(s => ({ ...s, subject: e.target.value }))} />
              <textarea className={styles.textarea} placeholder="Description (longer)"
                value={newDefect.description}
                onChange={e => setNewDefect(s => ({ ...s, description: e.target.value }))} />
              <div className={styles.actionsRow}>
                <button className={styles.btnPrimary} disabled={busy} onClick={submitNewDefect}>Save defect</button>
                <button className={styles.btnSecondary} disabled={busy} onClick={() => setShowNewDefect(false)}>Cancel</button>
              </div>
            </div>
          </div>
        )}

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Defects ({defects.length})</div>
          {defects.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--color-ink-subtle)' }}>No defects logged.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {defects.map(d => {
                const sm = DEFECT_STATUS_META[d.status];
                const cm = DEFECT_CATEGORY_META[d.category];
                const sev = SEVERITY_META[d.severity];
                return (
                  <div key={d.id}
                    onClick={() => setSelectedDefectId(d.id)}
                    style={{
                      padding: 8, border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                    }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                      <span className={styles.pill} style={{ background: cm.bg, color: cm.color }}>{cm.label}</span>
                      <span className={styles.pill} style={{ background: sm.bg, color: sm.color }}>{sm.label}</span>
                      <span className={styles.pill} style={{ background: sev.color, color: '#fff' }}>{sev.label}</span>
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-ink)' }}>{d.subject}</div>
                    {d.description && (
                      <div style={{ fontSize: 11, color: 'var(--color-ink-muted)', marginTop: 2 }}>
                        {d.description.slice(0, 100)}{d.description.length > 100 ? '…' : ''}
                      </div>
                    )}
                    <div style={{ fontSize: 10, color: 'var(--color-ink-subtle)', marginTop: 4 }}>
                      {new Date(d.found_at).toLocaleDateString()} · {d.found_by_name ?? 'system'}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Burn-in history ({tests.length})</div>
          {tests.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--color-ink-subtle)' }}>No burn-in runs yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {tests.map(t => {
                const resultColor = t.result === 'pass' ? '#276749'
                                  : t.result === 'fail' ? '#a51b1b'
                                  : t.result === 'aborted' ? '#9a4a0a'
                                  : '#718096';
                return (
                  <div key={t.id} style={{ fontSize: 11, padding: '6px 8px',
                    background: 'var(--color-surface)', borderRadius: 'var(--radius-sm)' }}>
                    <span style={{ color: resultColor, fontWeight: 700 }}>{t.result ?? 'running'}</span>
                    {' · '}
                    <span>{new Date(t.started_at).toLocaleDateString()}</span>
                    {t.ended_at && <> → <span>{new Date(t.ended_at).toLocaleDateString()}</span></>}
                    {' · '}
                    <span>{t.duration_target_hours}h target</span>
                    {t.failure_mode && <div style={{ color: 'var(--color-ink-muted)', marginTop: 2 }}>{t.failure_mode}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {error && <div style={{ color: 'var(--color-error)', fontSize: 11 }}>{error}</div>}
      </div>

      {selectedDefect && (
        <DefectDetail defect={selectedDefect} onClose={() => setSelectedDefectId(null)} />
      )}
    </div>
  );
}
