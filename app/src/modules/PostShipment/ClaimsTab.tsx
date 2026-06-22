import { useEffect, useMemo, useState } from 'react';
import {
  useShippingDamageClaims, updateClaimStatus, getClaimPhotos, signedPhotoUrl,
  CLAIM_STATUSES, CLAIM_STATUS_META,
  type ShippingDamageClaim, type ClaimStatus,
} from '../../lib/claims';
import styles from './PostShipment.module.css';

type Filter = 'all' | 'open' | 'closed';
const OPEN_STATUSES: ClaimStatus[] = ['submitted', 'in_review', 'approved'];

export function ClaimsTab() {
  const { claims, loading } = useShippingDamageClaims();
  const [filter, setFilter] = useState<Filter>('open');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return claims.filter(c => {
      const open = OPEN_STATUSES.includes(c.status);
      if (filter === 'open' && !open) return false;
      if (filter === 'closed' && open) return false;
      if (q && !(
        (c.claim_ref ?? '').toLowerCase().includes(q) ||
        c.customer_name.toLowerCase().includes(q) ||
        c.tracking_number.toLowerCase().includes(q) ||
        (c.customer_email ?? '').toLowerCase().includes(q)
      )) return false;
      return true;
    });
  }, [claims, filter, search]);

  const stats = useMemo(() => {
    const s = { total: claims.length, open: 0, approved: 0 };
    for (const c of claims) {
      if (OPEN_STATUSES.includes(c.status)) s.open++;
      if (c.status === 'approved') s.approved++;
    }
    return s;
  }, [claims]);

  const selected = useMemo(() => claims.find(c => c.id === selectedId) ?? null, [claims, selectedId]);

  if (loading) return <div className={styles.loading}>Loading claims…</div>;

  return (
    <div className={styles.tabContent}>
      <div className={styles.kpiRow}>
        <KPI label="Open claims" value={stats.open} tone={stats.open > 0 ? 'warn' : undefined}
             sub={stats.open > 0 ? 'click to review' : 'queue clear'} />
        <KPI label="Approved" value={stats.approved} sub="awaiting resolution" />
        <KPI label="Total claims" value={stats.total} sub="all time" />
      </div>

      <div className={styles.filterBar}>
        {(['open', 'closed', 'all'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`${styles.chip} ${filter === f ? styles.chipActive : ''}`}>
            {f === 'open' ? 'Open' : f === 'closed' ? 'Closed' : 'All'}
          </button>
        ))}
        <input type="search" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search ref, customer, tracking #, email…" className={styles.searchInput} />
        <div className={styles.resultCount}>{rows.length} {rows.length === 1 ? 'row' : 'rows'}</div>
      </div>

      {error && <div className={styles.errorBar}>{error}</div>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Submitted</th>
              <th>Ref</th>
              <th>Customer</th>
              <th>Tracking #</th>
              <th>Photos</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(c => {
              const meta = CLAIM_STATUS_META[c.status];
              return (
                <tr key={c.id}
                  className={`${styles.cancellationRow} ${selectedId === c.id ? styles.cancellationRowSelected : ''}`}
                  onClick={() => setSelectedId(prev => prev === c.id ? null : c.id)}>
                  <td className={styles.mono}>{new Date(c.created_at).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' })}</td>
                  <td className={styles.mono}>{c.claim_ref ?? '—'}</td>
                  <td><strong>{c.customer_name}</strong><br /><span className={styles.muted}>{c.customer_email ?? '—'}</span></td>
                  <td className={styles.mono}>{c.tracking_number}</td>
                  <td>📷 {c.photo_count}</td>
                  <td><span className={styles.cancStatusPill} style={{ color: meta.color, background: meta.bg }}>{meta.label}</span></td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={6} className={styles.empty}>No claims match the filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <ClaimDetail claim={selected} onClose={() => setSelectedId(null)} onError={setError} />
      )}
    </div>
  );
}

function ClaimDetail({
  claim: c, onClose, onError,
}: {
  claim: ShippingDamageClaim;
  onClose: () => void;
  onError: (m: string | null) => void;
}) {
  const [photoUrls, setPhotoUrls] = useState<{ url: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const meta = CLAIM_STATUS_META[c.status];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const photos = await getClaimPhotos(c.id);
      const urls = await Promise.all(photos.map(async p => ({
        url: (await signedPhotoUrl(p.file_path)) ?? '', name: p.file_name ?? 'photo',
      })));
      if (!cancelled) setPhotoUrls(urls.filter(u => u.url));
    })().catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [c.id]);

  const setStatus = (status: ClaimStatus) => {
    setBusy(true); onError(null);
    void updateClaimStatus(c.id, status).catch(e => onError((e as Error).message)).finally(() => setBusy(false));
  };

  return (
    <div className={styles.refundDetail}>
      <div className={styles.refundDetailHead}>
        <div>
          <div className={styles.refundDetailTitleRow}>
            <h3 className={styles.refundDetailTitle}>{c.customer_name}</h3>
            <span className={styles.refundDetailStatusPill} style={{ color: meta.color, background: meta.bg }}>{meta.label}</span>
          </div>
          <div className={styles.refundDetailSub}>
            {c.claim_ref ?? '—'} · {c.customer_email ?? '—'} · {c.customer_phone ?? '—'}
          </div>
        </div>
        <button onClick={onClose} className={styles.refundDetailClose} title="Close detail">✕</button>
      </div>

      <div className={styles.refundDetailGrid}>
        <DetailField label="Tracking number" value={c.tracking_number} mono />
        <DetailField label="Submitted" value={new Date(c.created_at).toLocaleString('en-US')} mono />
        <DetailField label="Damage description" wide>
          <div className={styles.detailQuote}>{c.description}</div>
        </DetailField>
        <DetailField label={`Photos (${photoUrls.length})`} wide>
          {photoUrls.length === 0
            ? <span className={styles.muted}>No photos.</span>
            : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {photoUrls.map((p, i) => (
                  <a key={i} href={p.url} target="_blank" rel="noreferrer" title={p.name}>
                    <img src={p.url} alt={p.name}
                      style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 6, border: '1px solid #e2e8f0' }} />
                  </a>
                ))}
              </div>
            )}
        </DetailField>
      </div>

      <div className={styles.refundDetailActions}>
        <div className={styles.refundDetailRolePill}>Set the claim status as it moves through review.</div>
        <div className={styles.refundDetailButtons}>
          <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            Status:
            <select value={c.status} disabled={busy} onChange={e => setStatus(e.target.value as ClaimStatus)}
              className={styles.assignSelect}>
              {CLAIM_STATUSES.map(s => <option key={s} value={s}>{CLAIM_STATUS_META[s].label}</option>)}
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}

function DetailField({
  label, value, children, mono, wide,
}: { label: string; value?: string; children?: React.ReactNode; mono?: boolean; wide?: boolean }) {
  return (
    <div className={`${styles.detailField} ${wide ? styles.detailFieldWide : ''}`}>
      <div className={styles.detailFieldLabel}>{label}</div>
      <div className={`${styles.detailFieldValue} ${mono ? styles.detailFieldMono : ''}`}>{children ?? value}</div>
    </div>
  );
}

function KPI({ label, value, tone, sub }: { label: string; value: number | string; tone?: 'warn'; sub?: string }) {
  return (
    <div className={styles.kpi}>
      <div className={styles.kpiLabel}>{label}</div>
      <div className={`${styles.kpiValue} ${tone === 'warn' ? styles.kpiWarn : ''}`}>{value}</div>
      {sub && <div className={styles.kpiSub}>{sub}</div>}
    </div>
  );
}
