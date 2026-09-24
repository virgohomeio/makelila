import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  buildEzTransBooking,
  saveEzTransLabel,
  sendEzTransBooking,
  useEzTransPlacement,
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
import { logAction, useActivityForEntity } from '../../../lib/activityLog';
import type { FulfillmentQueueRow } from '../../../lib/fulfillment';
import styles from '../Fulfillment.module.css';

export type EzTransOrder = EzTransShipTo & { id: string; order_ref: string };

const CARRIERS = ['UPS', 'FedEx', 'Purolator', 'Canada Post', 'Canpar', 'GLS'] as const;

/** The Goorooship half of step 3.
 *
 *  Stock on our own floor is booked through Freightcom. Stock held at the
 *  EZTrans 3PL is booked through Goorooship, and EZ Trans only picks the box
 *  once we email them a confirmation with a packing list and the label they
 *  are to print — so this panel only renders when the unit assigned at step 1
 *  is actually sitting at EZTrans. It renders nothing at all otherwise.
 *
 *  The label details captured here are the same three fields the Freightcom
 *  card below asks for, written to the same queue-row columns, so nothing has
 *  to be typed twice: `onLabelSaved` hands them up to StepLabel, which leaves
 *  Confirm label as a single click. */
export function EzTransPanel({
  row,
  order,
  onLabelSaved,
}: {
  row: FulfillmentQueueRow;
  order: EzTransOrder;
  onLabelSaved?: (v: { carrier: string; tracking_num: string }) => void;
}) {
  const { placement, loading } = useEzTransPlacement(row.assigned_serial);
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
  const { entries } = useActivityForEntity({ entityType: 'order', entityId: order.id, limit: 50 });
  const priorSend = entries.find(e => e.type === EZTRANS_SENT_ACTION) ?? null;

  // A label uploaded on an earlier pass is still on the row, so a resend (or a
  // corrected tracking number) doesn't force the operator to find the file again.
  const labelOnFile = !!row.label_pdf_path;
  const ready = !!carrier && !!tracking.trim() && (!!pdf || labelOnFile);

  // UPS brokers its own US entries and needs a FIFRA worksheet with them, so
  // one is built and attached on those bookings only. Decided by the same
  // helper the edge function uses, so this cannot promise a document the send
  // does not attach.
  const worksheetGoes = needsPesticideWorksheet(carrier);
  const attachments = attachmentFilenames(order.order_ref, carrier);

  const booking = useMemo(() => {
    if (!placement) return null;
    return buildEzTransBooking({
      order,
      serial: placement.serial,
      masterCarton: placement.masterCarton,
      carrier: carrier || null,
      tracking: tracking.trim() || null,
      template,
      packingListTemplate,
    });
  }, [order, placement, carrier, tracking, template, packingListTemplate]);

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

  if (loading || !placement || !booking) return null;

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
      const sent = await sendEzTransBooking(
        row.id,
        edited || packingEdited
          ? {
              subject: subjectValue,
              body: bodyValue,
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
      await logAction(
        EZTRANS_SENT_ACTION,
        order.order_ref,
        `Booking confirmation, packing list + ${carrier} label ` +
        `${worksheetGoes ? '+ UPS pesticide worksheet ' : ''}sent to ${EZTRANS_EMAIL} — ` +
        `serial ${placement.serial}, master carton ${placement.masterCarton ?? '—'}, ` +
        `tracking ${tracking.trim()}` +
        `${sent.pesticide_worksheet === 'unsigned' ? ' · worksheet UNSIGNED' : ''}` +
        `${sent.combined === false ? ' · label and packing list sent separately' : ''}` +
        `${edited ? ' · wording edited for this order' : ''}` +
        `${packingEdited ? ' · packing list edited for this order' : ''}` +
        `${sent.sent_via === 'gmail'
            ? ` · sent from ${sent.from ?? 'the sender'} — in their Gmail Sent folder`
            : ' · sent via Resend — no copy in the sender\'s Sent folder'}` +
        `${sent.warning ? ` · ${sent.warning}` : ''}`,
        { entityType: 'order', entityId: order.id, unitSerial: placement.serial },
      );
      setPdf(null);
      setJustSent(new Date().toISOString());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sentAt = justSent ?? priorSend?.ts ?? null;

  return (
    <div className={styles.ezTransPanel}>
      <div className={styles.labelSectionHead}>EZ Trans shipment (Goorooship)</div>
      <p className={styles.ezTransLead}>
        {placement.serial} is held at EZ Trans
        {placement.skid ? ` on ${placement.skid}` : ''} — book this shipment on
        Goorooship, attach the label it gives you, then send EZ Trans the
        confirmation so they can fulfill it.
      </p>

      <ol className={styles.ezTransSteps}>
        <li>
          <div className={styles.ezTransStepRow}>
            <a
              href={GOOROOSHIP_SHIP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.extLinkBtn}
            >Goorooship — Book a shipment ↗</a>
            <span className={styles.ezTransHint}>Book it first — the email says it is already booked.</span>
          </div>
        </li>

        <li>
          <span className={styles.ezTransStepTitle}>Attach the label Goorooship issued</span>
          <div className={styles.ezTransForm}>
            <label>
              Carrier:
              <select value={carrier} onChange={e => setCarrier(e.target.value)}>
                <option value="">— select —</option>
                {CARRIERS.map(c => <option key={c} value={c}>{c}</option>)}
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
                <span className={styles.ezTransFile}>
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
              <span className={styles.ezTransHint}>
                A label is already on this order — pick a file only to replace it.
              </span>
            )}
          </div>
        </li>

        <li>
          <div className={styles.ezTransStepRow}>
            <button className={styles.confirmBtn} onClick={handleSend} disabled={!ready || busy}>
              {busy ? 'Sending…' : sentAt ? `✉ Resend to ${EZTRANS_EMAIL}` : `✉ Send confirmation to ${EZTRANS_EMAIL}`}
            </button>
            <button
              type="button"
              className={styles.ezTransPreviewToggle}
              onClick={() => setShowPreview(v => !v)}
            >{showPreview
              ? 'Hide email'
              : edited || packingEdited
                ? 'Show edited email + packing list'
                : 'Preview / edit email + packing list'}</button>
            {!ready ? (
              <span className={styles.ezTransHint}>
                Carrier, tracking number and the label PDF are all required before this can be sent.
              </span>
            ) : worksheetGoes ? (
              <span className={styles.ezTransHint}>
                UPS brokers this entry — the signed pesticide worksheet is attached too.
              </span>
            ) : null}
          </div>
        </li>
      </ol>

      <dl className={styles.ezTransFacts}>
        <div><dt>Serial No</dt><dd>{placement.serial}</dd></div>
        <div><dt>Master carton</dt><dd>{placement.masterCarton ?? '— (no pallet on record)'}</dd></div>
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
        <div className={styles.ezTransSent}>
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
      {sendWarning && <div className={styles.ezTransWarning}>⚠ {sendWarning}</div>}
      {error && <div className={styles.error}>{error}</div>}

      {showPreview && (
        <>
          <div className={styles.ezTransPreviewHead}>
            <span className={styles.ezTransPreviewLabel}>Email to {EZTRANS_EMAIL}</span>
            {editing ? (
              <>
                <button
                  type="button"
                  className={styles.ezTransPreviewToggle}
                  onClick={() => { setEditedSubject(null); setEditedBody(null); }}
                  disabled={!edited}
                >Reset to {templateSource === 'template' ? 'template' : 'default'}</button>
                <button
                  type="button"
                  className={styles.ezTransPreviewToggle}
                  onClick={() => setEditing(false)}
                >Done editing</button>
              </>
            ) : (
              <button
                type="button"
                className={styles.ezTransPreviewToggle}
                onClick={() => setEditing(true)}
              >Edit this one</button>
            )}
            <span className={styles.ezTransHint}>
              {edited
                ? 'Edited for this order only — the saved wording is unchanged.'
                : templateSource === 'template'
                  ? <>Wording comes from <Link to="/templates">Templates → EZ Trans booking confirmation</Link>.</>
                  : 'Wording is the built-in default — no template row in this environment yet.'}
            </span>
          </div>

          {editing ? (
            <div className={styles.ezTransEditor}>
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
              <span className={styles.ezTransHint}>
                The label and the packing list are merged into one attached PDF
                automatically{worksheetGoes ? ', and UPS shipments carry the pesticide worksheet too' : ''}.
                The packing list is edited separately, below.
              </span>
            </div>
          ) : (
            <pre className={styles.ezTransPreview}>
              {`Subject: ${subjectValue}\n` +
               `Attachments: ${attachments.join(' · ')}\n\n` +
               bodyValue}
            </pre>
          )}

          <div className={styles.ezTransPreviewHead}>
            <span className={styles.ezTransPreviewLabel}>Attached packing list (PDF)</span>
            {editingPacking ? (
              <>
                <button
                  type="button"
                  className={styles.ezTransPreviewToggle}
                  onClick={() => setEditedPacking(null)}
                  disabled={!packingEdited}
                >Reset packing list</button>
                <button
                  type="button"
                  className={styles.ezTransPreviewToggle}
                  onClick={() => setEditingPacking(false)}
                >Done editing</button>
              </>
            ) : (
              <button
                type="button"
                className={styles.ezTransPreviewToggle}
                onClick={() => setEditingPacking(true)}
              >Edit packing list</button>
            )}
            <span className={styles.ezTransHint}>
              {packingEdited
                ? 'Edited for this order only — the saved packing list is unchanged.'
                : 'Start a line with # for the title and ## for a section heading.'}
            </span>
          </div>

          {editingPacking ? (
            <div className={styles.ezTransEditor}>
              <label>
                Packing list:
                <textarea
                  ref={packingRef}
                  value={packingValue}
                  onChange={e => setEditedPacking(e.target.value)}
                  spellCheck
                />
              </label>
              <span className={styles.ezTransHint}>
                Shown as EZ Trans will read it, with this order's details already
                filled in. Start a line with # for the title, ## for a heading.
              </span>
            </div>
          ) : (
            // Previews packingValue, not the template: an edit must be visible
            // here, since this is where an operator checks their work.
            <pre className={styles.ezTransPreview}>{packingListPreview(packingValue)}</pre>
          )}

          {worksheetGoes && (
            <>
              <div className={styles.ezTransPreviewHead}>
                <span className={styles.ezTransPreviewLabel}>Attached UPS pesticide worksheet (PDF)</span>
                <span className={styles.ezTransHint}>
                  Built and signed on send. Not editable — it is a FIFRA
                  declaration to CBP, so its wording is fixed in code.
                </span>
              </div>
              <dl className={styles.ezTransFacts}>
                {pesticideWorksheetSummary({
                  orderRef: order.order_ref,
                  serial: placement.serial,
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
