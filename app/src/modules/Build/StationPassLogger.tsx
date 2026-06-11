import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import {
  type StationPassStation,
  type StationPassStatus,
  type StationPassDefectCategory,
  recordStationPass,
} from '../../lib/build';
import styles from './Build.module.css';

type Props = {
  unitSerial: string;
  onClose: () => void;
};

const STATIONS: { key: StationPassStation; label: string }[] = [
  { key: 'electrical',    label: 'Electrical' },
  { key: 'mechanical',    label: 'Mechanical' },
  { key: 'firmware_flash', label: 'Firmware' },
  { key: 'final_qa',      label: 'Final QA' },
];

const STATUSES: { key: StationPassStatus; label: string }[] = [
  { key: 'pass',       label: 'Pass' },
  { key: 'fail',       label: 'Fail' },
  { key: 'incomplete', label: 'Incomplete' },
  { key: 'rework',     label: 'Rework' },
];

const DEFECT_CATEGORIES: { key: StationPassDefectCategory; label: string }[] = [
  { key: 'solder_issue',         label: 'Solder issue' },
  { key: 'loose_connection',     label: 'Loose connection' },
  { key: 'firmware_flash_failed',label: 'Firmware flash failed' },
  { key: 'display_issue',        label: 'Display issue' },
  { key: 'motor_issue',          label: 'Motor issue' },
  { key: 'sensor_issue',         label: 'Sensor issue' },
  { key: 'mechanical_alignment', label: 'Mechanical alignment' },
  { key: 'other',                label: 'Other' },
];

export function StationPassLogger({ unitSerial, onClose }: Props) {
  const [station, setStation] = useState<StationPassStation | null>(null);
  const [passStatus, setPassStatus] = useState<StationPassStatus | null>(null);
  const [defectCategory, setDefectCategory] = useState<StationPassDefectCategory | null>(null);
  const [defectNotes, setDefectNotes] = useState('');
  const [firmwareVersion, setFirmwareVersion] = useState('');
  const [files, setFiles] = useState<FileList | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const needsDefectFields = passStatus === 'fail' || passStatus === 'rework';
  const needsFirmware = station === 'firmware_flash';

  async function handleSubmit() {
    if (!station) { setError('Select a station'); return; }
    if (!passStatus) { setError('Select a result'); return; }
    setBusy(true);
    setError(null);
    try {
      // Upload photos first
      const photoUrls: string[] = [];
      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const timestamp = Date.now();
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          const path = `${unitSerial}/${timestamp}-${i}-${safeName}`;
          const { error: uploadErr } = await supabase.storage
            .from('build-attachments')
            .upload(path, file, { cacheControl: '3600', upsert: false });
          if (uploadErr) throw uploadErr;
          photoUrls.push(path);
        }
      }

      await recordStationPass({
        unit_serial: unitSerial,
        station,
        pass_status: passStatus,
        defect_category: needsDefectFields ? defectCategory : null,
        defect_notes: needsDefectFields && defectNotes.trim() ? defectNotes.trim() : null,
        firmware_version: needsFirmware && firmwareVersion.trim() ? firmwareVersion.trim() : null,
        photo_urls: photoUrls,
      });
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className={styles.detailOverlay}>
        <div className={styles.detailHead}>
          <h3 className={styles.detailTitle}>Pass logged</h3>
          <button className={styles.detailClose} onClick={onClose}>✕</button>
        </div>
        <div className={styles.detailBody}>
          <div className={styles.passLoggerSuccess}>
            Station pass recorded for <span className={styles.cardMono}>{unitSerial}</span>.
          </div>
          <div className={styles.actionsRow}>
            <button className={styles.btnPrimary} onClick={() => {
              setDone(false);
              setStation(null);
              setPassStatus(null);
              setDefectCategory(null);
              setDefectNotes('');
              setFirmwareVersion('');
              setFiles(null);
            }}>Log another</button>
            <button className={styles.btnSecondary} onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.detailOverlay}>
      <div className={styles.detailHead}>
        <div>
          <h3 className={styles.detailTitle}>Log station pass</h3>
          <div className={styles.detailSub}>{unitSerial}</div>
        </div>
        <button className={styles.detailClose} onClick={onClose}>✕</button>
      </div>

      <div className={styles.detailBody}>
        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Station</div>
          <div className={styles.passLoggerButtonGrid}>
            {STATIONS.map(s => (
              <button
                key={s.key}
                className={`${styles.passLoggerBigBtn} ${station === s.key ? styles.passLoggerBigBtnActive : ''}`}
                onClick={() => setStation(s.key)}
                disabled={busy}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Result</div>
          <div className={styles.passLoggerButtonGrid}>
            {STATUSES.map(s => (
              <button
                key={s.key}
                className={[
                  styles.passLoggerBigBtn,
                  styles[`passLoggerStatus_${s.key}`],
                  passStatus === s.key ? styles.passLoggerBigBtnActive : '',
                ].filter(Boolean).join(' ')}
                onClick={() => setPassStatus(s.key)}
                disabled={busy}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {needsFirmware && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionLabel}>Firmware version</div>
            <input
              className={styles.input}
              placeholder="e.g. v2.4.1"
              value={firmwareVersion}
              onChange={e => setFirmwareVersion(e.target.value)}
              disabled={busy}
            />
          </div>
        )}

        {needsDefectFields && (
          <>
            <div className={styles.detailSection}>
              <div className={styles.detailSectionLabel}>Defect category</div>
              <select
                className={styles.select}
                value={defectCategory ?? ''}
                onChange={e => setDefectCategory(e.target.value as StationPassDefectCategory || null)}
                disabled={busy}
              >
                <option value="">— select —</option>
                {DEFECT_CATEGORIES.map(c => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
            </div>
            <div className={styles.detailSection}>
              <div className={styles.detailSectionLabel}>Defect notes</div>
              <textarea
                className={styles.textarea}
                placeholder="Describe the defect..."
                value={defectNotes}
                onChange={e => setDefectNotes(e.target.value)}
                disabled={busy}
              />
            </div>
          </>
        )}

        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>Photos / video (optional)</div>
          <input
            type="file"
            accept="image/*,video/*"
            multiple
            className={styles.passLoggerFileInput}
            onChange={e => setFiles(e.target.files)}
            disabled={busy}
          />
          {files && files.length > 0 && (
            <div className={styles.passLoggerFileCount}>
              {files.length} file{files.length > 1 ? 's' : ''} selected
            </div>
          )}
        </div>

        {error && <div className={styles.passLoggerError}>{error}</div>}

        <div className={styles.actionsRow}>
          <button
            className={styles.btnPrimary}
            onClick={handleSubmit}
            disabled={busy || !station || !passStatus}
          >
            {busy ? 'Saving…' : 'Record pass'}
          </button>
          <button className={styles.btnSecondary} onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
