# UPS pesticide worksheet

UPS Supply Chain Solutions brokers our US entries, and will not act as importer
of record on one that prompts for an EPA-regulated pesticide or pesticide
device without a FIFRA worksheet on file. Every LILA Pro gets the same answer —
it is a kitchen appliance, not a pesticide device — so the form used to be
filled in by hand, one PDF per tracking number, and attached to the EZ Trans
booking manually.

It is now built and attached automatically. When a Fulfillment → Queue step-3
EZ Trans booking is going **to the US**,
[`send-eztrans-booking`](../supabase/functions/send-eztrans-booking/index.ts)
(and [`send-eztrans-daily-batch`](../supabase/functions/send-eztrans-daily-batch/index.ts)
for the day batch) attaches `pesticide-worksheet-<order>.pdf` alongside the
merged shipping label + packing list.

## The rule is the destination, not the carrier

`needsPesticideWorksheet` keyed on `carrier === 'UPS'` until 2026-10-02, because
UPS Supply Chain Solutions is who asks for the form. Every US shipment booked so
far has in fact been UPS, so the two rules agreed in practice and nothing was
ever missed — but a US shipment booked on any other carrier would have gone with
no worksheet at all, and five domestic Canadian moves that happened to be on UPS
carried a US customs declaration for an entry that never happens. It keys on
`orders.country === 'US'` now, and takes the order rather than a bare string so a
stale `(carrier)` call site fails `tsc -b` instead of silently asking the wrong
question.

## Attaching it is not the same as filing it

#1270 (`1Z2985EADK99477145`) and #1279 (`1Z2985EADK97550836`) both went out with
a correctly-built, correctly-named worksheet attached, and UPS held both entries
anyway: "Your shipment has been held due to a possible Pesticide or Pesticide
Device… Please complete and upload the attached form for clearance."

Everything else in that email is paperwork for a carton — print the label, tape
it to the box, pick from the packing list — so that is what the worksheet was
taken for. It was never uploaded to the shipment on Goorooship or passed to UPS
brokerage, and two days later the form had to be sent by hand while the boxes sat
in a UPS warehouse accruing storage fees.

So `attachmentsNote` / `batchAttachmentsNote` now say what to *do* with it, in
the body of the email: it is a customs document, upload it to the shipment and
pass it to UPS brokerage, do not print it or tape it to the box. The filename
alone was not instruction enough.

## What varies per shipment

| Field | Source |
| --- | --- |
| Shipment number | `fulfillment_queue.tracking_num` |
| Description of goods | The fixed product sentence + the serial, batch/lot, quantity and order reference |
| Date (both the header and the certification) | The day the booking is sent — i.e. the day the label and tracking number were attached |

Everything else is constant and lives in
[`_shared/pesticideWorksheet.ts`](../supabase/functions/_shared/pesticideWorksheet.ts):
part number `LILA-P100X (LILA Pro)` and tariff number `8509.80.5095`. Both were
checked against the worksheets filed by hand for `1Z2985EADK93221574`,
`1Z2985EADK98518192` and `1Z2985EADK98125759` — identical on all three, because
they are properties of the product and not of the shipment.

## The worksheet is not a template

The booking email and the packing list are operator-editable in the Templates
tab. This document deliberately is not. It is a declaration to CBP carrying a
real signature, and the line under the checkbox says that falsely claiming the
product is not a regulated pesticide "may result in CBP penalties". Changing
what it asserts should be a commit with a reviewer, not a text box. The panel
shows a read-only summary of the fields it was filled with so an operator can
check the tracking number and serial before it goes.

## The signature

`company-assets/signatures/huayi-gao.png` — a **private** Supabase bucket, read
by the edge function with the service role.

It is not in this repo, and must not be: the repo is public, and a real
person's handwritten signature in a public git history is forgery material that
cannot be taken back.

To replace it, upload a new PNG to that path. Requirements, enforced by
[`pngToPdfImage`](../supabase/functions/_shared/pngToPdfImage.ts), which
re-wraps the PNG's own compressed bytes as a PDF image rather than decoding it:

- 8-bit, non-interlaced
- greyscale or RGB, **no alpha channel** — flatten onto white
- ink cropped close to the edges; it is drawn 130pt wide above the signature rule

If the asset cannot be read, the worksheet is still built and sent, unsigned,
and the send reports a warning saying so — a form the operator can sign by hand
beats a shipment held up by a missing file. The activity-log entry records
`worksheet UNSIGNED` in that case.

## The merged attachment

The shipping label and the packing list go out as one PDF, label first: EZ Trans
prints the attachment and tapes it to the carton, and two files is one chance to
print only half of it. The merge is the one remote dependency in the PDF path
([pdf-lib](../supabase/functions/_shared/pdfMerge.ts)) because carrier labels are
arbitrary PDFs. If it fails, the two documents are sent separately with a
warning rather than either being dropped.
