import { useState } from 'react';
import type { Order, AreaType, Dwelling } from '../../../lib/orders';
import {
  setSalesConfirmedFit, verifyAddress, setAreaType, setDwelling, AREA_TYPE_LABEL,
} from '../../../lib/orders';
import {
  DWELLING_LABEL, DWELLING_NOTE, dwellingProvenance, needsFitConfirmation,
} from '../../../lib/addressClassify';
import { sendTemplate } from '../../../lib/templates';
import { ADDRESS_CARD_ID } from './anchors';
import styles from '../OrderReview.module.css';

// The card states three things about an address, and each one is only worth
// what its provenance is worth:
//
//   POSTAL   — does the code the customer typed match the real one?
//   DWELLING — house, apartment, condo, business, PO box, rural route?
//   AREA     — urban, suburban, rural?
//
// Before this rewrite all three rendered identically whether a postal authority
// had confirmed them or nobody had ever looked: 280 of 287 orders read "HOUSE ·
// single-family · standard delivery" (a regex over the street line, run once at
// Shopify-sync time and never revisited) and ~200 read "Suburban" (a literal
// fallthrough default). An operator can't act on a field that says the same
// thing for every order, so every claim below carries the sentence that says
// where it came from, and an unchecked claim is styled as an open question
// rather than as an answer.

const DWELLING_OPTIONS: Dwelling[] = ['house', 'apt', 'condo', 'remote', 'business', 'po_box'];

/** Dwelling types that can't take a normal freight delivery at all, as opposed
 *  to ones that just need coordinating. */
function isBlockingDwelling(d: Dwelling): boolean {
  return d === 'po_box';
}

function MissingField({ quoUrl }: { quoUrl: string | null }) {
  return (
    <span className={styles.missing}>
      Not on file
      {quoUrl && (
        <a
          className={styles.missingFix}
          href={quoUrl}
          target="_blank"
          rel="noopener noreferrer"
        >Get via QUO ↗</a>
      )}
    </span>
  );
}

export function AddressCard({ order }: { order: Order }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  const verified = !!order.address_verified_at;
  const dwellingConfirmed = order.address_verdict_source === 'google';
  const unitMissing = order.address_unit_status === 'missing';
  const unitUnrecognized = order.address_unit_status === 'unrecognized';
  const postalLabel = order.country === 'US' ? 'ZIP code' : 'Postal code';

  const say = (text: string, isError = false) => { setMsg(text); setErr(isError); };

  const runVerify = async () => {
    setBusy(true); say('');
    try {
      const r = await verifyAddress(order.id);
      const head =
        r.match === 'match'    ? `${postalLabel} verified.` :
        r.match === 'mismatch' ? `${postalLabel} mismatch — see below.` :
        r.google_error         ? 'Address validation service unavailable — classified what we could.' :
                                 `Could not confirm the ${postalLabel.toLowerCase()}.`;
      const parts = [head];
      // Say what each pass actually established. A verify that silently
      // established nothing used to read the same as one that established
      // everything.
      parts.push(r.dwelling_source === 'google'
        ? `Building: ${DWELLING_LABEL[r.dwelling].toLowerCase()} (confirmed).`
        : `Building: still unconfirmed — Google resolved the street but not the premise.`);
      if (r.unit_status === 'missing') parts.push('No unit number on file for a multi-unit building.');
      parts.push(r.area_type
        ? `Area: ${AREA_TYPE_LABEL[r.area_type]}.`
        : `Area not classified${r.area_type_error ? ` — ${r.area_type_error}` : '.'}`);
      say(parts.join(' '), r.match === 'mismatch' || r.unit_status === 'missing');
    } catch (e) {
      say(`Error: ${(e as Error).message}`, true);
    } finally {
      setBusy(false);
    }
  };

  const sendMismatchEmail = async () => {
    if (!order.customer_email) { say('No customer email on file.', true); return; }
    setBusy(true); say('');
    try {
      const r = await sendTemplate({
        template_key: 'address_mismatch',
        to: order.customer_email,
        to_name: order.customer_name,
        variables: {
          customer_first_name:  order.customer_name.split(' ')[0],
          address_we_have:      order.address_line ?? '',
          address_standardized: order.address_google_formatted ?? '',
          order_ref:            order.order_ref,
        },
      });
      say(`✓ Email sent (id ${r.message_id})`);
    } catch (e) {
      say(`Send failed: ${(e as Error).message}`, true);
    } finally {
      setBusy(false);
    }
  };

  // ── Claim 1: the postal code ────────────────────────────────────────
  const postalClaim = (() => {
    if (!verified || !order.address_match) {
      return { cls: styles.claimUnchecked, value: order.address_customer_postal ?? '—',
               unchecked: true, note: 'Not checked against a postal authority yet.', source: 'run Verify to check it' };
    }
    if (order.address_match === 'match') {
      return { cls: styles.claimConfirmed, value: order.address_google_postal ?? order.address_customer_postal ?? '—',
               unchecked: false, note: 'Matches the postal authority’s record for this street address.',
               source: `confirmed ${new Date(order.address_verified_at!).toLocaleDateString()}` };
    }
    if (order.address_match === 'mismatch') {
      return { cls: styles.claimBlocking, value: order.address_customer_postal ?? '—',
               unchecked: false, note: `The postal authority has ${order.address_google_postal ?? 'a different code'} for this address.`,
               source: `checked ${new Date(order.address_verified_at!).toLocaleDateString()}` };
    }
    return { cls: styles.claimCaution, value: order.address_customer_postal ?? '—',
             unchecked: false, note: 'The postal authority could not resolve this address well enough to confirm the code.',
             source: `checked ${new Date(order.address_verified_at!).toLocaleDateString()}` };
  })();

  // ── Claim 2: the dwelling type ──────────────────────────────────────
  const dwellingClaim = (() => {
    if (!dwellingConfirmed && order.address_verdict_source !== 'manual') {
      return { cls: styles.claimUnchecked, unchecked: true };
    }
    if (isBlockingDwelling(order.address_verdict)) return { cls: styles.claimBlocking, unchecked: false };
    if (needsFitConfirmation(order.address_verdict)) return { cls: styles.claimCaution, unchecked: false };
    return { cls: styles.claimConfirmed, unchecked: false };
  })();

  // ── Claim 3: the area type ──────────────────────────────────────────
  const areaVerified = order.area_type_source === 'verified' || order.area_type_source === 'manual';

  return (
    <div className={styles.card} id={ADDRESS_CARD_ID}>
      <div className={styles.cardHead}>Shipping Address</div>
      <div className={styles.cardBody}>
        <div className={styles.contactLine}>
          <span className={styles.contactLabel}>Street</span>
          {order.address_line
            ? <span>{order.address_line}</span>
            : <MissingField quoUrl={order.quo_thread_url} />}
        </div>
        <div className={styles.contactLine}>
          <span className={styles.contactLabel}>Apartment/Unit #</span>
          {/* Always shown alongside the rest of the address; blank when the
              customer didn't provide an apartment/unit. */}
          <span>{order.address_line2 ?? ''}</span>
        </div>
        <div className={styles.contactLine}>
          <span className={styles.contactLabel}>City</span>
          <span>{order.city}</span>
        </div>
        <div className={styles.contactLine}>
          <span className={styles.contactLabel}>Region</span>
          {order.region_state
            ? <span>{order.region_state}</span>
            : <MissingField quoUrl={order.quo_thread_url} />}
        </div>
        <div className={styles.contactLine}>
          <span className={styles.contactLabel}>{postalLabel}</span>
          {order.address_customer_postal
            ? <span>{order.address_customer_postal}</span>
            : <MissingField quoUrl={order.quo_thread_url} />}
        </div>
        <div className={styles.contactLine}>
          <span className={styles.contactLabel}>Country</span>
          <span>{order.country}</span>
        </div>

        {/* A multi-unit building with no unit number. Loudest thing on the
            card: a freight driver with nowhere to deliver leaves the pallet in
            a lobby or takes it back to the terminal. */}
        {unitMissing && (
          <div className={styles.unitAlert}>
            <span className={styles.unitAlertHead}>⚠ No unit number</span>
            <span className={styles.unitAlertBody}>
              {order.address_google_formatted ?? order.address_line} is a multi-unit building.
              The street address is confirmed, but no apartment/unit number is on this order —
              ask the customer for it before booking freight.
            </span>
          </div>
        )}
        {unitUnrecognized && (
          <div className={styles.unitAlert}>
            <span className={styles.unitAlertHead}>⚠ Unit not recognised</span>
            <span className={styles.unitAlertBody}>
              The postal authority confirmed the street but does not recognise unit
              “{order.address_line2}” at it. Confirm the unit with the customer.
            </span>
          </div>
        )}

        {/* ── The three claims ───────────────────────────────────────── */}

        <div className={`${styles.claim} ${postalClaim.cls}`}>
          <div className={styles.claimHead}>
            <span className={styles.claimTitle}>{postalLabel}</span>
            <span className={postalClaim.unchecked ? styles.claimValueUnchecked : styles.claimValue}>
              {postalClaim.unchecked ? 'Unverified' : postalClaim.value}
            </span>
          </div>
          <span className={styles.claimNote}>{postalClaim.note}</span>
          <span className={styles.claimSource}>{postalClaim.source}</span>
        </div>

        <div className={`${styles.claim} ${dwellingClaim.cls}`}>
          <div className={styles.claimHead}>
            <span className={styles.claimTitle}>Building</span>
            <select
              className={styles.claimSelect}
              aria-label="Building type"
              value={order.address_verdict}
              onChange={async e => {
                try { await setDwelling(order.id, e.target.value as Dwelling); }
                catch (err2) { say((err2 as Error).message, true); }
              }}
            >
              {DWELLING_OPTIONS.map(d => (
                <option key={d} value={d}>{DWELLING_LABEL[d]}</option>
              ))}
            </select>
          </div>
          <span className={styles.claimNote}>
            {dwellingClaim.unchecked
              ? 'Not confirmed — this is a guess from the address text, and it is wrong often enough to check.'
              : DWELLING_NOTE[order.address_verdict]}
          </span>
          <span className={styles.claimSource}>
            {dwellingProvenance(order.address_verdict_source, order.address_verified_at)}
            {order.address_usps_record_type && ` · USPS record type ${order.address_usps_record_type}`}
          </span>
        </div>

        <div className={`${styles.claim} ${
          !order.area_type ? styles.claimUnchecked
          : areaVerified ? styles.claimConfirmed
          : styles.claimUnchecked
        }`}>
          <div className={styles.claimHead}>
            <span className={styles.claimTitle}>Area</span>
            <select
              className={styles.claimSelect}
              aria-label="Area type"
              value={order.area_type ?? ''}
              onChange={async e => {
                const v = (e.target.value || null) as AreaType | null;
                try { await setAreaType(order.id, v); }
                catch (err2) { say((err2 as Error).message, true); }
              }}
            >
              <option value="">Unclassified</option>
              <option value="urban">{AREA_TYPE_LABEL.urban}</option>
              <option value="suburban">{AREA_TYPE_LABEL.suburban}</option>
              <option value="rural">{AREA_TYPE_LABEL.rural}</option>
            </select>
          </div>
          <span className={styles.claimNote}>
            {order.area_type === 'rural'
              ? 'Rural or remote delivery — expect a freight surcharge and a longer transit.'
              : order.area_type
                ? 'Standard delivery area.'
                : 'Not classified. Urban and suburban cannot be told apart from a postal code, so nothing is assumed here.'}
          </span>
          <span className={styles.claimSource}>
            {order.area_type_source === 'manual' ? 'set by an operator'
              : order.area_type_source === 'verified' ? `classified by address verification${order.address_verified_at ? ` ${new Date(order.address_verified_at).toLocaleDateString()}` : ''}`
              : order.area_type ? 'from the postal-code rule'
              : order.address_area_type_error
                ? `could not be classified — ${order.address_area_type_error}`
                : 'run Verify to classify it'}
          </span>
        </div>

        {needsFitConfirmation(order.address_verdict) && (
          <div className={styles.salesConfirmToggle}>
            <input
              type="checkbox"
              id={`sales-fit-${order.id}`}
              checked={order.sales_confirmed_fit}
              onChange={async e => {
                try { await setSalesConfirmedFit(order.id, e.target.checked); }
                catch (err2) { say((err2 as Error).message, true); }
              }}
            />
            <label htmlFor={`sales-fit-${order.id}`}>
              Sales confirmed fit with customer (required for a{' '}
              {DWELLING_LABEL[order.address_verdict].toLowerCase()} address)
            </label>
          </div>
        )}

        {order.address_confirmation_sent_at && !order.address_confirmed_at && (
          <div className={styles.awaiting}>
            <span>⚠</span>
            <span>Awaiting customer address confirmation</span>
          </div>
        )}
        {order.address_confirmed_at && (
          <div className={styles.confirmed}>
            <span>✓</span>
            <span>Customer confirmed address {new Date(order.address_confirmed_at).toLocaleDateString()}</span>
          </div>
        )}

        <div className={styles.verifySection}>
          <div className={styles.verifyRow}>
            <button
              onClick={() => void runVerify()}
              disabled={busy}
              className={`${styles.verifyBtn} ${verified ? styles.verifyBtnDone : ''}`}
            >
              {busy ? 'Verifying…' : verified ? 'Re-verify' : 'Verify address'}
            </button>

            {order.address_match === 'match' && (
              <span className={`${styles.badge} ${styles.badgeMatch}`}>✓ {postalLabel.toUpperCase()} MATCH</span>
            )}
            {order.address_match === 'mismatch' && (
              <span className={`${styles.badge} ${styles.badgeMismatch}`}>⚠ {postalLabel.toUpperCase()} MISMATCH</span>
            )}
            {order.address_match === 'unverifiable' && (
              <span className={`${styles.badge} ${styles.badgeUnverifiable}`}>UNVERIFIABLE</span>
            )}
            {/* Granularity is the difference between "Google found this exact
                building" and "Google found the street it's on" — which is
                exactly how much to trust the building type above. */}
            {verified && order.address_validation_granularity && (
              <span
                className={`${styles.badge} ${styles.badgeInfo}`}
                title={
                  order.address_validation_granularity === 'SUB_PREMISE' ? 'Resolved to a specific unit within the building.'
                  : order.address_validation_granularity === 'PREMISE' ? 'Resolved to this exact building.'
                  : 'Resolved only to the street — not precise enough to identify the building.'
                }
              >{order.address_validation_granularity.replace('_', ' ')}</span>
            )}
            {order.address_claude_verdict && (
              <span
                className={`${styles.badge} ${styles.badgeInfo}`}
                title={order.address_claude_notes ?? ''}
              >model: {order.address_claude_verdict}</span>
            )}
          </div>

          {order.address_claude_notes && (
            <div className={styles.mismatchDetail}>
              <em>{order.address_claude_notes}</em>
              {order.address_claude_postal && (
                <> · inferred postal: <strong>{order.address_claude_postal}</strong></>
              )}
            </div>
          )}

          {order.address_match === 'mismatch' && order.address_google_formatted && (
            <div className={styles.mismatchDetail}>
              <div>Customer {postalLabel.toLowerCase()}: <strong>{order.address_customer_postal ?? '—'}</strong></div>
              <div>Postal authority: <strong>{order.address_google_postal ?? '—'}</strong></div>
              <div style={{ marginTop: 4 }}>Standardized address: <em>{order.address_google_formatted}</em></div>
              <button
                onClick={() => void sendMismatchEmail()}
                disabled={busy || !order.customer_email}
                className={styles.mismatchBtn}
              >
                Send mismatch email
              </button>
            </div>
          )}

          {msg && (
            <div className={`${styles.verifyMsg} ${err ? styles.verifyMsgError : ''}`}>{msg}</div>
          )}
        </div>
      </div>
    </div>
  );
}
