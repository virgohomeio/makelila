import { useEffect, useMemo, useState } from 'react';
import { useCustomers, sendNameCollectionRequest, setJourneyStageOverride, type Customer } from '../../lib/customers';
import { useOrders, type Order } from '../../lib/orders';
import { useServiceTickets, useCustomerLifecycle, type ServiceTicket, type CustomerLifecycle } from '../../lib/service';
import { useReturns, type ReturnRow } from '../../lib/postShipment';
import { useUnits, type Unit } from '../../lib/stock';
import { useCustomerEngagementMap, dormancyBadge } from '../../lib/customerEvents';
import styles from './Customers.module.css';

// ─── CJM stages, mirrors CJM/makeLILA_CJM_v2.html (10 stages) ─────────────────
// The descriptions + emojis are pulled verbatim from the CJM doc so the
// visualization stays anchored to the canonical source.

type StageKey =
  | 'awareness' | 'consideration' | 'conversion' | 'shipping' | 'unboxing'
  | 'setup' | 'routine' | 'failure' | 'eol' | 'promotion';

type StageDef = {
  key: StageKey;
  label: string;
  description: string;
  emoji: string;          // CJM "Customer Feeling" emoji at this stage
  emotionLabel: string;   // CJM verbatim emotion text
  color: string;
};

const STAGES: readonly StageDef[] = [
  { key: 'awareness',    label: 'Awareness',           description: 'Why do they start the journey?',     emoji: '😬', emotionLabel: 'Skeptical — ugly? too expensive? really compost?', color: '#a0aec0' },
  { key: 'consideration',label: 'Consideration',        description: 'Why should they care about LILA?',   emoji: '🤔', emotionLabel: 'Cautiously interested but lots of doubts',           color: '#d69e2e' },
  { key: 'conversion',   label: 'Conversion',           description: 'Why would they trust us?',           emoji: '😊', emotionLabel: 'Committed but anxious about the price',              color: '#2b6cb0' },
  { key: 'shipping',     label: 'Shipping',             description: 'Comfortable while waiting?',         emoji: '😶', emotionLabel: 'Anticipating — reassured by onboarding outreach',    color: '#3182ce' },
  { key: 'unboxing',     label: 'Unboxing',             description: 'First impression?',                  emoji: '😍', emotionLabel: 'Excited — first impression (packaging waste concern)', color: '#805ad5' },
  { key: 'setup',        label: 'Setup',                description: 'How do they start using LILA?',      emoji: '😌', emotionLabel: 'Guided onboarding helps — tech barriers for some',  color: '#6b46c1' },
  { key: 'routine',      label: 'Routine Use',          description: 'How can they feel successful?',      emoji: '🌱', emotionLabel: 'Satisfied — seeing real compost output',             color: '#276749' },
  { key: 'failure',      label: 'Failure & Support',    description: 'How can they navigate failures?',    emoji: '😡', emotionLabel: 'Frustrated — speed of fix = will I recommend?',     color: '#c53030' },
  { key: 'eol',          label: 'End of Life',          description: 'Feel good with end of life?',        emoji: '😔', emotionLabel: 'Reluctant — don\'t want to start over',              color: '#a0522d' },
  { key: 'promotion',    label: 'Promotion',            description: 'Why recommend to others?',           emoji: '🥰', emotionLabel: 'Proud advocate — "tech expert" to friends',         color: '#38a169' },
];

const STAGE_INDEX: Record<StageKey, number> = STAGES.reduce(
  (acc, s, i) => { acc[s.key] = i; return acc; },
  {} as Record<StageKey, number>,
);

// ─── Per-customer journey snapshot ────────────────────────────────────────────

type Satisfaction = 0 | 1 | 2 | 3 | 4 | 5;   // 0=abandoned, 5=delighted

type StageScore = {
  key: StageKey;
  reached: boolean;          // has the customer arrived at this stage yet?
  satisfaction: Satisfaction | null;  // null when not reached
  signals: string[];          // human-readable reasons feeding the score
};

type Journey = {
  customer: Customer;
  currentStage: StageKey;
  // true when currentStage came from journey_stage_override (operator-set);
  // false when it was inferred from data signals.
  isManualStage: boolean;
  overallSatisfaction: Satisfaction;
  stages: StageScore[];
  signals: {
    orders: Order[];
    lifecycle: CustomerLifecycle[];
    tickets: ServiceTicket[];
    returns: ReturnRow[];
  };
};

const STAGE_KEYS = new Set<StageKey>(STAGES.map(s => s.key));

const SATISFACTION_EMOJI: Record<Satisfaction, string> = {
  0: '😞', 1: '😟', 2: '😕', 3: '😐', 4: '🙂', 5: '🤩',
};
const SATISFACTION_COLOR: Record<Satisfaction, string> = {
  0: '#742a2a', 1: '#c53030', 2: '#dd6b20', 3: '#a0aec0', 4: '#38a169', 5: '#276749',
};
const SATISFACTION_LABEL: Record<Satisfaction, string> = {
  0: 'abandoned', 1: 'frustrated', 2: 'concerned', 3: 'neutral', 4: 'satisfied', 5: 'delighted',
};

// Fuzzy customer-name match: same first + last token (case-insensitive).
// Catches "Annie Wu" ↔ "Annie Chunli Wu", "Amila & Rob Smith" ↔ "Amila Smith",
// "Audrey St John" ↔ "Audrey BALANAY-ST JOHN", etc. Not perfect, but
// significantly reduces the false-classification rate per operator
// feedback (2026-06-05).
function namesLooseMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const A = a.toLowerCase().trim();
  const B = b.toLowerCase().trim();
  if (A === B) return true;
  const ta = A.split(/[\s&-]+/).filter(Boolean);
  const tb = B.split(/[\s&-]+/).filter(Boolean);
  if (ta.length === 0 || tb.length === 0) return false;
  return ta[0] === tb[0] && ta[ta.length - 1] === tb[tb.length - 1];
}

function inferJourney(
  c: Customer,
  allOrders: Order[],
  allLifecycle: CustomerLifecycle[],
  allTickets: ServiceTicket[],
  allReturns: ReturnRow[],
  allUnits: Unit[],
): Journey {
  const lcEmail = c.email?.toLowerCase() ?? '';
  const lcName  = c.full_name.toLowerCase();

  const orders    = allOrders.filter(o =>
    (o.customer_email?.toLowerCase() === lcEmail && lcEmail !== '')
    || o.customer_name?.toLowerCase() === lcName
  );
  const lifecycle = allLifecycle.filter(l => l.customer_id === c.id);
  const tickets   = allTickets.filter(t =>
    (t.customer_email?.toLowerCase() === lcEmail && lcEmail !== '')
    || t.customer_id === c.id
  );
  const returns   = allReturns.filter(r =>
    (r.customer_email?.toLowerCase() === lcEmail && lcEmail !== '')
    || r.customer_name?.toLowerCase() === lcName
  );
  // Units linked by exact OR fuzzy name match (handles spouse-joined +
  // middle-name + alt-capitalization variants seen in the fulfillment
  // sheet).
  const matchingUnits = allUnits.filter(u =>
    u.customer_name != null && namesLooseMatch(u.customer_name, c.full_name)
  );

  const saleOrders   = orders.filter(o => o.kind === 'sale');
  const replOrders   = orders.filter(o => o.kind === 'replacement');
  const hasSale      = saleOrders.length > 0;
  const hasReplacement = replOrders.length > 0;
  const hasShipped   = lifecycle.some(l => l.shipped_at != null);
  const hasDelivered = saleOrders.some(o => o.delivered_at != null);
  const hasOnboardingScheduled = lifecycle.some(l => l.onboarding_status === 'scheduled');
  const hasOnboardingCompleted = lifecycle.some(l => l.onboarding_status === 'completed');
  // Per operator (2026-06-05): a customer who's received their unit
  // should never read as "consideration." Combine every available
  // signal — the previous rule (onboard_date only) missed customers
  // whose only signal was a synced serial, a units-table match, an
  // operator follow-up, or a replacement-order history.
  const hasReceivedUnit =
    !!c.onboard_date
    || hasOnboardingCompleted
    || (c.serials != null && c.serials.length > 0)
    || matchingUnits.length > 0
    || c.fu1_status != null
    || c.fu2_status != null
    || hasReplacement;   // can't get a replacement without an original
  // Per operator (2026-06-05): for an onboarded customer, ANY open
  // ticket (not just warranty/defect) puts them in Failure & Support
  // — represents active operator touch, regardless of the topic.
  // Junaid (2026-06-05): "resolved" stays counted as still-open until
  // the operator explicitly marks 'closed' — keeps recently-resolved
  // tickets visible in the failure category.
  const openTickets = tickets.filter(t => t.status !== 'closed');
  const hasActiveReturn = returns.some(r =>
    r.status !== 'closed' && r.status !== 'denied' && r.status !== 'refunded'
  );
  const fu2Reviewed = c.fu2_status === 'reviewed';

  // Walk backward through the stage order. First match wins as "current".
  let inferredStage: StageKey = 'awareness';
  if (fu2Reviewed)                              inferredStage = 'promotion';
  else if (hasActiveReturn)                     inferredStage = 'eol';
  else if (hasReceivedUnit && openTickets.length > 0) inferredStage = 'failure';
  else if (hasReceivedUnit)                     inferredStage = 'routine';
  else if (hasOnboardingScheduled)              inferredStage = 'setup';
  else if (hasDelivered)                        inferredStage = 'unboxing';
  else if (hasShipped)                          inferredStage = 'shipping';
  else if (hasSale)                             inferredStage = 'conversion';
  else if (c.email || c.phone)                  inferredStage = 'consideration';

  // Operator override wins when set + valid.
  const isManualStage = c.journey_stage_override != null
    && STAGE_KEYS.has(c.journey_stage_override as StageKey);
  const currentStage: StageKey = isManualStage
    ? (c.journey_stage_override as StageKey)
    : inferredStage;
  const currentIdx = STAGE_INDEX[currentStage];

  // ─── Score each reached stage ─────────────────────────────────────────────
  const stages: StageScore[] = STAGES.map(stage => {
    const reached = STAGE_INDEX[stage.key] <= currentIdx;
    if (!reached) return { key: stage.key, reached, satisfaction: null, signals: [] };

    const sig: string[] = [];
    let score: Satisfaction = 3;   // start at neutral

    switch (stage.key) {
      case 'awareness':
      case 'consideration':
        // We don't have pre-purchase signals; default neutral
        sig.push('No upstream marketing signals tracked yet.');
        break;
      case 'conversion':
        score = 4;
        sig.push(`Placed ${saleOrders.length} sale order${saleOrders.length === 1 ? '' : 's'}.`);
        break;
      case 'shipping':
        score = 4;
        if (hasDelivered) {
          sig.push('Delivered without issue.');
        } else if (hasShipped) {
          sig.push('In transit.');
        }
        break;
      case 'unboxing': {
        // Negative signal: very early ticket (within first 7d of delivery)
        const earlyTicket = tickets.find(t => {
          const delivered = saleOrders.find(o => o.delivered_at)?.delivered_at;
          if (!delivered) return false;
          const dt = new Date(delivered).getTime();
          const created = new Date(t.created_at).getTime();
          return created - dt < 7 * 86400_000 && created > dt;
        });
        if (earlyTicket) {
          score = 2;
          sig.push('Opened a ticket within 7 days of delivery — likely unboxing issue.');
        } else {
          score = 4;
          sig.push('No immediate post-delivery complaints.');
        }
        break;
      }
      case 'setup':
        if (hasOnboardingCompleted) {
          score = 4;
          sig.push('Onboarding call completed.');
        } else if (hasOnboardingScheduled) {
          score = 3;
          sig.push('Onboarding call scheduled but not yet completed.');
        } else {
          score = 2;
          sig.push('No onboarding call on the calendar.');
        }
        break;
      case 'routine': {
        score = 4;  // routine = "they're using it without issue"
        if (c.onboard_date) {
          sig.push(`Onboarded on ${c.onboard_date}.`);
        }
        if (c.fu1_status) {
          sig.push(`FU1 logged as ${c.fu1_status}.`);
        }
        if (c.fu2_status) {
          sig.push(`FU2 logged as ${c.fu2_status}.`);
        }
        if (c.serials && c.serials.length > 0) {
          sig.push(`Serial${c.serials.length === 1 ? '' : 's'}: ${c.serials.join(', ')}.`);
        } else if (matchingUnits.length > 0) {
          sig.push(`Unit on file: ${matchingUnits.map(u => u.serial).join(', ')}.`);
        }
        if (hasReplacement) {
          sig.push(`${replOrders.length} replacement order${replOrders.length === 1 ? '' : 's'} on file (has the original).`);
        }
        if (openTickets.length === 0) {
          sig.push('No open tickets.');
        }
        break;
      }
      case 'failure':
        // Open tickets put them here regardless of topic. Count drives severity.
        if (openTickets.length >= 2) {
          score = 1;
          sig.push(`${openTickets.length} open tickets.`);
        } else if (openTickets.length === 1) {
          score = 2;
          sig.push('1 open ticket.');
        } else {
          score = 3;
          sig.push('Tickets resolved.');
        }
        break;
      case 'eol': {
        // Use return.experience_rating if customer filled the return form
        const returnWithRating = returns.find(r => r.experience_rating != null);
        if (returnWithRating?.experience_rating != null) {
          const r = returnWithRating.experience_rating;
          score = (Math.max(0, Math.min(5, r)) as Satisfaction);
          sig.push(`Return-form experience rating: ${r}/5.`);
        } else if (hasActiveReturn) {
          score = 1;
          sig.push('Active return in flight.');
        }
        break;
      }
      case 'promotion':
        score = 5;
        if (fu2Reviewed) sig.push('FU2 logged customer left a review.');
        break;
    }

    return { key: stage.key, reached, satisfaction: score, signals: sig };
  });

  // Overall = current stage's satisfaction (with sensible fallbacks).
  const currentStageScore = stages.find(s => s.key === currentStage)?.satisfaction ?? 3;
  const overallSatisfaction: Satisfaction = currentStageScore;

  return {
    customer: c,
    currentStage,
    isManualStage,
    overallSatisfaction,
    stages,
    signals: { orders, lifecycle, tickets, returns },
  };
}

// ─── UI ───────────────────────────────────────────────────────────────────────

type StageFilter = 'all' | StageKey;
type SatisfactionFilter = 'all' | 'unhappy' | 'happy';

// Per operator (2026-06-05): card order is green (happy) → red (unhappy)
// → neutral (3). Within each group, name-sort for stable presentation.
function satisfactionGroup(s: Satisfaction): 0 | 1 | 2 {
  if (s >= 4) return 0;   // green / happy first
  if (s <= 2) return 1;   // red / unhappy second
  return 2;                // neutral (3) last
}

export function JourneyTab() {
  const { customers, loading: lc, refresh: refreshCustomers } = useCustomers();
  const { all: orders } = useOrders();
  const { tickets } = useServiceTickets();
  const { rows: lifecycle } = useCustomerLifecycle();
  const { returns } = useReturns();
  const { units } = useUnits();
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState<StageFilter>('all');
  const [satFilter, setSatFilter] = useState<SatisfactionFilter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [sendingNames, setSendingNames] = useState(false);
  const [nameRequestResult, setNameRequestResult] = useState<{ sent: number; failed: number } | null>(null);

  // Per operator: skip customers with no name on file — the card can't
  // render meaningfully without a name. The name-request banner above
  // the funnel lists those customers and offers a one-click send.
  const namedCustomers = useMemo(
    () => customers.filter(c => c.full_name && c.full_name.trim() !== ''),
    [customers],
  );

  // Nameless customers with an email we can reach. Already-sent within
  // the last 30d are hidden from the actionable list so operators don't
  // re-spam — the count badge still tells the full story.
  const namelessWithEmail = useMemo(() => {
    const cutoff = Date.now() - 30 * 86400_000;
    return customers.filter(c => {
      if (c.full_name && c.full_name.trim() !== '') return false;
      if (!c.email || c.email.trim() === '') return false;
      if (c.name_request_sent_at) {
        const sentAt = new Date(c.name_request_sent_at).getTime();
        if (sentAt > cutoff) return false;
      }
      return true;
    });
  }, [customers]);

  const journeys = useMemo(() => {
    return namedCustomers.map(c => inferJourney(c, orders, lifecycle, tickets, returns, units));
  }, [namedCustomers, orders, lifecycle, tickets, returns, units]);

  const stageCounts = useMemo(() => {
    const m: Record<StageKey, number> = {} as Record<StageKey, number>;
    for (const s of STAGES) m[s.key] = 0;
    for (const j of journeys) m[j.currentStage]++;
    return m;
  }, [journeys]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return journeys.filter(j => {
      if (stageFilter !== 'all' && j.currentStage !== stageFilter) return false;
      if (satFilter === 'unhappy' && j.overallSatisfaction > 2) return false;
      if (satFilter === 'happy' && j.overallSatisfaction < 4) return false;
      if (q && !j.customer.full_name.toLowerCase().includes(q) &&
          !(j.customer.email ?? '').toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => {
      // Group: green → red → neutral (per operator request).
      const ga = satisfactionGroup(a.overallSatisfaction);
      const gb = satisfactionGroup(b.overallSatisfaction);
      if (ga !== gb) return ga - gb;
      // Within group: within green, most-delighted first; within red,
      // most-frustrated first; within neutral, name-sort.
      if (ga === 0 && a.overallSatisfaction !== b.overallSatisfaction) {
        return b.overallSatisfaction - a.overallSatisfaction;
      }
      if (ga === 1 && a.overallSatisfaction !== b.overallSatisfaction) {
        return a.overallSatisfaction - b.overallSatisfaction;
      }
      return a.customer.full_name.localeCompare(b.customer.full_name);
    });
  }, [journeys, search, stageFilter, satFilter]);

  // lilalovely engagement summary keyed by customer_id — drives the
  // dormancy badge on each JourneyCard. Batched single fetch; rendered
  // O(1) per card via .get().
  const filteredIds = useMemo(() => filtered.map(j => j.customer.id), [filtered]);
  const engagementMap = useCustomerEngagementMap(filteredIds);

  async function handleSendNameRequests() {
    if (namelessWithEmail.length === 0) return;
    const ok = window.confirm(
      `Send name-request email to ${namelessWithEmail.length} customer${namelessWithEmail.length === 1 ? '' : 's'}?`,
    );
    if (!ok) return;
    setSendingNames(true);
    setNameRequestResult(null);
    let sent = 0, failed = 0;
    for (const c of namelessWithEmail) {
      try {
        await sendNameCollectionRequest(c);
        sent++;
      } catch (e) {
        failed++;
        // eslint-disable-next-line no-console
        console.error('name-request failed for', c.email, e);
      }
    }
    setSendingNames(false);
    setNameRequestResult({ sent, failed });
  }

  if (lc) return <div className={styles.loading}>Loading journey…</div>;

  const open = openId ? journeys.find(j => j.customer.id === openId) ?? null : null;

  return (
    <div className={styles.journeyTab}>
      {namelessWithEmail.length > 0 && (
        <div className={styles.journeyNamelessBanner}>
          <div>
            <strong>{namelessWithEmail.length} customer{namelessWithEmail.length === 1 ? '' : 's'} with no name on file.</strong>
            <span className={styles.journeyNamelessHint}>
              {' '}Hidden from the cards below. Send them a short email asking for their name so they can be tracked.
            </span>
          </div>
          <button
            className={styles.journeyNamelessBtn}
            onClick={() => void handleSendNameRequests()}
            disabled={sendingNames}
          >
            {sendingNames ? 'Sending…' : `Send name request to ${namelessWithEmail.length}`}
          </button>
        </div>
      )}
      {nameRequestResult && (
        <div className={styles.journeyNamelessResult}>
          ✓ Sent {nameRequestResult.sent}{nameRequestResult.failed > 0 ? ` · ${nameRequestResult.failed} failed (see console)` : ''}
        </div>
      )}

      {/* Stage funnel — counts per stage, click to filter */}
      <div className={styles.journeyFunnel}>
        <button
          className={`${styles.journeyFunnelStage} ${stageFilter === 'all' ? styles.journeyFunnelActive : ''}`}
          onClick={() => setStageFilter('all')}
          style={{ borderColor: '#cbd5e0' }}
        >
          <div className={styles.journeyFunnelLabel}>All</div>
          <div className={styles.journeyFunnelCount}>{journeys.length}</div>
        </button>
        {STAGES.map(s => (
          <button
            key={s.key}
            className={`${styles.journeyFunnelStage} ${stageFilter === s.key ? styles.journeyFunnelActive : ''}`}
            onClick={() => setStageFilter(stageFilter === s.key ? 'all' : s.key)}
            style={{ borderColor: s.color }}
            title={`${s.label} — ${s.description}`}
          >
            <div className={styles.journeyFunnelLabel}>{s.emoji} {s.label}</div>
            <div className={styles.journeyFunnelCount} style={{ color: s.color }}>{stageCounts[s.key]}</div>
          </button>
        ))}
      </div>

      <div className={styles.journeyControls}>
        <input
          className={styles.profSearch}
          placeholder="Search customer…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select value={satFilter} onChange={e => setSatFilter(e.target.value as SatisfactionFilter)}>
          <option value="all">All satisfaction</option>
          <option value="unhappy">Unhappy (≤2)</option>
          <option value="happy">Happy (≥4)</option>
        </select>
        <span className={styles.journeyResultCount}>{filtered.length} customers</span>
      </div>

      {filtered.length === 0 ? (
        <div className={styles.empty}>No customers match these filters.</div>
      ) : (
        <div className={styles.journeyGrid}>
          {filtered.map(j => (
            <JourneyCard
              key={j.customer.id}
              journey={j}
              dormancyDays={engagementMap.get(j.customer.id)?.dormancy_days ?? null}
              hasLovely={engagementMap.get(j.customer.id)?.lovely_user_id != null}
              onOpen={() => setOpenId(j.customer.id)} />
          ))}
        </div>
      )}

      {open && (
        <JourneyDetailPanel
          journey={open}
          onClose={() => setOpenId(null)}
          onChanged={refreshCustomers}
        />
      )}
    </div>
  );
}

function JourneyCard({ journey, dormancyDays, hasLovely, onOpen }: {
  journey: Journey;
  dormancyDays: number | null;
  hasLovely: boolean;
  onOpen: () => void;
}) {
  const stage = STAGES[STAGE_INDEX[journey.currentStage]];
  const s = journey.overallSatisfaction;
  const badge = dormancyBadge(dormancyDays);
  return (
    <button className={styles.journeyCard} onClick={onOpen}>
      <div className={styles.journeyCardHead}>
        <div className={styles.journeyCardName}>{journey.customer.full_name}</div>
        <div
          className={styles.journeyCardMood}
          title={SATISFACTION_LABEL[s]}
          style={{ background: SATISFACTION_COLOR[s] }}
        >
          {SATISFACTION_EMOJI[s]}
        </div>
      </div>
      {hasLovely && badge && (
        <div style={{
          display: 'inline-block', marginTop: 4,
          fontSize: 9, padding: '1px 6px', borderRadius: 999,
          fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3,
          color:
            badge.tone === 'good'  ? 'var(--color-success)' :
            badge.tone === 'warn'  ? 'var(--color-warning)' :
                                     'var(--color-error)',
          background:
            badge.tone === 'good'  ? 'var(--color-success-bg)' :
            badge.tone === 'warn'  ? 'var(--color-warning-bg)' :
                                     'var(--color-error-bg)',
        }} title="lilalovely engagement">{badge.label}</div>
      )}
      <div className={styles.journeyCardStage} style={{ color: stage.color, borderColor: stage.color }}>
        {stage.emoji} {stage.label}
      </div>
      <div className={styles.journeyCardEmotion}>{stage.emotionLabel}</div>
      <div className={styles.journeyCardMini}>
        {STAGES.map(st => {
          const reached = STAGE_INDEX[st.key] <= STAGE_INDEX[journey.currentStage];
          return (
            <span
              key={st.key}
              className={styles.journeyCardMiniDot}
              style={{
                background: reached ? st.color : '#edf2f7',
                opacity: reached ? 1 : 0.35,
                outline: st.key === journey.currentStage ? `2px solid ${st.color}` : 'none',
                outlineOffset: 1,
              }}
              title={st.label}
            />
          );
        })}
      </div>
    </button>
  );
}

function JourneyDetailPanel({
  journey, onClose, onChanged,
}: {
  journey: Journey;
  onClose: () => void;
  /** Called after a successful mutation so the parent re-fetches the
   *  customers list. Realtime alone isn't reliable for in-app writes. */
  onChanged: () => Promise<void> | void;
}) {
  const { customer, signals, overallSatisfaction, isManualStage, currentStage } = journey;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Local control state for the dropdown. Re-sync when the upstream
  // journey prop changes (after onChanged → useCustomers refetch →
  // inferJourney re-runs) so the selection reflects the source of truth.
  const [pendingStage, setPendingStage] = useState<string>(isManualStage ? currentStage : '');
  useEffect(() => {
    setPendingStage(isManualStage ? currentStage : '');
  }, [isManualStage, currentStage]);

  async function handleSetStage(next: string | null) {
    setBusy(true); setErr(null);
    try {
      await setJourneyStageOverride(customer.id, next);
      // Optimistic UI update; useEffect above will re-sync once the
      // refetch lands and the prop changes.
      setPendingStage(next ?? '');
      await onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.panelBackdrop} onClick={onClose}>
      <div className={styles.journeyPanel} onClick={e => e.stopPropagation()}>
        <div className={styles.panelHeader}>
          <div>
            <h2 className={styles.panelTitle}>
              {customer.full_name}
              <span
                className={styles.journeyPanelMood}
                title={SATISFACTION_LABEL[overallSatisfaction]}
                style={{ background: SATISFACTION_COLOR[overallSatisfaction] }}
              >
                {SATISFACTION_EMOJI[overallSatisfaction]} {SATISFACTION_LABEL[overallSatisfaction]}
              </span>
              {isManualStage && (
                <span className={styles.journeyManualBadge} title="Stage was manually set by an operator">
                  manual
                </span>
              )}
            </h2>
            <div className={styles.panelSubtitle}>{customer.email ?? 'no email'}</div>
          </div>
          <button onClick={onClose} className={styles.panelClose} aria-label="Close">×</button>
        </div>

        <div className={styles.panelBody}>
          <div className={styles.journeyStagePicker}>
            <label className={styles.journeyStagePickerLabel}>Override stage:</label>
            <select
              value={pendingStage}
              onChange={e => void handleSetStage(e.target.value === '' ? null : e.target.value)}
              disabled={busy}
              className={styles.journeyStagePickerSelect}
            >
              <option value="">— inferred ({currentStage}) —</option>
              {STAGES.map(s => (
                <option key={s.key} value={s.key}>{s.emoji} {s.label}</option>
              ))}
            </select>
            {isManualStage && (
              <button
                type="button"
                className={styles.journeyStagePickerClear}
                onClick={() => void handleSetStage(null)}
                disabled={busy}
              >
                Revert to inferred
              </button>
            )}
            {err && <span className={styles.journeyStagePickerErr}>{err}</span>}
          </div>

          <div className={styles.journeyPanelHint}>
            10-stage CJM from <code>CJM/makeLILA_CJM_v2.html</code>. Bars below a stage are scored 0–5
            from real ops data — orders, lifecycle, tickets, returns. Click a bar to see the signals
            feeding it. Use the override above when the heuristics get it wrong.
          </div>

          <div className={styles.journeyTimeline}>
            {journey.stages.map(ss => {
              const def = STAGES[STAGE_INDEX[ss.key]];
              const current = ss.key === journey.currentStage;
              return (
                <div
                  key={ss.key}
                  className={`${styles.journeyTimelineStage} ${current ? styles.journeyTimelineCurrent : ''}`}
                  style={{ borderTopColor: def.color }}
                >
                  <div className={styles.journeyTimelineHead} style={{ background: def.color }}>
                    <div className={styles.journeyTimelineEmoji}>{def.emoji}</div>
                    <div className={styles.journeyTimelineLabel}>{def.label}</div>
                  </div>
                  <div className={styles.journeyTimelineBody}>
                    {!ss.reached ? (
                      <div className={styles.journeyTimelineNotYet}>not yet reached</div>
                    ) : (
                      <>
                        <div className={styles.journeyTimelineScore}>
                          <span
                            className={styles.journeyTimelineScoreVal}
                            style={{ color: SATISFACTION_COLOR[ss.satisfaction ?? 3] }}
                          >
                            {SATISFACTION_EMOJI[ss.satisfaction ?? 3]} {ss.satisfaction ?? '—'}/5
                          </span>
                          <span className={styles.journeyTimelineScoreLabel}>
                            {SATISFACTION_LABEL[ss.satisfaction ?? 3]}
                          </span>
                        </div>
                        <ul className={styles.journeyTimelineSignals}>
                          {ss.signals.length === 0
                            ? <li className={styles.journeyTimelineNoSignal}>—</li>
                            : ss.signals.map((s, i) => <li key={i}>{s}</li>)}
                        </ul>
                      </>
                    )}
                    <div className={styles.journeyTimelineEmotion}>{def.emotionLabel}</div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className={styles.journeyDataDump}>
            <div>
              <div className={styles.journeyDataDumpTitle}>Orders ({signals.orders.length})</div>
              {signals.orders.length === 0 ? <div className={styles.muted}>—</div> :
                signals.orders.map(o => (
                  <div key={o.id} className={styles.journeyDataDumpRow}>
                    {o.order_ref} · {o.kind} · {o.status} · {o.placed_at?.slice(0, 10) ?? '—'}
                  </div>
                ))}
            </div>
            <div>
              <div className={styles.journeyDataDumpTitle}>Tickets ({signals.tickets.length})</div>
              {signals.tickets.length === 0 ? <div className={styles.muted}>—</div> :
                signals.tickets.map(t => (
                  <div key={t.id} className={styles.journeyDataDumpRow}>
                    {t.subject?.slice(0, 36)} · {t.topic ?? '—'} · {t.status}
                  </div>
                ))}
            </div>
            <div>
              <div className={styles.journeyDataDumpTitle}>Returns ({signals.returns.length})</div>
              {signals.returns.length === 0 ? <div className={styles.muted}>—</div> :
                signals.returns.map(r => (
                  <div key={r.id} className={styles.journeyDataDumpRow}>
                    {r.unit_serial ?? '—'} · {r.status} · rated {r.experience_rating ?? '—'}/5
                  </div>
                ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
