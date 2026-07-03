import { useEffect, useMemo, useState } from 'react';
import { useLovelyUsers, approveLovelyUser, type LovelyUser } from '../../lib/lovely';
import {
  diagnoseUser, fetchVerificationContext, addSerialAndVerify,
  type Diagnosis, type VerificationContext,
} from '../../lib/lovelyVerification';
import { logAction } from '../../lib/activityLog';
import styles from './Lovely.module.css';

const VERDICT_BADGE: Record<Diagnosis['verdict'], { label: string; className: string }> = {
  will_auto_verify: { label: 'Will auto-verify', className: 'badgeOk' },
  serial_mismatch:  { label: 'Serial mismatch',  className: 'badgeWarn' },
  no_customer:      { label: 'No customer',      className: 'badgeErr' },
  no_serial:        { label: 'No serial',        className: 'badgeErr' },
};

export function VerificationTab() {
  const { users, loading, error, refetch } = useLovelyUsers();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [ctx, setCtx] = useState<VerificationContext | null>(null);
  const [ctxErr, setCtxErr] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const pending = useMemo(
    () =>
      users
        .filter(u => u.is_verified !== true)
        .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')),
    [users],
  );

  useEffect(() => {
    if (pending.length === 0) {
      if (!loading) {
        setCtx({ customersByEmail: [], serialOwners: [] });
        setCtxErr(null);
      }
      return;
    }
    setCtx(null);
    setCtxErr(null);
    let cancelled = false;
    (async () => {
      try {
        const next = await fetchVerificationContext(pending);
        if (!cancelled) { setCtx(next); setCtxErr(null); }
      } catch (e) {
        if (!cancelled) { setCtx(null); setCtxErr((e as Error).message); }
      }
    })();
    return () => { cancelled = true; };
  }, [pending, loading]);

  const approve = async (u: LovelyUser) => {
    setBusyId(u.id);
    setActionErr(null);
    try {
      await approveLovelyUser(u.id);
      await logAction('lovely_user_verified', u.email ?? u.id, `Approved Lovely app user ${u.email ?? u.id}`);
      await refetch();
    } catch (e) {
      setActionErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  // Add the serial to the ops customer (durable + audited), then verify the
  // user. addSerialAndVerify logs its own activity entry.
  const fix = async (u: LovelyUser, customerId: string) => {
    setBusyId(u.id);
    setActionErr(null);
    try {
      await addSerialAndVerify(u, customerId);
      await refetch();
    } catch (e) {
      setActionErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const renderDiagnosis = (u: LovelyUser) => {
    if (ctxErr) return <span className={styles.muted}>Diagnosis unavailable</span>;
    if (!ctx) return <span className={styles.muted}>…</span>;
    const d = diagnoseUser(u, ctx.customersByEmail, ctx.serialOwners);
    const badge = VERDICT_BADGE[d.verdict];
    return (
      <span className={styles.diagCell}>
        <span className={styles[badge.className]}>{badge.label}</span>
        {(d.matchedCustomers.length > 0 || d.serialOwner) && (
          <button
            className={styles.linkBtn}
            onClick={() => setExpandedId(expandedId === u.id ? null : u.id)}
          >
            {expandedId === u.id ? 'hide' : 'detail'}
          </button>
        )}
      </span>
    );
  };

  const renderDetail = (u: LovelyUser) => {
    if (!ctx || expandedId !== u.id) return null;
    const d = diagnoseUser(u, ctx.customersByEmail, ctx.serialOwners);
    return (
      <tr key={`${u.id}-detail`} className={styles.diagDetailRow}>
        <td colSpan={7}>
          <div className={styles.diagDetail}>
            {d.matchedCustomers.map(c => (
              <span key={c.id}>
                Customer <strong>{c.full_name ?? c.email}</strong>: serials{' '}
                <span className={styles.mono}>{(c.serials ?? []).join(', ') || 'none'}</span>
                {' '}vs user serial{' '}
                <span className={styles.mono}>{u.serial_number ?? 'none'}</span>
              </span>
            ))}
            {d.serialOwner && (
              <span className={styles.calloutBar}>
                Warning: this serial is already on{' '}
                <strong>{d.serialOwner.full_name ?? d.serialOwner.email}</strong>. No automated
                fix; check which customer actually owns the unit.
              </span>
            )}
          </div>
        </td>
      </tr>
    );
  };

  const renderActions = (u: LovelyUser) => {
    const d = ctx && !ctxErr ? diagnoseUser(u, ctx.customersByEmail, ctx.serialOwners) : null;
    // If the serial already sits on a different customer's array, this is a
    // warning-only case (see the detail row) — no automated fix, since we
    // don't know which customer actually owns the physical unit.
    const fixTarget = d?.verdict === 'serial_mismatch' && !d.serialOwner ? d.matchedCustomers[0] : null;
    return (
      <>
        {fixTarget && (
          <button
            className={styles.fixBtn}
            disabled={busyId === u.id}
            onClick={() => void fix(u, fixTarget.id)}
            title={`Add ${u.serial_number} to ${fixTarget.full_name ?? fixTarget.email} and verify`}
          >
            {busyId === u.id ? 'Fixing…' : 'Add serial + verify'}
          </button>
        )}{' '}
        <button
          className={styles.approveBtn}
          disabled={busyId === u.id}
          onClick={() => void approve(u)}
        >
          {busyId === u.id ? 'Approving…' : 'Approve'}
        </button>
      </>
    );
  };

  return (
    <>
      <div className={styles.sectionNote}>
        Approving sets the user to verified in the Lovely app; they're let through the
        pending-approval gate on their next visit. Diagnosis shows why each user didn't
        auto-verify; "Add serial + verify" also fixes the customer record.
      </div>
      {error && (
        <div className={styles.errorBar}>
          Error: {error}{' '}
          <button onClick={() => void refetch()} className={styles.retryBtn}>Retry</button>
        </div>
      )}
      {ctxErr && <div className={styles.errorBar}>Diagnosis unavailable: {ctxErr}</div>}
      {actionErr && <div className={styles.errorBar}>{actionErr}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Paired serial</th>
              <th>Step</th>
              <th>Signed up</th>
              <th>Diagnosis</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && users.length === 0 ? (
              <tr><td colSpan={7} className={styles.empty}>Loading…</td></tr>
            ) : pending.length === 0 ? (
              <tr><td colSpan={7} className={styles.empty}>No users pending verification. 🎉</td></tr>
            ) : (
              pending.flatMap(u => [
                <tr key={u.id}>
                  <td><strong>{[u.first_name, u.last_name].filter(Boolean).join(' ') || <span className={styles.muted}>—</span>}</strong></td>
                  <td className={styles.mono}>{u.email || <span className={styles.muted}>—</span>}</td>
                  <td className={styles.mono}>{u.serial_number || <span className={styles.muted}>—</span>}</td>
                  <td>{u.onboarding_step || <span className={styles.muted}>—</span>}</td>
                  <td className={styles.mono}>
                    {u.created_at
                      ? new Date(u.created_at).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' })
                      : '—'}
                  </td>
                  <td>{renderDiagnosis(u)}</td>
                  <td>{renderActions(u)}</td>
                </tr>,
                renderDetail(u),
              ])
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
