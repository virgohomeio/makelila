import { useRef, useState } from 'react';
import styles from './Hiring.module.css';
import { useShortlistedCandidates, markScreeningInviteSent, type ShortlistedCandidate } from '../../lib/hiring';
import { useEmailTemplate, useSchedulingUrl } from '../../lib/templates';
import { SCREENING_TEMPLATE_KEY, candidateEmail, renderScreeningInvite } from './screeningInvite';

/** Screening outreach — the "who have I actually emailed?" board.
 *
 *  makeLILA hands over text and nothing else: the invite is copied from here
 *  and sent by the operator from whatever mail client they already have open,
 *  so nothing downstream can tell us whether it went out. This panel is where
 *  that gets recorded — every shortlisted candidate across every visible
 *  posting, with a sent/not-sent state the operator drives, and a copy button
 *  for the ones still waiting. */
export function OutreachPanel() {
  const { candidates, loading } = useShortlistedCandidates();
  const { template } = useEmailTemplate(SCREENING_TEMPLATE_KEY);
  const { schedulingUrl, loading: linkLoading, save } = useSchedulingUrl();

  // useShortlistedCandidates has a realtime subscription, but a refetch round
  // trip is slow enough to read as an unresponsive button. Local overrides
  // reflect this panel's own writes immediately; the refetch then agrees.
  const [sentOverrides, setSentOverrides] = useState<Record<string, string | null>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [copied, setCopied] = useState<{ id: string; what: 'email' | 'address' } | null>(null);
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

  /** Puts this candidate's invite on the clipboard, ready to paste into
   *  whatever mail client the operator already has open. The message only —
   *  the address goes in a different field of the compose window and has its
   *  own button.
   *
   *  Copying deliberately does NOT mark the candidate emailed: the mail hasn't
   *  been sent yet, and a row that claims otherwise is how someone ends up
   *  never contacted. */
  async function copyInvite(candidate: ShortlistedCandidate) {
    if (!template) return;
    const invite = renderScreeningInvite(template, {
      candidateName: candidate.full_name,
      postingTitle: candidate.posting_title,
      schedulingUrl,
    });
    await navigator.clipboard.writeText(`Subject: ${invite.subject}\n\n${invite.body}`);
    setCopied({ id: candidate.id, what: 'email' });
  }

  /** The address alone, for pasting into a compose window's To: field. */
  async function copyAddress(candidate: ShortlistedCandidate) {
    const to = candidateEmail(candidate);
    if (!to) return;
    await navigator.clipboard.writeText(to);
    setCopied({ id: candidate.id, what: 'address' });
  }

  return (
    <div className={styles.outreachPanel}>
      <div className={styles.outreachHeader}>
        <div>
          <div className={styles.outreachTitle}>Screening outreach</div>
          <div className={styles.sendingAs}>Copy an invite, then send it from your own mail client.</div>
        </div>
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
                    {copied?.id === c.id && (
                      <span className={styles.outreachMuted}>
                        {copied.what === 'address' ? 'Address copied' : 'Email copied'}
                      </span>
                    )}
                    <button
                      onClick={() => copyInvite(c)}
                      disabled={!template}
                      title={
                        template
                          ? 'Copies the invite — paste it into your mail client'
                          : 'Screening template not found in the template library'
                      }
                    >
                      Copy email
                    </button>
                    <button
                      onClick={() => copyAddress(c)}
                      disabled={!to}
                      title={to ? 'Copies just the address, for the To: field' : 'No email address on file for this candidate'}
                    >
                      Copy address
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
  const inputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSaving(true); setError(null); setSaved(false);
    try {
      await onSave(inputRef.current?.value ?? '');
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
      {/* Uncontrolled: the saved link arrives from an async profile fetch, and
          keying the input on it re-seeds the field when it lands (and after a
          save) without a state-sync effect. The key is on the input rather
          than the component so the "Saved" confirmation below survives. */}
      <input
        key={savedUrl ?? ''}
        id="scheduling-url"
        ref={inputRef}
        className={styles.linkInput}
        placeholder="https://calendly.com/you/screening"
        defaultValue={savedUrl ?? ''}
        onChange={() => setSaved(false)}
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
