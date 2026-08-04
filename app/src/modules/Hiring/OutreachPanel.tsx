import { useEffect, useState } from 'react';
import styles from './Hiring.module.css';
import { useShortlistedCandidates, markScreeningInviteSent, type ShortlistedCandidate } from '../../lib/hiring';
import { useEmailTemplate, useSchedulingUrl } from '../../lib/templates';
import { openMailDraft } from '../../lib/mailDraft';
import { SCREENING_TEMPLATE_KEY, candidateEmail, renderScreeningInvite } from './screeningInvite';

/** Screening outreach — the "who have I actually emailed?" board.
 *
 *  The invite leaves from the operator's own Outlook, so makeLILA never learns
 *  whether it went out. This panel is where that gets recorded: every
 *  shortlisted candidate across every visible posting, with a sent/not-sent
 *  state the operator drives, plus a one-click draft for the ones still
 *  waiting. Sending from here marks the row; the marker can also be set or
 *  cleared by hand for invites that went out another way. */
export function OutreachPanel() {
  const { candidates, loading } = useShortlistedCandidates();
  const { template } = useEmailTemplate(SCREENING_TEMPLATE_KEY);
  const { schedulingUrl, loading: linkLoading, save } = useSchedulingUrl();

  // useShortlistedCandidates has a realtime subscription, but a refetch round
  // trip is slow enough to read as an unresponsive button. Local overrides
  // reflect this panel's own writes immediately; the refetch then agrees.
  const [sentOverrides, setSentOverrides] = useState<Record<string, string | null>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = candidates.map(c =>
    c.id in sentOverrides ? { ...c, screening_invite_sent_at: sentOverrides[c.id] } : c
  );
  const emailed = rows.filter(c => c.screening_invite_sent_at);
  const awaiting = rows.filter(c => !c.screening_invite_sent_at);
  const pct = rows.length ? Math.round((emailed.length / rows.length) * 100) : 0;

  async function setSent(candidate: ShortlistedCandidate, sent: boolean) {
    setPendingId(candidate.id);
    setError(null);
    try {
      await markScreeningInviteSent(candidate.id, sent);
      setSentOverrides(prev => ({ ...prev, [candidate.id]: sent ? new Date().toISOString() : null }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not update the outreach status');
    } finally {
      setPendingId(null);
    }
  }

  async function draft(candidate: ShortlistedCandidate) {
    const to = candidateEmail(candidate);
    if (!template || !to) return;
    const invite = renderScreeningInvite(template, {
      candidateName: candidate.full_name,
      postingTitle: candidate.posting_title,
      schedulingUrl,
    });
    openMailDraft({ to, ...invite });
    await setSent(candidate, true);
  }

  return (
    <div className={styles.outreachPanel}>
      <div className={styles.outreachHeader}>
        <div className={styles.outreachTitle}>Screening outreach</div>
        <SchedulingLinkForm savedUrl={schedulingUrl} loading={linkLoading} onSave={save} />
      </div>

      <div className={styles.statRow}>
        <div className={styles.stat}>
          <div className={styles.statValue}>{rows.length}</div>
          <div className={styles.statLabel}>Shortlisted</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statValue}>{emailed.length}</div>
          <div className={styles.statLabel}>Emailed</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statValue}>{awaiting.length}</div>
          <div className={styles.statLabel}>Awaiting email</div>
        </div>
        <div className={styles.progressWrap}>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${pct}%` }} />
          </div>
          <div className={styles.statLabel}>{pct}% contacted</div>
        </div>
      </div>

      {error && <div className={styles.formError}>{error}</div>}
      {loading && <div className={styles.inviteHint}>Loading shortlist…</div>}
      {!loading && !rows.length && (
        <div className={styles.inviteHint}>
          No shortlisted candidates yet — shortlist someone on the Applicants board and they show up here.
        </div>
      )}

      {!!rows.length && (
        <table className={styles.outreachTable}>
          <thead>
            <tr>
              <th>Candidate</th><th>Role</th><th>Email</th><th>Invite</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map(c => {
              const to = candidateEmail(c);
              const sentAt = c.screening_invite_sent_at;
              return (
                <tr key={c.id}>
                  <td>{c.full_name}</td>
                  <td className={styles.outreachMuted}>{c.posting_title}</td>
                  <td className={styles.outreachMuted}>{to ?? 'No email on file'}</td>
                  <td>
                    {sentAt
                      ? <span className={styles.sentChip}>Emailed {formatSentDate(sentAt)}</span>
                      : <span className={styles.unsentChip}>Not emailed</span>}
                  </td>
                  <td className={styles.outreachActions}>
                    <button
                      onClick={() => draft(c)}
                      disabled={!to || !template || pendingId === c.id}
                      title={to ? undefined : 'No email address on file for this candidate'}
                    >
                      {sentAt ? 'Send again' : 'Send email'}
                    </button>
                    <button
                      className={styles.linkButton}
                      onClick={() => setSent(c, !sentAt)}
                      disabled={pendingId === c.id}
                    >
                      {sentAt ? 'Mark not emailed' : 'Mark emailed'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Save-once booking link. Every invite the operator drafts from here on
 *  resolves {{scheduling_url}} to it, instead of leaving a paste-it-yourself
 *  marker in the copy. Per-operator: each interviewer books their own calendar. */
function SchedulingLinkForm({ savedUrl, loading, onSave }: {
  savedUrl: string | null; loading: boolean; onSave: (url: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the input once the profile arrives. Keyed on the fetched value so a
  // save (which updates savedUrl) doesn't fight the operator's typing.
  useEffect(() => { setValue(savedUrl ?? ''); }, [savedUrl]);

  async function submit() {
    setSaving(true); setError(null); setSaved(false);
    try {
      await onSave(value);
      setSaved(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not save the scheduling link');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.linkForm}>
      <label className={styles.linkLabel} htmlFor="scheduling-url">Your scheduling link</label>
      <input
        id="scheduling-url"
        className={styles.linkInput}
        placeholder="https://calendly.com/you/screening"
        value={value}
        onChange={e => { setValue(e.target.value); setSaved(false); }}
        disabled={loading}
      />
      <button onClick={submit} disabled={saving || loading}>Save</button>
      {saved && <span className={styles.inviteHint}>Saved — it fills every invite you draft</span>}
      {error && <span className={styles.formError}>{error}</span>}
    </div>
  );
}

function formatSentDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
