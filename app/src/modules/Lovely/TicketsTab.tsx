import { useEffect, useMemo, useState } from 'react';
import { useLovelyUsers, type LovelyUser } from '../../lib/lovely';
import { useLovelyTickets, signDamagePhotos, type LovelyTicket } from '../../lib/lovelyTickets';
import styles from './Lovely.module.css';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function TicketsTab() {
  const { tickets, loading, error, refetch } = useLovelyTickets();
  const { users } = useLovelyUsers();
  const [search, setSearch] = useState('');
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [photoError, setPhotoError] = useState<string | null>(null);

  const usersById = useMemo(() => new Map(users.map(u => [u.id, u])), [users]);

  // Sign every photo path in one call whenever the ticket set changes.
  useEffect(() => {
    const paths = tickets.flatMap(t => t.photoPaths);
    if (paths.length === 0) return;
    let cancelled = false;
    signDamagePhotos(paths)
      .then(urls => { if (!cancelled) { setPhotoUrls(urls); setPhotoError(null); } })
      .catch(e => { if (!cancelled) setPhotoError((e as Error).message); });
    return () => { cancelled = true; };
  }, [tickets]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tickets;
    return tickets.filter(t => {
      const u = t.user_id ? usersById.get(t.user_id) : undefined;
      return (
        (t.serial_number?.toLowerCase().includes(q) ?? false) ||
        (t.notes?.toLowerCase().includes(q) ?? false) ||
        (u ? fullName(u).toLowerCase().includes(q) || u.email.toLowerCase().includes(q) : false)
      );
    });
  }, [tickets, usersById, search]);

  const lastWeek = useMemo(() => {
    const cutoff = Date.now() - WEEK_MS;
    return tickets.filter(t => t.created_at && new Date(t.created_at).getTime() >= cutoff).length;
  }, [tickets]);
  const unitsAffected = useMemo(
    () => new Set(tickets.map(t => t.serial_number).filter(Boolean)).size,
    [tickets],
  );

  return (
    <>
      <div className={styles.kpiRow}>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>Total tickets</div>
          <div className={styles.kpiValue}>{tickets.length}</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>Last 7 days</div>
          <div className={styles.kpiValue}>{lastWeek}</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>Units affected</div>
          <div className={styles.kpiValue}>{unitsAffected}</div>
        </div>
      </div>

      <p className={styles.sectionNote}>
        Damage and missing-item reports filed by customers from the Lovely app's onboarding flow.
      </p>

      <div className={styles.filterBar}>
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search customer, serial, notes…"
          className={styles.searchInput}
        />
        <div className={styles.resultCount}>
          {filtered.length} {filtered.length === 1 ? 'ticket' : 'tickets'}
        </div>
      </div>

      {error && (
        <div className={styles.errorBar}>
          Error: {error}{' '}
          <button onClick={() => void refetch()} className={styles.retryBtn}>Retry</button>
        </div>
      )}
      {photoError && (
        <div className={styles.calloutBar}>
          Photos unavailable. {photoError}
        </div>
      )}

      {loading && tickets.length === 0 ? (
        <div className={styles.tableWrap}><div className={styles.empty}>Loading tickets…</div></div>
      ) : filtered.length === 0 ? (
        <div className={styles.tableWrap}><div className={styles.empty}>No tickets found.</div></div>
      ) : (
        <div className={styles.ticketList}>
          {filtered.map(t => (
            <TicketCard
              key={t.id}
              t={t}
              user={t.user_id ? usersById.get(t.user_id) : undefined}
              photoUrls={photoUrls}
            />
          ))}
        </div>
      )}
    </>
  );
}

function fullName(u: LovelyUser): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ');
}

function fmtDateTime(s: string | null): string {
  if (!s) return '—';
  return new Date(s).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function TicketCard({ t, user, photoUrls }: {
  t: LovelyTicket;
  user: LovelyUser | undefined;
  photoUrls: Record<string, string>;
}) {
  const name = user ? fullName(user) : '';
  const photoCount = t.photoPaths.length;
  return (
    <article className={styles.ticketCard}>
      <header className={styles.ticketHeader}>
        <div className={styles.ticketWho}>
          <strong>{name || user?.email || <span className={styles.muted}>Unknown user</span>}</strong>
          {name && user?.email && <span className={`${styles.mono} ${styles.muted}`}>{user.email}</span>}
        </div>
        <div className={styles.ticketMeta}>
          <span className={styles.mono}>{t.serial_number || '—'}</span>
          <span className={styles.badgeNeutral}>
            {photoCount} {photoCount === 1 ? 'photo' : 'photos'}
          </span>
          <span className={`${styles.mono} ${styles.muted}`}>{fmtDateTime(t.created_at)}</span>
        </div>
      </header>
      <p className={styles.ticketNotes}>
        {t.notes?.trim() || <span className={styles.muted}>No notes provided.</span>}
      </p>
      {photoCount > 0 && (
        <div className={styles.ticketPhotos}>
          {t.photoPaths.map((p, i) => {
            const url = photoUrls[p];
            return url ? (
              <a key={p} href={url} target="_blank" rel="noreferrer" className={styles.ticketPhoto}>
                <img src={url} alt={`Photo ${i + 1} for ${t.serial_number ?? 'ticket'}`} loading="lazy" />
              </a>
            ) : (
              <div key={p} className={`${styles.ticketPhoto} ${styles.ticketPhotoPending}`} />
            );
          })}
        </div>
      )}
    </article>
  );
}
