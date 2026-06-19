import { useMemo, useState } from 'react';
import { useLovelyOta, upsertLovelyOta, liveOtaId, type LovelyOtaUpdate } from '../../lib/lovely';
import { logAction } from '../../lib/activityLog';
import styles from './Lovely.module.css';

type FormState = {
  id?: string;
  version: string;
  description: string;
  release_notes: string;
  is_active: boolean;
};

const EMPTY_FORM: FormState = { version: '', description: '', release_notes: '', is_active: false };

export function FirmwareTab() {
  const { updates, loading, error, refetch } = useLovelyOta();
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const liveId = useMemo(() => liveOtaId(updates), [updates]);

  const save = async () => {
    if (!form) return;
    if (!form.version.trim()) {
      setFormErr('Version is required.');
      return;
    }
    setBusy(true);
    setFormErr(null);
    try {
      const saved = await upsertLovelyOta({
        id: form.id,
        version: form.version.trim(),
        description: form.description.trim() || null,
        release_notes: form.release_notes.trim() || null,
        is_active: form.is_active,
      });
      await logAction(
        'lovely_ota_upsert',
        saved.version,
        `${form.id ? 'Edited' : 'Created'} OTA update ${saved.version} (active=${form.is_active})`,
      );
      await refetch();
      setForm(null);
    } catch (e) {
      setFormErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (u: LovelyOtaUpdate) => {
    setBusy(true);
    setFormErr(null);
    try {
      await upsertLovelyOta({
        id: u.id,
        version: u.version,
        description: u.description,
        release_notes: u.release_notes,
        is_active: !u.is_active,
      });
      await logAction(
        'lovely_ota_upsert',
        u.version,
        `${u.is_active ? 'Deactivated' : 'Activated'} OTA update ${u.version}`,
      );
      await refetch();
    } catch (e) {
      setFormErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openEdit = (u: LovelyOtaUpdate) => {
    setForm({
      id: u.id,
      version: u.version,
      description: u.description ?? '',
      release_notes: u.release_notes ?? '',
      is_active: !!u.is_active,
    });
    setFormErr(null);
  };

  return (
    <>
      <div className={styles.sectionNote}>
        The Lovely app offers the <strong>newest active</strong> update to users (marked “Live”).
        New updates start inactive — flip them on when ready to ship.
      </div>

      <div className={styles.firmwareActions}>
        <button className={styles.newBtn} onClick={() => { setForm({ ...EMPTY_FORM }); setFormErr(null); }} disabled={busy}>
          + New update
        </button>
      </div>

      {error && (
        <div className={styles.errorBar}>
          Error: {error}{' '}
          <button onClick={() => void refetch()} className={styles.retryBtn}>Retry</button>
        </div>
      )}
      {formErr && <div className={styles.errorBar}>{formErr}</div>}

      {form && (
        <div className={styles.formCard}>
          <div className={styles.formTitle}>{form.id ? 'Edit update' : 'New update'}</div>
          <label className={styles.formRow}>
            <span className={styles.formLabel}>Version *</span>
            <input
              className={styles.input}
              value={form.version}
              onChange={e => setForm({ ...form, version: e.target.value })}
              placeholder="e.g. 1.4.0"
            />
          </label>
          <label className={styles.formRow}>
            <span className={styles.formLabel}>Description</span>
            <input
              className={styles.input}
              value={form.description}
              onChange={e => setForm({ ...form, description: e.target.value })}
            />
          </label>
          <label className={styles.formRow}>
            <span className={styles.formLabel}>Release notes</span>
            <textarea
              className={styles.textarea}
              rows={4}
              value={form.release_notes}
              onChange={e => setForm({ ...form, release_notes: e.target.value })}
            />
          </label>
          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={e => setForm({ ...form, is_active: e.target.checked })}
            />
            <span>Active — offer this update to users (the newest active one is served)</span>
          </label>
          <div className={styles.formActions}>
            <button className={styles.saveBtn} disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button className={styles.cancelBtn} disabled={busy} onClick={() => setForm(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Version</th>
              <th>Description</th>
              <th>Release notes</th>
              <th>Status</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && updates.length === 0 ? (
              <tr><td colSpan={6} className={styles.empty}>Loading…</td></tr>
            ) : updates.length === 0 ? (
              <tr><td colSpan={6} className={styles.empty}>No updates yet. Create one above.</td></tr>
            ) : (
              updates.map(u => (
                <tr key={u.id}>
                  <td><strong>{u.version}</strong></td>
                  <td>{u.description || <span className={styles.muted}>—</span>}</td>
                  <td title={u.release_notes ?? ''}>
                    {u.release_notes ? truncate(u.release_notes, 60) : <span className={styles.muted}>—</span>}
                  </td>
                  <td>
                    {u.is_active ? <span className={styles.badgeOk}>Active</span> : <span className={styles.badgeNeutral}>Inactive</span>}
                    {u.id === liveId && <span className={styles.liveBadge}>Live</span>}
                  </td>
                  <td className={styles.mono}>
                    {u.updated_at ? new Date(u.updated_at).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' }) : '—'}
                  </td>
                  <td>
                    <div className={styles.rowActions}>
                      <button className={styles.linkBtn} disabled={busy} onClick={() => openEdit(u)}>Edit</button>
                      <button className={styles.toggleBtn} disabled={busy} onClick={() => void toggleActive(u)}>
                        {u.is_active ? 'Deactivate' : 'Activate'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
