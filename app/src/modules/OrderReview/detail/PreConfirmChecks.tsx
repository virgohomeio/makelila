import { useState } from 'react';
import type { Order } from '../../../lib/orders';
import { verifyAddress, AREA_TYPE_LABEL } from '../../../lib/orders';
import { DWELLING_LABEL, DWELLING_NOTE, dwellingProvenance } from '../../../lib/addressClassify';
import {
  useQuotes, fetchFreightcomQuoteRun, cheapestCadQuote, selectQuote, quoteSurcharges,
  type QuoteRun,
} from '../../../lib/freight';
import { formatMoney } from '../../../lib/money';
import { freightQuoted } from './ReadinessChecklist';
import { PRECHECK_ID } from './anchors';
import styles from '../OrderReview.module.css';

// The two checks that decide whether an order can ship, in the order they have
// to happen, directly under the button they gate.
//
// Both actions already existed — Verify address on the Address card, Get live
// quote on the Freight card — but both sat well below the fold, in no
// particular order, and confirming depended on neither. So an order could be
// confirmed with nobody having checked its postal code, and freight got quoted
// (when it got quoted at all) against whatever the customer typed.
//
// The sequence is enforced rather than described: a rate is only as accurate as
// the postal code it was asked about, so freight cannot be quoted until the
// address has been verified. The original two buttons stay exactly where they
// were — they are the re-check, after an address is corrected or a second
// carrier opinion is wanted.

// Freight is quoted in CAD whatever the order's own currency — Freightcom
// prices our account in Canadian dollars for a US destination too.
const FREIGHT_CURRENCY = 'CAD';

/** One line of the summary: what we now know, and how we know it. */
function Row({ label, value, note, source, tone }: {
  label: string;
  value: string;
  note?: string;
  source?: string;
  tone?: 'ok' | 'warn' | 'bad';
}) {
  const cls =
    tone === 'ok'   ? styles.summaryRowOk
  : tone === 'warn' ? styles.summaryRowWarn
  : tone === 'bad'  ? styles.summaryRowBad
  : '';
  return (
    <div className={`${styles.summaryRow} ${cls}`}>
      <span className={styles.summaryLabel}>{label}</span>
      <span className={styles.summaryValue}>{value}</span>
      {note   && <span className={styles.summaryNote}>{note}</span>}
      {source && <span className={styles.summarySource}>{source}</span>}
    </div>
  );
}

export function PreConfirmChecks({ order }: { order: Order }) {
  const { quotes, refetch } = useQuotes(order.id);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  // What the last quote run in THIS session was asked about. The order row says
  // what the estimate is; only the run itself can say how many boxes it covered
  // and whether it had to fall back to the postal authority's code.
  const [run, setRun] = useState<QuoteRun | null>(null);

  const verified = !!order.address_verified_at;
  const selectedQuote = quotes.find(q => q.selected) ?? null;
  const quoted = freightQuoted(order);
  const postalLabel = order.country === 'US' ? 'ZIP code' : 'Postal code';

  const runVerify = async () => {
    setVerifyBusy(true); setVerifyErr(null);
    try {
      await verifyAddress(order.id);
    } catch (e) {
      setVerifyErr((e as Error).message);
    } finally {
      setVerifyBusy(false);
    }
  };

  const runQuote = async () => {
    setQuoteBusy(true); setQuoteErr(null);
    try {
      const r = await fetchFreightcomQuoteRun(order.id);
      setRun(r);
      const cheapest = cheapestCadQuote(r.quotes);
      if (!cheapest) {
        setQuoteErr('No carrier rates came back for this destination. Quote it in the ClickShip portal and paste the total into the Freight card below.');
        return;
      }
      await selectQuote(order.id, cheapest.id);
      await refetch();
    } catch (e) {
      setQuoteErr((e as Error).message);
    } finally {
      setQuoteBusy(false);
    }
  };

  // ── The summary ──────────────────────────────────────────────────────
  // Only once both checks have actually run. Half a summary is worse than
  // none: it reads as a finished picture of an address nobody finished
  // checking.
  const complete = verified && quoted;

  const postalRow = (() => {
    if (order.address_match === 'match') {
      return {
        value: order.address_google_postal ?? order.address_customer_postal ?? '—',
        note: 'matches the postal authority’s record for this street address',
        tone: 'ok' as const,
      };
    }
    if (order.address_match === 'mismatch') {
      return {
        value: `${order.address_customer_postal ?? '—'} → ${order.address_google_postal ?? 'unknown'}`,
        note: `the customer’s ${postalLabel.toLowerCase()} is not the one on file for this address — send the mismatch email before shipping`,
        tone: 'bad' as const,
      };
    }
    return {
      value: order.address_customer_postal ?? '—',
      note: 'the postal authority could not resolve this address well enough to confirm the code',
      tone: 'warn' as const,
    };
  })();

  const surcharges = quoteSurcharges(selectedQuote);
  const freightValue = selectedQuote?.rate_cad != null
    ? formatMoney(selectedQuote.rate_cad, FREIGHT_CURRENCY)
    : formatMoney(order.freight_estimate_usd, FREIGHT_CURRENCY);
  const freightNote = [
    selectedQuote?.service_level,
    selectedQuote?.transit_days != null ? `${selectedQuote.transit_days}-day transit` : null,
    run ? `${run.package_count} box${run.package_count === 1 ? '' : 'es'}` : null,
    surcharges.length > 0
      ? `incl. ${surcharges.map(s => `${s.label} ${formatMoney(s.amount_cad, FREIGHT_CURRENCY)}`).join(', ')}`
      : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className={styles.precheck} id={PRECHECK_ID}>
      <div className={styles.precheckHead}>Before you confirm</div>

      <div className={styles.precheckSteps}>
        <div className={styles.precheckStep}>
          <button
            type="button"
            className={`${styles.precheckBtn} ${verified ? styles.precheckBtnDone : ''}`}
            onClick={() => void runVerify()}
            disabled={verifyBusy}
          >
            {verifyBusy ? 'Verifying…' : verified ? '✓ 1 · Address verified' : '1 · Verify address'}
          </button>
          <span className={styles.precheckHint}>
            Start here. Checks the {postalLabel.toLowerCase()} against the postal
            authority, and classifies the building and the delivery area.
          </span>
          {verifyErr && <span className={styles.precheckError}>{verifyErr}</span>}
        </div>

        <div className={styles.precheckStep}>
          <button
            type="button"
            className={`${styles.precheckBtn} ${quoted ? styles.precheckBtnDone : ''}`}
            onClick={() => void runQuote()}
            disabled={quoteBusy || !verified}
          >
            {quoteBusy ? 'Quoting…' : quoted ? '✓ 2 · Freight estimated' : '2 · Get freight estimate'}
          </button>
          <span className={styles.precheckHint}>
            {verified
              ? 'Then this. Pulls live carrier rates for the verified address and adopts the cheapest.'
              : 'Verify the address first — a rate is only as accurate as the postal code it was quoted against.'}
          </span>
          {quoteErr && <span className={styles.precheckError}>{quoteErr}</span>}
        </div>
      </div>

      {complete ? (
        <div className={styles.summary}>
          <Row
            label="Ships to"
            value={order.address_google_formatted
              ?? [order.address_line, order.address_line2, order.city, order.region_state, order.country]
                   .filter(Boolean).join(', ')}
            note={order.address_line2 ? `unit ${order.address_line2} on file` : undefined}
            source={order.address_google_formatted
              ? 'standardized by the postal authority'
              : 'as the customer entered it — the postal authority did not standardize it'}
          />
          <Row
            label={postalLabel}
            value={postalRow.value}
            note={postalRow.note}
            tone={postalRow.tone}
            source={`checked ${new Date(order.address_verified_at!).toLocaleDateString()}`}
          />
          <Row
            label="Building"
            value={DWELLING_LABEL[order.address_verdict]}
            note={DWELLING_NOTE[order.address_verdict]}
            source={dwellingProvenance(order.address_verdict_source, order.address_verified_at)}
            tone={order.address_verdict === 'po_box' ? 'bad'
              : order.address_verdict === 'house' ? 'ok' : 'warn'}
          />
          <Row
            label="Area"
            value={order.area_type ? AREA_TYPE_LABEL[order.area_type] : 'Unclassified'}
            note={order.area_type === 'rural'
              ? 'rural or remote — the carrier adds an extended-area surcharge and transit runs longer'
              : order.area_type
                ? 'standard delivery area'
                : 'not classified — urban and suburban cannot be told apart from a postal code alone'}
            tone={order.area_type === 'rural' ? 'warn' : order.area_type ? 'ok' : undefined}
            source={order.area_type_source === 'manual' ? 'set by an operator'
              : order.area_type_source === 'verified' ? 'classified by address verification'
              : order.area_type ? 'from the postal-code rule'
              : 'not established'}
          />
          <Row
            label="Freight"
            value={freightValue}
            note={freightNote || undefined}
            source={run?.quoted_postal_source === 'verified'
              ? `quoted against the postal authority’s ${postalLabel.toLowerCase()} ${run.quoted_postal}, not the customer’s`
              : selectedQuote
                ? `live ${selectedQuote.provider} rate, ${new Date(selectedQuote.quoted_at).toLocaleDateString()}`
                : `${order.freight_estimate_source} estimate`}
            tone={order.freight_estimate_usd > order.freight_threshold_usd ? 'warn' : 'ok'}
          />
        </div>
      ) : (
        <div className={styles.precheckPending}>
          {verified
            ? 'Run step 2 — the summary fills in once freight has been quoted against this address.'
            : 'Run both steps in order. The summary of this customer’s address and what shipping it will cost appears here, and confirming opens once it does.'}
        </div>
      )}
    </div>
  );
}
