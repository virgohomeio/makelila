import { useState } from 'react';
import {
  STATUS_META, STATUS_ORDER, getStatusMeta, updateUnitStatus, updateUnitFields,
  QC_CHECK_META,
  type Unit, type UnitStatus, type QcCheck,
} from '../../lib/stock';
import { signedReportUrl } from '../../lib/testReports';
import styles from './Stock.module.css';

export function UnitTable({ units }: { units: Unit[] }) {
  // Preview-confirm pattern: pending status per row.
  // We keep a map of serial → pendingStatus so one row's edit doesn't clobber another's.
  const [pending, setPending] = useState<Record<string, UnitStatus>>({});
  const [busySerial, setBusySerial] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qcSerial, setQcSerial] = useState<string | null>(null);
  const qcUnit = units.find(u => u.serial === qcSerial) ?? null;

  const commit = async (serial: string) => {
    const next = pending[serial];
    if (!next) return;
    // Warn (don't block) when marking a unit ready whose latest electrical
    // test report is a FAIL.
    const unit = units.find(u => u.serial === serial);
    if (next === 'ready' && unit?.electrical_check === 'fail') {
      const ok = window.confirm(`${serial}: latest electrical test is a FAIL. Mark ready to ship anyway?`);
      if (!ok) return;
    }
    setBusySerial(serial); setError(null);
    try {
      await updateUnitStatus(serial, next);
      setPending(prev => {
        const { [serial]: _unused, ...rest } = prev;
        void _unused;
        return rest;
      });
    } catch (e) {
      setError(`${serial}: ${(e as Error).message}`);
    } finally {
      setBusySerial(null);
    }
  };

  if (units.length === 0) {
    return <div className={styles.empty}>No units match the current filters.</div>;
  }

  return (
    <div className={styles.tableWrap}>
      {error && <div className={styles.errorBar}>{error}</div>}
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Serial</th>
            <th>Batch</th>
            <th>Color</th>
            <th>Status</th>
            <th>Assigned to</th>
            <th>Shipped</th>
            <th>Carrier</th>
            <th>QC</th>
            <th>Notes</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {units.map(u => {
            const statusVal = pending[u.serial] ?? u.status;
            const meta = getStatusMeta(statusVal);
            const changed = statusVal !== u.status;
            const shippedDate = u.shipped_at
              ? new Date(u.shipped_at).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' })
              : null;
            // defect_reason takes precedence in the notes column when present —
            // surfaces the "why did this come back" right where scrap/rework
            // rows live.
            const primaryNote = u.defect_reason ?? u.notes;
            return (
              <tr key={u.serial}>
                <td className={styles.serial}>{u.serial}</td>
                <td className={styles.batch}>{u.batch}</td>
                <td>
                  {u.color ? (
                    <span className={styles.colorCell}>
                      <span
                        className={styles.colorSwatch}
                        style={{ background: u.color === 'Black' ? '#1a1a1a' : '#f5f5f5', border: u.color === 'White' ? '1px solid #ccc' : 'none' }}
                      />
                      {u.color}
                    </span>
                  ) : <span className={styles.muted}>—</span>}
                </td>
                <td>
                  <select
                    value={statusVal}
                    onChange={e => setPending(prev => ({
                      ...prev,
                      [u.serial]: e.target.value as UnitStatus,
                    }))}
                    className={styles.statusSelect}
                    style={{
                      color: meta.color,
                      background: meta.bg,
                      borderColor: meta.border,
                    }}
                    disabled={busySerial === u.serial}
                  >
                    {STATUS_ORDER.map(s => (
                      <option key={s} value={s}>{STATUS_META[s].label}</option>
                    ))}
                  </select>
                </td>
                <td>
                  {u.customer_name
                    ? <span>{u.customer_name}{u.customer_order_ref ? ` · ${u.customer_order_ref}` : ''}</span>
                    : <span className={styles.muted}>{u.location ?? '—'}</span>}
                </td>
                <td className={styles.shippedCell}>
                  {shippedDate ?? <span className={styles.muted}>—</span>}
                </td>
                <td>
                  {u.carrier ?? <span className={styles.muted}>—</span>}
                </td>
                <td>
                  <button
                    className={styles.qcCell}
                    onClick={() => setQcSerial(u.serial)}
                    title={`Technician: ${u.technician ?? '—'} · Notes: ${u.defect_notes ?? '—'}`}
                  >
                    <QcChip label="E" v={u.electrical_check} />
                    <QcChip label="M" v={u.mechanical_check} />
                  </button>
                </td>
                <td className={styles.notes} title={primaryNote ?? ''}>
                  {u.defect_reason ? (
                    <span className={styles.defect}>⚠ {u.defect_reason}</span>
                  ) : u.notes ? (
                    u.notes
                  ) : <span className={styles.muted}>—</span>}
                </td>
                <td>
                  {changed && (
                    <button
                      className={styles.updateBtn}
                      onClick={() => void commit(u.serial)}
                      disabled={busySerial === u.serial}
                    >
                      {busySerial === u.serial ? '…' : 'Update'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {qcUnit && (
        <QcEditorModal
          unit={qcUnit}
          onClose={() => setQcSerial(null)}
          onError={setError}
        />
      )}
    </div>
  );
}

function QcChip({ label, v }: { label: string; v: QcCheck | null }) {
  if (!v) {
    return <span className={styles.qcChipEmpty}>{label}:—</span>;
  }
  const meta = QC_CHECK_META[v];
  const sym = v === 'pass' ? '✓' : v === 'fail' ? '✗' : '?';
  return (
    <span
      className={styles.qcChip}
      style={{ color: meta.color, background: meta.bg, borderColor: meta.color + '44' }}
    >
      {label}:{sym}
    </span>
  );
}

function QcEditorModal({
  unit, onClose, onError,
}: {
  unit: Unit;
  onClose: () => void;
  onError: (msg: string | null) => void;
}) {
  const [technician, setTechnician] = useState(unit.technician ?? '');
  const [eCheck, setECheck] = useState<QcCheck | ''>(unit.electrical_check ?? '');
  const [mCheck, setMCheck] = useState<QcCheck | ''>(unit.mechanical_check ?? '');
  const [defectNotes, setDefectNotes] = useState(unit.defect_notes ?? '');
  const [firmwareVersion, setFirmwareVersion] = useState(unit.firmware_version ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true); onError(null);
    try {
      await updateUnitFields(unit.serial, {
        technician:        technician.trim() || null,
        electrical_check:  eCheck || null,
        mechanical_check:  mCheck || null,
        defect_notes:      defectNotes.trim() || null,
        firmware_version:  firmwareVersion.trim() || null,
      });
      onClose();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalCard} onClick={e => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>QC · {unit.serial}</h3>

        <div className={styles.modalField}>
          <label className={styles.modalLabel}>Technician</label>
          <input
            value={technician}
            onChange={e => setTechnician(e.target.value)}
            placeholder="Who last touched this machine"
            className={styles.modalInput}
          />
        </div>

        <div className={styles.modalField}>
          <label className={styles.modalLabel}>Firmware version</label>
          <input
            value={firmwareVersion}
            onChange={e => setFirmwareVersion(e.target.value)}
            placeholder="e.g. v1.2.4"
            className={styles.modalInput}
          />
        </div>

        <div className={styles.modalField}>
          <label className={styles.modalLabel}>Electrical check</label>
          <QcTri value={eCheck} onChange={setECheck} />
          {unit.test_report_path && (
            <div className={styles.reportLink}>
              Report:{' '}
              <button
                type="button"
                className={styles.reportOpenBtn}
                onClick={async () => {
                  try { window.open(await signedReportUrl(unit.test_report_path!), '_blank', 'noopener'); }
                  catch (e) { onError((e as Error).message); }
                }}
              >
                {unit.test_report_name ?? 'test report'} ↗
              </button>
              {unit.test_report_uploaded_at && (
                <span className={styles.muted}> · {new Date(unit.test_report_uploaded_at).toLocaleDateString('en-US')}</span>
              )}
            </div>
          )}
        </div>

        <div className={styles.modalField}>
          <label className={styles.modalLabel}>Mechanical check</label>
          <QcTri value={mCheck} onChange={setMCheck} />
        </div>

        <div className={styles.modalField}>
          <label className={styles.modalLabel}>Defect notes</label>
          <textarea
            value={defectNotes}
            onChange={e => setDefectNotes(e.target.value)}
            placeholder="Free-form notes on any defects found"
            className={styles.modalInput}
            rows={4}
          />
        </div>

        <div className={styles.modalActions}>
          <button onClick={onClose} disabled={busy} className={styles.btnSecondary}>Cancel</button>
          <button onClick={() => void save()} disabled={busy} className={styles.btnPrimary}>
            {busy ? 'Saving…' : 'Save QC'}
          </button>
        </div>
      </div>
    </div>
  );
}

function QcTri({ value, onChange }: { value: QcCheck | ''; onChange: (v: QcCheck | '') => void }) {
  const options: Array<{ k: QcCheck | ''; label: string }> = [
    { k: 'pass',       label: '✓ Pass' },
    { k: 'fail',       label: '✗ Fail' },
    { k: 'incomplete', label: '? Incomplete' },
    { k: '',           label: '— Unset' },
  ];
  return (
    <div className={styles.qcTriGroup}>
      {options.map(o => {
        const selected = value === o.k;
        const meta = o.k ? QC_CHECK_META[o.k] : null;
        return (
          <button
            key={o.k}
            type="button"
            onClick={() => onChange(o.k)}
            className={`${styles.qcTriBtn} ${selected ? styles.qcTriBtnActive : ''}`}
            style={selected && meta ? {
              background: meta.bg, color: meta.color, borderColor: meta.color,
            } : undefined}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
