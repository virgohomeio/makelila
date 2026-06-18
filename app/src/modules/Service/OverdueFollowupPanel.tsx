import { useState } from 'react';
import {
  generateFollowupDrafts, sendFollowupSms,
  type FollowupDraft,
} from '../../lib/customers';
import {
  CANNED_SMS_TEMPLATES, CANNED_SMS_OPTIONS, type CannedSmsKey,
} from '../../lib/cannedSms';
import styles from './FollowUps.module.css';

type Props = {
  overdueCount: number;
  overdueCustomerIds: string[];   // sorted: most-overdue first
};

const BATCH_OPTIONS = [5, 10, 20, 50] as const;
type BatchSize = (typeof BATCH_OPTIONS)[number];

type DraftRowState =
  | { status: 'pending';  draft: FollowupDraft; editedMessage: string }
  | { status: 'sending';  draft: FollowupDraft }
  | { status: 'sent';     draft: FollowupDraft; testRedirected: boolean }
  | { status: 'skipped';  draft: FollowupDraft }
  | { status: 'error';    draft: FollowupDraft; error: string; editedMessage: string };

export function OverdueFollowupPanel({ overdueCount, overdueCustomerIds }: Props) {
  const [batchSize, setBatchSize] = useState<BatchSize>(10);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [rows, setRows] = useState<Map<string, DraftRowState>>(new Map());

  if (overdueCount === 0) return null;

  async function handleGenerate() {
    // Guard: regenerating wholesale-replaces the queue. If Reina has
    // pending edits or unsent errors in-flight, confirm before nuking them.
    // Skipped + sent rows are dispositionally done; don't count toward
    // the prompt.
    const inProgress = Array.from(rows.values()).filter(
      r => r.status === 'pending' || r.status === 'error',
    ).length;
    if (inProgress > 0) {
      const ok = window.confirm(
        `You have ${inProgress} draft${inProgress === 1 ? '' : 's'} in progress. ` +
        `Regenerating will replace ${inProgress === 1 ? 'it' : 'them'}. Continue?`,
      );
      if (!ok) return;
    }

    setGenerating(true);
    setGenerateError(null);
    try {
      const ids = overdueCustomerIds.slice(0, batchSize);
      const { drafts } = await generateFollowupDrafts(ids);
      const next = new Map<string, DraftRowState>();
      for (const d of drafts) {
        if (d.skip_reason) {
          next.set(d.customer_id, { status: 'skipped', draft: d });
        } else {
          next.set(d.customer_id, {
            status: 'pending',
            draft: d,
            editedMessage: d.draft_message ?? '',
          });
        }
      }
      setRows(next);
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : 'Failed to generate drafts');
    } finally {
      setGenerating(false);
    }
  }

  function updateRow(id: string, next: DraftRowState) {
    setRows(prev => {
      const m = new Map(prev);
      m.set(id, next);
      return m;
    });
  }

  async function handleApprove(state: Extract<DraftRowState, { status: 'pending' | 'error' }>) {
    const id = state.draft.customer_id;
    updateRow(id, { status: 'sending', draft: state.draft });
    try {
      const r = await sendFollowupSms({
        customer_id: id,
        message: state.editedMessage,
      });
      updateRow(id, {
        status: 'sent',
        draft: state.draft,
        testRedirected: !!r.test_redirected,
      });
    } catch (e) {
      updateRow(id, {
        status: 'error',
        draft: state.draft,
        error: e instanceof Error ? e.message : 'Send failed',
        editedMessage: state.editedMessage,
      });
    }
  }

  function handleSkip(id: string) {
    const cur = rows.get(id);
    if (!cur || cur.status === 'sent') return;
    updateRow(id, { status: 'skipped', draft: cur.draft });
  }

  return (
    <div className={styles.followupPanel}>
      <div className={styles.followupHeader}>
        <strong>{overdueCount} customers overdue for follow-up</strong>
        <select
          value={batchSize}
          onChange={e => setBatchSize(Number(e.target.value) as BatchSize)}
          disabled={generating}
        >
          {BATCH_OPTIONS.map(n => (
            <option key={n} value={n}>Generate drafts for first {n}</option>
          ))}
        </select>
        <button onClick={() => void handleGenerate()} disabled={generating}>
          {generating ? 'Drafting…' : 'Generate'}
        </button>
        <span className={styles.followupHint}>
          Auto-skip: no phone · active return/refund · messaged &lt;7d
        </span>
      </div>
      {generateError && (
        <div className={styles.followupError}>Generate failed: {generateError}</div>
      )}
      {rows.size > 0 && (
        <div className={styles.followupList}>
          {Array.from(rows.values()).map(r => (
            <DraftCard
              key={r.draft.customer_id}
              state={r}
              onApprove={() => {
                if (r.status === 'pending' || r.status === 'error') void handleApprove(r);
              }}
              onSkip={() => handleSkip(r.draft.customer_id)}
              onEdit={text => {
                if (r.status === 'pending' || r.status === 'error') {
                  updateRow(r.draft.customer_id, { ...r, editedMessage: text });
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DraftCard({
  state, onApprove, onSkip, onEdit,
}: {
  state: DraftRowState;
  onApprove: () => void;
  onSkip: () => void;
  onEdit: (text: string) => void;
}) {
  function insertCanned(key: CannedSmsKey, firstName: string) {
    onEdit(CANNED_SMS_TEMPLATES[key].body(firstName));
  }
  const d = state.draft;
  const header = `${d.customer_name} · ${d.fu_kind.toUpperCase()} · ${d.days_overdue}d overdue`;
  if (state.status === 'sent') {
    return (
      <div className={styles.draftCard}>
        <div className={styles.draftHeader}>{header}</div>
        <div className={styles.draftSent}>
          ✓ Sent to {d.customer_name}{state.testRedirected ? ' (TEST redirect)' : ''}
        </div>
      </div>
    );
  }
  if (state.status === 'skipped') {
    return (
      <div className={styles.draftCard}>
        <div className={styles.draftHeader}>{header}</div>
        <div className={styles.draftSkipped}>
          — Skipped{d.skip_reason ? ` · ${d.skip_reason}` : ''}
        </div>
      </div>
    );
  }
  if (state.status === 'sending') {
    return (
      <div className={styles.draftCard}>
        <div className={styles.draftHeader}>{header}</div>
        <div className={styles.draftSending}>Sending…</div>
      </div>
    );
  }
  // pending or error
  const editedMessage = state.editedMessage;
  return (
    <div className={styles.draftCard}>
      <div className={styles.draftHeader}>{header}</div>
      {d.context_summary && (
        <div className={styles.draftContext}>Context: {d.context_summary}</div>
      )}
      <textarea
        className={styles.draftTextarea}
        value={editedMessage}
        onChange={e => onEdit(e.target.value)}
        rows={3}
      />
      {state.status === 'error' && (
        <div className={styles.followupError}>{state.error}</div>
      )}
      <div className={styles.draftActions}>
        <button className={styles.draftPrimary} onClick={onApprove} disabled={!editedMessage.trim()}>
          ✓ Approve &amp; send
        </button>
        <button onClick={onSkip}>Skip</button>
        <select
          className={styles.draftCannedPicker}
          value=""
          onChange={e => {
            const key = e.target.value as CannedSmsKey;
            if (key) {
              const firstName = d.customer_name.split(/\s+/)[0] || 'there';
              insertCanned(key, firstName);
            }
          }}
          title="Replace draft with a canned template"
        >
          <option value="">Insert canned…</option>
          {CANNED_SMS_OPTIONS.map(opt => (
            <option key={opt.key} value={opt.key} title={opt.description}>{opt.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
