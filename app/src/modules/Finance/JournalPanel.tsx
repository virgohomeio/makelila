import { useState } from 'react';
import { useQboJournals, repostJournal, useQboOAuthStatus, isTokenExpiringSoon } from '../../lib/finance';
import { useAuth } from '../../lib/auth';
import { canDo } from '../../lib/permissions';
import styles from './Finance.module.css';

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return toDateString(d);
}

function defaultTo(): string {
  return toDateString(new Date());
}

function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

function fmtAmt(n: number): string {
  return n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function JournalPanel() {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [currencyFilter, setCurrencyFilter] = useState<'All' | 'CAD' | 'USD'>('All');
  const [channelFilter, setChannelFilter] = useState<string>('All');
  const [reposting, setReposting] = useState<string | null>(null);
  const [repostError, setRepostError] = useState<string | null>(null);

  const { journals, loading, error } = useQboJournals(from, to);
  const { refreshExpiresAt } = useQboOAuthStatus();
  const { role } = useAuth();

  const canRepost = canDo(role, 'repost_journal');

  // Derive unique channel list from loaded data
  const channels = ['All', ...Array.from(new Set(journals.map(j => j.payment_channel))).sort()];

  const filtered = journals.filter(j => {
    if (currencyFilter !== 'All' && j.currency !== currencyFilter) return false;
    if (channelFilter !== 'All' && j.payment_channel !== channelFilter) return false;
    return true;
  });

  // QBO token warning: show if refreshExpiresAt is within 14 days of today
  const tokenWarning = isTokenExpiringSoon(refreshExpiresAt)
    ? `QBO refresh token expires on ${fmtDate(refreshExpiresAt!)}. Re-authenticate via the Finance settings to avoid disruption.`
    : null;

  async function handleRepost(id: string) {
    setReposting(id);
    setRepostError(null);
    try {
      await repostJournal(id);
    } catch (e: unknown) {
      setRepostError(e instanceof Error ? e.message : 'Repost failed');
    } finally {
      setReposting(null);
    }
  }

  return (
    <div>
      {tokenWarning && (
        <div className={styles.tokenWarning}>{tokenWarning}</div>
      )}

      {/* Date range + filter controls */}
      <div className={styles.filterRow}>
        <label className={styles.fieldLabel}>From</label>
        <input
          type="date"
          className={styles.input}
          value={from}
          max={to}
          onChange={e => setFrom(e.target.value)}
        />
        <label className={styles.fieldLabel}>To</label>
        <input
          type="date"
          className={styles.input}
          value={to}
          min={from}
          onChange={e => setTo(e.target.value)}
        />
      </div>

      {/* Currency chips */}
      <div className={styles.filterRow}>
        {(['All', 'CAD', 'USD'] as const).map(c => (
          <button
            key={c}
            className={`${styles.chip} ${currencyFilter === c ? styles.chipActive : ''}`}
            onClick={() => setCurrencyFilter(c)}
          >{c}</button>
        ))}
        <span className={styles.sectionLabel}>Channel:</span>
        {channels.map(ch => (
          <button
            key={ch}
            className={`${styles.chip} ${channelFilter === ch ? styles.chipActive : ''}`}
            onClick={() => setChannelFilter(ch)}
          >{ch}</button>
        ))}
      </div>

      {repostError && (
        <div className={styles.repostError}>
          {repostError}
        </div>
      )}

      {loading && <div className={styles.loading}>Loading journals…</div>}
      {!loading && error && <div className={styles.empty}>Error: {error}</div>}
      {!loading && !error && filtered.length === 0 && (
        <div className={styles.empty}>No journals found for the selected range and filters.</div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Currency</th>
                <th>Channel</th>
                <th>Gross</th>
                <th>Discounts</th>
                <th>Refunds</th>
                <th>Tax</th>
                <th>Shipping</th>
                <th>Fees</th>
                <th>Net Deposit</th>
                <th>Status</th>
                <th>QBO</th>
                {canRepost && <th>Action</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map(j => {
                let statusClass = styles.statusPending;
                let statusLabel = 'Pending';
                if (j.posted_at) { statusClass = styles.statusPosted; statusLabel = 'Posted'; }
                else if (j.error) { statusClass = styles.statusError; statusLabel = 'Error'; }

                return (
                  <tr key={j.id} className={styles.row}>
                    <td>{fmtDate(j.date)}</td>
                    <td>{j.currency}</td>
                    <td>{j.payment_channel}</td>
                    <td>{fmtAmt(j.gross_sales)}</td>
                    <td className={j.discounts > 0 ? styles.amountNeg : undefined}>{fmtAmt(j.discounts)}</td>
                    <td className={j.refunds > 0 ? styles.amountNeg : undefined}>{fmtAmt(j.refunds)}</td>
                    <td>{fmtAmt(j.tax_collected)}</td>
                    <td>{fmtAmt(j.shipping)}</td>
                    <td className={j.fees > 0 ? styles.amountNeg : undefined}>{fmtAmt(j.fees)}</td>
                    <td className={`${styles.netDeposit} ${j.net_deposit >= 0 ? styles.amountPos : styles.amountNeg}`}>
                      {fmtAmt(j.net_deposit)}
                    </td>
                    <td>
                      <span className={`${styles.statusChip} ${statusClass}`}>{statusLabel}</span>
                      {j.error && (
                        <span className={styles.errorDetail} title={j.error}>
                          {j.error.slice(0, 40)}{j.error.length > 40 ? '…' : ''}
                        </span>
                      )}
                    </td>
                    <td>
                      {j.qbo_journal_id ? (
                        <a
                          href={`https://app.qbo.intuit.com/app/journal?txnId=${j.qbo_journal_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={styles.qboLink}
                        >
                          View in QBO
                        </a>
                      ) : (
                        <span className={styles.dash}>—</span>
                      )}
                    </td>
                    {canRepost && (
                      <td>
                        <button
                          className={styles.btnSecondary}
                          disabled={reposting === j.id}
                          onClick={() => handleRepost(j.id)}
                        >
                          {reposting === j.id ? 'Reposting…' : 'Repost'}
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
