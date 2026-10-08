import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  buildEzTransBooking,
  saveEzTransLabel,
  sendEzTransBooking,
  useEzTransPlacements,
  useEzTransTemplate,
  packingListPreview,
  attachmentFilenames,
  needsPesticideWorksheet,
  pesticideWorksheetSummary,
  EZTRANS_CC,
  EZTRANS_EMAIL,
  EZTRANS_SENT_ACTION,
  GOOROOSHIP_SHIP_URL,
  type EzTransShipTo,
} from '../../../lib/eztrans';
import { REBOOK_ACTION } from '../../../lib/rebookShipment';
import {
  confirmEzTransOrder,
  unconfirmEzTransOrder,
  markEzTransSentOutsideBatch,
  batchAttachmentFilenames,
  EZTRANS_BATCH_CONFIRMED_ACTION,
} from '../../../lib/eztransBatch';
import { logAction, useActivityForEntity } from '../../../lib/activityLog';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';
import { QUEUE_CARRIERS } from '../../../lib/queueCarrier';
import styles from '../Fulfillment.module.css';

export type EzTransOrder = EzTransShipTo & { id: string; order_ref: string };


/** The Goorooship half of step 3.
 *
 *  Stock on our own floor is booked through Freightcom. Stock held at the
 *  EZTrans 3PL is booked through Goorooship, and EZ Trans only picks the box
 *  once we email them a confirmation with a packing list and the label they
 *  are to print — so this panel only renders when the unit assigned at step 1
 *  is actually sitting at EZTrans. It renders nothing at all otherwise.
 *
 *  Its sibling is FreightcomPanel, which does the same four moves for stock on
 *  our own floor: open the carrier's portal, book the shipment there, record
 *  the label it issued, confirm it. Step 3 shows one or the other, never both.
 *  The label details captured here are the same three fields that panel asks
 *  for, written to the same queue-row columns, so nothing has to be typed
 *  twice: `onLabelSaved` hands them up to StepLabel, which leaves Pickup
 *  scheduled as a single click. */
export function EzTransPanel({
  row,
  order,
  onLabelSaved,
  onBatchChanged,
  starterGap = null,
}: {
  row: FulfillmentQueueRow;
  order: EzTransOrder;
  onLabelSaved?: (v: { carrier: string; tracking_num: string }) => void;
  /** Re-read the queue after this order joins or leaves the day's batch, so
   *  the footer at the bottom of the page catches up without a reload. */
  onBatchChanged?: () => void;
  /** What the compost starter is still waiting on, null when nothing.
   *
   *  The soil is bought on Amazon and ships to the customer direct, so it never
   *  touches this carton — but this is the last moment anyone looks at the
   *  order before the 3PL has the box, and "we forgot the starter" is only
   *  fixable before then. Computed by StepLabel so the three buttons that can
   *  end step 3 — confirm into the batch, send on its own, Pickup scheduled —
   *  are gated by one answer rather than three. */
  starterGap?: string | null;
}) {
  // Every machine on the order, not just the first one picked. An order for
  // three LILA Pros books as one Goorooship shipment, and the 3PL has to be
  // told about all three or two of them never leave the warehouse.
  const { placements, offsite, loading } = useEzTransPlacements(row.assigned_serials);
  const { template, packingList: packingListTemplate, source: templateSource } = useEzTransTemplate();
  const [carrier, setCarrier] = useState(row.carrier ?? '');
  const [tracking, setTracking] = useState(row.tracking_num ?? '');
  const [pdf, setPdf] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSent, setJustSent] = useState<string | null>(null);
  // A send that went out from a different address than intended is still a
  // send, so it is reported next to the success line rather than as an error.
  const [sendWarning, setSendWarning] = useState<string | null>(null);
  // Where the last send actually went out from, so the operator can tell at a
  // glance whether it will show up in the sender's own Sent folder.
  const [sentFrom, setSentFrom] = useState<{ from: string; via: string } | null>(null);
  // What the server says it actually sent, so "did my edit get used?" is
  // answerable from the panel rather than from the 3PL's reply.
  const [sentDocs, setSentDocs] = useState<{ wording: string; packingList: string } | null>(null);
  // What the server says it attached, so "did the worksheet go?" is answerable
  // from the panel rather than from the broker.
  const [sentFiles, setSentFiles] = useState<string[] | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  // The day-batch stamp as this panel last saw it. Seeded from the row and
  // moved locally on confirm so the operator gets an answer before the
  // realtime round-trip; the row wins again on the next render of a fresh one.
  const [confirmedAt, setConfirmedAt] = useState<string | null>(row.eztrans_confirmed_at ?? null);
  const [batchSentAt, setBatchSentAt] = useState<string | null>(row.eztrans_batch_sent_at ?? null);
  // Null while the operator hasn't touched the wording — the email then simply
  // tracks the template and the live label details. Once they type, their text
  // is held as-is and stops following those, which is the point of editing it.
  const [editedSubject, setEditedSubject] = useState<string | null>(null);
  const [editedBody, setEditedBody] = useState<string | null>(null);
  // The packing list is edited separately from the wording: they are two
  // documents with different readers, and an operator fixing a handling note
  // on the PDF should not have to re-approve the email to send it.
  const [editedPacking, setEditedPacking] = useState<string | null>(null);
  const edited = editedSubject !== null || editedBody !== null;
  const packingEdited = editedPacking !== null;

  // Edits used to live only in component state, so stepping away to another
  // order and back lost them — "it doesn't save my changes". They are kept
  // against the queue row instead, which also stops one order's document from
  // riding along to the next: this panel is rendered without a key, so the
  // same instance serves every row the operator clicks through.
  //
  // Deliberately not cleared after a send. The panel offers a resend, and
  // silently reverting to the stock document between the two would be a worse
  // surprise than a draft that outstays its welcome; Reset is one click.
  const draftKey = `eztrans-draft:${row.id}`;
  const freshlyLoaded = useRef(true);

  // This panel is rendered without a key, so one instance serves every row the
  // operator clicks through — the stamp has to follow the row rather than
  // stay where the last confirm left it.
  useEffect(() => {
    setConfirmedAt(row.eztrans_confirmed_at ?? null);
    setBatchSentAt(row.eztrans_batch_sent_at ?? null);
  }, [row.id, row.eztrans_confirmed_at, row.eztrans_batch_sent_at]);

  useEffect(() => {
    let draft: { subject?: string; body?: string; packingList?: string } | null = null;
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) draft = JSON.parse(raw);
    } catch {
      // Unreadable or unavailable storage (private mode, quota, bad JSON) is
      // not worth breaking the panel over — the operator just starts fresh.
    }
    setEditedSubject(draft?.subject ?? null);
    setEditedBody(draft?.body ?? null);
    setEditedPacking(draft?.packingList ?? null);
    freshlyLoaded.current = true;
  }, [draftKey]);

  useEffect(() => {
    // Skip the pass right after a load, so restoring a draft cannot immediately
    // overwrite it with the nulls this render still holds.
    if (freshlyLoaded.current) { freshlyLoaded.current = false; return; }
    try {
      if (editedSubject === null && editedBody === null && editedPacking === null) {
        localStorage.removeItem(draftKey);
      } else {
        localStorage.setItem(draftKey, JSON.stringify({
          ...(editedSubject !== null ? { subject: editedSubject } : {}),
          ...(editedBody !== null ? { body: editedBody } : {}),
          ...(editedPacking !== null ? { packingList: editedPacking } : {}),
        }));
      }
    } catch {
      // Storage unavailable — the edit still sends, it just won't survive a
      // reload. Not worth an error in front of the operator.
    }
  }, [draftKey, editedSubject, editedBody, editedPacking]);

  // "Already emailed" survives a reload, so an operator coming back to the row
  // doesn't double-book the 3PL. Logged against the order, which is where the
  // rest of this order's history lives.
  //
  // Unless the booking it announced has since been torn up: a rebook is the
  // operator saying the carrier was stood down and a new carton is going out,
  // and the 3PL has been told nothing about that one. Leaving the banner up
  // would warn them off the send they are here to make. Entries arrive
  // newest-first, so the first of each type is the latest.
  const { entries } = useActivityForEntity({ entityType: 'order', entityId: order.id, limit: 50 });
  const lastSend = entries.find(e => e.type === EZTRANS_SENT_ACTION) ?? null;
  const rebookedAt = entries.find(e => e.type === REBOOK_ACTION)?.ts ?? null;
  const priorSend = lastSend && rebookedAt && Date.parse(lastSend.ts) <= Date.parse(rebookedAt)
    ? null
    : lastSend;

  // A label uploaded on an earlier pass is still on the row, so a resend (or a
  // corrected tracking number) doesn't force the operator to find the file again.
  const labelOnFile = !!row.label_pdf_path;
  // offsite blocks the send outright. Booking a three-unit order while one of
  // the three sits on our own floor would tell the 3PL to pick a machine they
  // do not hold — they would ship what they could find and nobody would learn
  // the order went out short until the customer counted boxes.
  const ready = !!carrier && !!tracking.trim() && (!!pdf || labelOnFile)
    && offsite.length === 0 && !starterGap;

  // A shipment into the US is a customs entry and needs a FIFRA worksheet with
  // it, so one is built and attached on those bookings only — the destination
  // decides, not the carrier. Decided by the same helper the edge function
  // uses, so this cannot promise a document the send does not attach.
  const worksheetGoes = needsPesticideWorksheet(order);
  const attachments = attachmentFilenames(order.order_ref, order);

  const booking = useMemo(() => {
    if (placements.length === 0) return null;
    return buildEzTransBooking({
      order,
      units: placements.map(p => ({ serial: p.serial, masterCarton: p.masterCarton })),
      carrier: carrier || null,
      tracking: tracking.trim() || null,
      template,
      packingListTemplate,
    });
  }, [order, placements, carrier, tracking, template, packingListTemplate]);

  // Opening the editor is what commits the current rendering as the starting
  // text — before that the fields are unset so the preview keeps tracking the
  // template and the label details as they are typed in above.
  const subjectValue = editedSubject ?? booking?.subject ?? '';
  const bodyValue = editedBody ?? booking?.body ?? '';
  const packingValue = editedPacking ?? booking?.packingListText ?? '';

  const [editing, setEditing] = useState(false);
  const [editingPacking, setEditingPacking] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const packingRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (editing && bodyRef.current) {
      // Grow to fit rather than making the operator scroll a 6-row box.
      bodyRef.current.style.height = 'auto';
      bodyRef.current.style.height = `${Math.min(bodyRef.current.scrollHeight, 420)}px`;
    }
  }, [editing, bodyValue]);
  useEffect(() => {
    if (editingPacking && packingRef.current) {
      packingRef.current.style.height = 'auto';
      packingRef.current.style.height = `${Math.min(packingRef.current.scrollHeight, 420)}px`;
    }
  }, [editingPacking, packingValue]);

  if (loading || placements.length === 0 || !booking) return null;

  // Shorthand for the parts of the panel that still speak about one machine.
  const first = placements[0];
  const serials = placements.map(p => p.serial);
  // De-duplicated: three machines off EZ-P10 is one skid and one carton, not
  // the same number printed three times.
  const skidSummary = [...new Set(placements.map(p => p.skid).filter(Boolean))].join(', ');
  const cartonSummary = [...new Set(placements.map(p => p.masterCarton ?? '—'))].join(', ');

  const handleSend = async () => {
    if (!ready) return;
    setBusy(true); setError(null); setSendWarning(null);
    setSentFrom(null); setSentDocs(null); setSentFiles(null);
    try {
      // Save first: the edge function reads the label off the queue row rather
      // than taking it from this form, so there is exactly one copy of the
      // truth and a half-finished send can be picked up where it stopped.
      await saveEzTransLabel(row.id, {
        carrier,
        tracking_num: tracking.trim(),
        ...(pdf ? { label_pdf: pdf } : {}),
      });
      onLabelSaved?.({ carrier, tracking_num: tracking.trim() });
      // Each document travels only when it was actually edited. Sending a copy
      // of the rendered wording alongside a packing-list edit reads to the edge
      // function as an operator edit of the wording too, which makes it skip
      // the email_templates lookup and mail the built-in default over anything
      // saved in the Templates tab — the edit "not saving" when the mail went.
      const sent = await sendEzTransBooking(
        row.id,
        edited || packingEdited
          ? {
              ...(edited ? { subject: subjectValue, body: bodyValue } : {}),
              ...(packingEdited ? { packing_list: packingValue } : {}),
            }
          : undefined,
      );
      setSendWarning(sent.warning ?? null);
      setSentFrom(sent.from ? { from: sent.from, via: sent.sent_via ?? 'resend' } : null);
      setSentDocs(sent.wording && sent.packing_list
        ? { wording: sent.wording, packingList: sent.packing_list }
        : null);
      setSentFiles(sent.attachments ?? null);
      // What the server says it used, not what this panel meant to send. The
      // two disagreeing is precisely the failure worth recording: an operator
      // asking "did my edit actually go out?" has only the activity trail to
      // answer from, and a trail that reports the intent cannot answer it.
      // Falls back to the panel's own flags for a response that predates the
      // server reporting either.
      const wordingWentEdited = sent.wording ? sent.wording === 'edited' : edited;
      const listWentEdited = sent.packing_list ? sent.packing_list === 'edited' : packingEdited;
      await logAction(
        EZTRANS_SENT_ACTION,
        order.order_ref,
        `Booking confirmation, packing list + ${carrier} label ` +
        `${worksheetGoes ? '+ US pesticide worksheet ' : ''}sent to ${EZTRANS_EMAIL} — ` +
        `${serials.length} unit(s) ${serials.join(', ')}, ` +
        `master carton ${cartonSummary}, ` +
        `tracking ${tracking.trim()}` +
        `${sent.pesticide_worksheet === 'unsigned' ? ' · worksheet UNSIGNED' : ''}` +
        `${sent.combined === false ? ' · label and packing list sent separately' : ''}` +
        `${wordingWentEdited ? ' · wording edited for this order' : ''}` +
        `${listWentEdited ? ' · packing list edited for this order' : ''}` +
        `${sent.sent_via === 'gmail'
            ? ` · sent from ${sent.from ?? 'the sender'} — in their Gmail Sent folder`
            : ' · sent via Resend — no copy in the sender\'s Sent folder'}` +
        `${sent.warning ? ` · ${sent.warning}` : ''}`,
        { entityType: 'order', entityId: order.id, unitSerial: first.serial },
      );
      // An order mailed on its own must not also ride along in the evening's
      // batch. Only meaningful for a row that was confirmed; the mutation is a
      // no-op otherwise, so there is nothing to branch on here.
      try {
        await markEzTransSentOutsideBatch(row.id);
        setBatchSentAt(new Date().toISOString());
        onBatchChanged?.();
      } catch (e) {
        // The email is already away — this is bookkeeping, and losing it must
        // not read as a failed send. Say it next to the success line instead.
        setSendWarning(w => [w, `This order could not be marked as sent for the day batch ` +
          `(${(e as Error).message}) — remove it from today's batch by hand so the 3PL is ` +
          `not emailed the same carton twice.`].filter(Boolean).join(' '));
      }
      setPdf(null);
      setJustSent(new Date().toISOString());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Put this order in today's Goorooship batch.
   *
   *  This is the normal path now: EZ Trans asked for one email a day rather
   *  than one per box, so confirming is what "it ships today" means — the
   *  carrier, the tracking number, the label and the packing list go onto the
   *  queue row, and the button at the bottom of the queue mails every order
   *  confirmed today in a single message.
   *
   *  The packing list travels only when it was edited. Storing a copy of the
   *  rendered template instead would freeze today's wording into the row and
   *  quietly beat a later edit in the Templates tab, which is the same trap
   *  the per-order send avoids by sending the field only when it changed. */
  const handleConfirm = async () => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      const { confirmed_at } = await confirmEzTransOrder(row.id, {
        carrier,
        tracking_num: tracking.trim(),
        ...(pdf ? { label_pdf: pdf } : {}),
        packing_list: packingEdited ? packingValue : null,
      });
      onLabelSaved?.({ carrier, tracking_num: tracking.trim() });
      const files = batchAttachmentFilenames({
        customerName: order.customer_name,
        tracking: tracking.trim(),
        needsWorksheet: worksheetGoes,
      });
      await logAction(
        EZTRANS_BATCH_CONFIRMED_ACTION,
        order.order_ref,
        `Confirmed for the Goorooship day batch — ${serials.length} unit(s) ${serials.join(', ')}, ` +
        `master carton ${cartonSummary}, ${carrier} ${tracking.trim()} · ` +
        `documents ${[files.combined, files.worksheet].filter(Boolean).join(', ')}` +
        `${packingEdited ? ' · packing list edited for this order' : ''}`,
        { entityType: 'order', entityId: order.id, unitSerial: first.serial },
      );
      setPdf(null);
      setConfirmedAt(confirmed_at);
      // confirmEzTransOrder clears the sent stamp, so a corrected shipment
      // rejoins the day's batch rather than staying marked as gone.
      setBatchSentAt(null);
      onBatchChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Pull this order back out of today's batch. The booking itself stands —
   *  carrier, tracking and the label stay on the row. */
  const handleUnconfirm = async () => {
    setBusy(true); setError(null);
    try {
      await unconfirmEzTransOrder(row.id);
      await logAction(
        EZTRANS_BATCH_CONFIRMED_ACTION,
        order.order_ref,
        `Removed from the Goorooship day batch — ${carrier || '—'} ${tracking.trim() || '—'}. ` +
        `The booking stands; it is simply not in today's email.`,
        { entityType: 'order', entityId: order.id, unitSerial: first.serial },
      );
      setConfirmedAt(null);
      onBatchChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sentAt = justSent ?? priorSend?.ts ?? null;
  const inBatch = !!confirmedAt && !batchSentAt;
  const batchFiles = batchAttachmentFilenames({
    customerName: order.customer_name,
    tracking: tracking.trim() || '—',
    needsWorksheet: worksheetGoes,
  });

  return (
    <div className={styles.bookingPanel}>
      <div className={styles.labelSectionHead}>EZ Trans shipment (Goorooship)</div>
      <p className={styles.bookingLead}>
        {placements.length === 1
          ? `${first.serial} is`
          : `${placements.length} machines are`} held at EZ Trans
        {skidSummary ? ` on ${skidSummary}` : ''} — book this shipment on
        Goorooship, attach the label it gives you, then send EZ Trans the
        confirmation so they can fulfill {placements.length === 1 ? 'it' : 'them'}.
      </p>

      {offsite.length > 0 && (
        /* Loud, and it disables the send. An order whose machines are split
           between the 3PL and our own floor is not one Goorooship shipment,
           and the way that goes wrong is silent: EZ Trans picks what they
           hold, the box leaves short, and nothing says so until the customer
           counts. Either move the stock or split the order. */
        <p className={styles.bookingWarning}>
          ⚠ {offsite.length} of this order's {row.assigned_serials.length} machines
          {offsite.length === 1 ? ' is' : ' are'} not held at EZ Trans: {offsite.join(', ')}.
          EZ Trans cannot pick {offsite.length === 1 ? 'it' : 'them'}, so this booking is
          blocked — move the stock to EZ Trans, or ship those units separately.
        </p>
      )}

      <ol className={styles.bookingSteps}>
        <li>
          <div className={styles.bookingStepRow}>
            <a
              href={GOOROOSHIP_SHIP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.extLinkBtn}
            >Goorooship — Book a shipment ↗</a>
            <span className={styles.bookingHint}>Book it first — the email says it is already booked.</span>
          </div>
        </li>

        <li>
          <span className={styles.bookingStepTitle}>Attach the label Goorooship issued</span>
          <div className={styles.bookingForm}>
            <label>
              Carrier:
              <select value={carrier} onChange={e => setCarrier(e.target.value)}>
                <option value="">— select —</option>
                {QUEUE_CARRIERS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>

            <label>
              Tracking number:
              <input
                type="text"
                value={tracking}
                onChange={e => setTracking(e.target.value)}
                placeholder="Paste from the Goorooship label"
              />
            </label>

            <label>
              Shipping label PDF:
              {pdf ? (
                <span className={styles.bookingFile}>
                  {pdf.name} · {(pdf.size / 1024).toFixed(0)} KB
                  <button type="button" onClick={() => setPdf(null)}>Remove</button>
                </span>
              ) : (
                <input
                  type="file"
                  accept="application/pdf"
                  onChange={e => setPdf(e.target.files?.[0] ?? null)}
                />
              )}
            </label>
            {labelOnFile && !pdf && (
              <span className={styles.bookingHint}>
                A label is already on this order — pick a file only to replace it.
              </span>
            )}
          </div>
        </li>

        <li>
          <span className={styles.bookingStepTitle}>
            Confirm it for today's batch
          </span>
          <div className={styles.bookingStepRow}>
            <button className={styles.confirmBtn} onClick={handleConfirm} disabled={!ready || busy}>
              {busy
                ? 'Saving…'
                : inBatch
                  ? '✓ Update this order in today’s batch'
                  : '✓ Confirm carrier, tracking + packing list'}
            </button>
            <button
              type="button"
              className={styles.bookingPreviewToggle}
              onClick={() => setShowPreview(v => !v)}
            >{showPreview
              ? 'Hide email'
              : edited || packingEdited
                ? 'Show edited email + packing list'
                : 'Preview / edit email + packing list'}</button>
            {starterGap ? (
              <span className={styles.bookingHint}>
                The compost starter comes first — order it and paste the Amazon
                tracking number in the card above. Once this email goes out the
                3PL has the carton, and there is no adding a starter to it then.
              </span>
            ) : !ready ? (
              <span className={styles.bookingHint}>
                Carrier, tracking number and the label PDF are all required before this
                order can join a batch.
              </span>
            ) : (
              <span className={styles.bookingHint}>
                Confirming adds it to today's Goorooship email — sent from the button at
                the bottom of the queue.{worksheetGoes
                  ? ' This is a US entry — the signed pesticide worksheet goes with it,'
                    + ' for the 3PL to upload for the broker rather than pack.'
                  : ''}
              </span>
            )}
          </div>

          {batchSentAt ? (
            <div className={styles.bookingSent}>
              ✓ Went out in the Goorooship batch of {new Date(batchSentAt).toLocaleString()}.
              Confirm again only to send a correction.
            </div>
          ) : inBatch ? (
            <div className={styles.bookingBatchChip}>
              <span>
                ✓ In today's batch since {new Date(confirmedAt as string).toLocaleTimeString()} —
                it goes out with {batchFiles.combined}
                {batchFiles.worksheet ? ` and ${batchFiles.worksheet}` : ''}.
              </span>
              <button
                type="button"
                className={styles.bookingPreviewToggle}
                onClick={handleUnconfirm}
                disabled={busy}
              >Remove from today's batch</button>
            </div>
          ) : null}
        </li>

        <li>
          {/* The old path, kept but demoted. EZ Trans wants one email a day,
              and an order mailed on its own is one the picker has to reconcile
              against the batch by hand — but a single rush shipment at 6pm is
              a real thing, so the button stays where it always was. Sending
              here also stamps the row as sent, so it cannot go out twice. */}
          <span className={styles.bookingStepTitle}>Or send this one order on its own</span>
          <div className={styles.bookingStepRow}>
            <button
              type="button"
              className={styles.bookingPreviewToggle}
              onClick={handleSend}
              disabled={!ready || busy}
            >
              {busy ? 'Sending…' : sentAt ? `✉ Resend to ${EZTRANS_EMAIL} now` : `✉ Send to ${EZTRANS_EMAIL} now`}
            </button>
            <span className={styles.bookingHint}>
              {starterGap
                ? 'Blocked for the same reason — the starter has to be ordered first.'
                : 'For a rush shipment that cannot wait for the end-of-day email.'}
            </span>
          </div>
        </li>
      </ol>

      <dl className={styles.bookingFacts}>
        {/* One row per machine. A single "Serial No" line was how an order
            for three read as an order for one. */}
        <div>
          <dt>{placements.length === 1 ? 'Serial No' : `Serial Nos (${placements.length})`}</dt>
          <dd>
            {placements.map(p => (
              <div key={p.serial}>
                {p.serial} — master carton {p.masterCarton ?? '— (no pallet on record)'}
              </div>
            ))}
          </dd>
        </div>
        <div><dt>Quantity</dt><dd>{placements.length}</dd></div>
        <div><dt>Ship to</dt><dd>{order.customer_name}</dd></div>
        {/* Named rather than counted: on a UPS booking a third document goes
            to the broker, and an operator should not have to open the sent
            mail to find out whether it did. */}
        <div><dt>Attached</dt><dd>{attachments.join(', ')}</dd></div>
        {/* Named rather than implied: the 3PL's group address is on here at
            their own request, and the operator should be able to see who the
            booking reaches without opening the sent mail to find out. */}
        <div><dt>Copied</dt><dd>{EZTRANS_CC.join(', ')}</dd></div>
      </dl>

      {sentAt && (
        <div className={styles.bookingSent}>
          ✓ Confirmation, packing list and label sent to {EZTRANS_EMAIL} at {new Date(sentAt).toLocaleString()}.
          {sentFiles && <div>Attached: {sentFiles.join(', ')}</div>}
          {sentDocs && (
            <div>
              Packing list: {sentDocs.packingList === 'edited' ? 'your edit for this order' : 'the saved template'}
              {' · '}Wording: {sentDocs.wording === 'edited' ? 'your edit for this order' : 'the saved template'}
            </div>
          )}
          {sentFrom && (
            <div>
              {sentFrom.via === 'gmail'
                ? `Sent from ${sentFrom.from} — it is in that mailbox's Sent folder.`
                : `Sent from ${sentFrom.from} via Resend — there is no copy in that mailbox's Sent folder.`}
            </div>
          )}
        </div>
      )}
      {sendWarning && <div className={styles.bookingWarning}>⚠ {sendWarning}</div>}
      {error && <div className={styles.error}>{error}</div>}

      {showPreview && (
        <>
          <div className={styles.bookingPreviewHead}>
            <span className={styles.bookingPreviewLabel}>Email to {EZTRANS_EMAIL}</span>
            {editing ? (
              <>
                <button
                  type="button"
                  className={styles.bookingPreviewToggle}
                  onClick={() => { setEditedSubject(null); setEditedBody(null); }}
                  disabled={!edited}
                >Reset to {templateSource === 'template' ? 'template' : 'default'}</button>
                <button
                  type="button"
                  className={styles.bookingPreviewToggle}
                  onClick={() => setEditing(false)}
                >Done editing</button>
              </>
            ) : (
              <button
                type="button"
                className={styles.bookingPreviewToggle}
                onClick={() => setEditing(true)}
              >Edit this one</button>
            )}
            <span className={styles.bookingHint}>
              {edited
                ? 'Edited for this order only — the saved wording is unchanged.'
                : templateSource === 'template'
                  ? <>Wording comes from <Link to="/templates">Templates → EZ Trans booking confirmation</Link>.</>
                  : 'Wording is the built-in default — no template row in this environment yet.'}
            </span>
          </div>

          {editing ? (
            <div className={styles.bookingEditor}>
              <label>
                Subject:
                <input
                  type="text"
                  value={subjectValue}
                  onChange={e => setEditedSubject(e.target.value)}
                />
              </label>
              <label>
                Body:
                <textarea
                  ref={bodyRef}
                  value={bodyValue}
                  onChange={e => setEditedBody(e.target.value)}
                  spellCheck
                />
              </label>
              <span className={styles.bookingHint}>
                The label and the packing list are merged into one attached PDF
                automatically{worksheetGoes ? ', and US shipments carry the pesticide worksheet too' : ''}.
                The packing list is edited separately, below.
              </span>
            </div>
          ) : (
            <pre className={styles.bookingPreview}>
              {`Subject: ${subjectValue}\n` +
               `Attachments: ${attachments.join(' · ')}\n\n` +
               bodyValue}
            </pre>
          )}

          <div className={styles.bookingPreviewHead}>
            <span className={styles.bookingPreviewLabel}>Attached packing list (PDF)</span>
            {editingPacking ? (
              <>
                <button
                  type="button"
                  className={styles.bookingPreviewToggle}
                  onClick={() => setEditedPacking(null)}
                  disabled={!packingEdited}
                >Reset packing list</button>
                <button
                  type="button"
                  className={styles.bookingPreviewToggle}
                  onClick={() => setEditingPacking(false)}
                >Done editing</button>
              </>
            ) : (
              <button
                type="button"
                className={styles.bookingPreviewToggle}
                onClick={() => setEditingPacking(true)}
              >Edit packing list</button>
            )}
            <span className={styles.bookingHint}>
              {packingEdited
                ? 'Edited for this order only — the saved packing list is unchanged.'
                : 'Start a line with # for the title and ## for a section heading.'}
            </span>
          </div>

          {editingPacking ? (
            <div className={styles.bookingEditor}>
              <label>
                Packing list:
                <textarea
                  ref={packingRef}
                  value={packingValue}
                  onChange={e => setEditedPacking(e.target.value)}
                  spellCheck
                />
              </label>
              <span className={styles.bookingHint}>
                Shown as EZ Trans will read it, with this order's details already
                filled in. Start a line with # for the title, ## for a heading.
              </span>
            </div>
          ) : (
            // Previews packingValue, not the template: an edit must be visible
            // here, since this is where an operator checks their work.
            <pre className={styles.bookingPreview}>{packingListPreview(packingValue)}</pre>
          )}

          {worksheetGoes && (
            <>
              <div className={styles.bookingPreviewHead}>
                <span className={styles.bookingPreviewLabel}>Attached US pesticide worksheet (PDF)</span>
                <span className={styles.bookingHint}>
                  Built and signed on send. Not editable — it is a FIFRA
                  declaration to CBP, so its wording is fixed in code.
                </span>
              </div>
              <dl className={styles.bookingFacts}>
                {pesticideWorksheetSummary({
                  orderRef: order.order_ref,
                  serials,
                  tracking: tracking.trim() || null,
                }).map(f => (
                  <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>
                ))}
              </dl>
            </>
          )}
        </>
      )}
    </div>
  );
}
