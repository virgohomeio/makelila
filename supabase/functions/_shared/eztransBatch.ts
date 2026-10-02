// The end-of-day EZ Trans email: every order confirmed for Goorooship today,
// in one message.
//
// The per-order path (send-eztrans-booking) mails the 3PL as each box is
// booked. EZ Trans asked for the opposite: one email a day carrying every
// shipment scheduled for that day, because a picker working a stack of ten
// boxes from ten separate emails loses one. So step 3 now *confirms* an order
// — carrier, tracking number, label and packing list onto the queue row — and
// the confirmed rows accumulate until someone presses the button at the bottom
// of the queue.
//
// What the 3PL receives per order is unchanged in substance: the shipping
// label and the packing list merged into one PDF, plus the FIFRA pesticide
// worksheet as its own file on a UPS booking. What changed is the naming.
// Ten orders in one email means "packing-list-1184.pdf" is no longer enough
// to tell a picker which box a worksheet belongs to, so every attachment is
// named for the customer and the tracking number.
//
// These strings are the built-in default. The `eztrans_daily_batch` row in
// email_templates overrides them, and eztransBatch.test.ts asserts the two
// stay byte-identical so an environment that has not run the migration sends
// the same words as one that has.

export const EZTRANS_BATCH_TEMPLATE_KEY = 'eztrans_daily_batch';

/** The activity_log type written after a daily batch goes out. */
export const EZTRANS_BATCH_SENT_ACTION = 'fq_eztrans_batch_sent';

/** The activity_log type written when an order joins the day's batch. */
export const EZTRANS_BATCH_CONFIRMED_ACTION = 'fq_eztrans_batch_confirmed';

export const DEFAULT_EZTRANS_BATCH_SUBJECT =
  'Orders to fulfill — {{date}} · {{order_count}} shipment(s)';

export const DEFAULT_EZTRANS_BATCH_BODY =
  'Hello EZ Trans team,\n' +
  '\n' +
  'These are the orders booked on Goorooship for {{date}}. All of them are ' +
  'ready to be picked and handed to the carrier. {{attachments_note}}\n' +
  '\n' +
  '{{orders_block}}\n' +
  '\n' +
  'Please reply to confirm once the units are picked and the shipments are on their way.\n' +
  '\n' +
  'Thank you,\n' +
  'The VCycene Team';

/** Every variable the batch wording may use. Also what the Templates tab
 *  lists, so an operator editing the copy can see what they can reach for. */
export const EZTRANS_BATCH_TEMPLATE_VARIABLES = [
  'date', 'order_count', 'orders_block', 'attachments_note',
] as const;

/** What names the attachments for one order.
 *
 *  The customer and the tracking number, because that is what a picker holding
 *  a box can read off the label. An order reference is meaningless at the 3PL
 *  and a serial is inside the carton. */
export function batchAttachmentSlug(customerName: string, tracking: string): string {
  const clean = (s: string) => s
    .normalize('NFKD')
    // Drop combining marks so "Bérubé" becomes "Berube" rather than "Berube"
    // with the accents silently turning into hyphens.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const name = clean(customerName).slice(0, 60);
  const track = clean(tracking).slice(0, 40);
  // Neither half is ever empty in practice — the send refuses an order with no
  // tracking number — but a name of only punctuation should not produce a file
  // called "-.pdf".
  return [name, track].filter(Boolean).join('-') || 'order';
}

/** The two documents one order contributes to the batch.
 *
 *  `combined` is the label and the packing list as one file, label first —
 *  the 3PL prints it and tapes page one to the carton. `worksheet` is the
 *  FIFRA declaration, which UPS Supply Chain Solutions brokers US entries
 *  with; it stays a separate file because it goes to the broker, not on the
 *  box, and both carry the customer + tracking so neither has to be opened to
 *  find out which shipment it belongs to. */
export function batchAttachmentFilenames(args: {
  customerName: string; tracking: string; needsWorksheet: boolean;
}): { combined: string; worksheet: string | null } {
  const slug = batchAttachmentSlug(args.customerName, args.tracking);
  return {
    combined: `label-and-packing-list-${slug}.pdf`,
    worksheet: args.needsWorksheet ? `pesticide-worksheet-${slug}.pdf` : null,
  };
}

/** Make every filename in a batch unique.
 *
 *  Two orders to the same customer on the same tracking number cannot happen,
 *  but two attachments with the same name in one email can silently become one
 *  in some mail clients — a lost shipping label. A numeric suffix is cheap
 *  insurance, and never fires in the normal case. */
export function dedupeFilenames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map(name => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n === 1) return name;
    const dot = name.lastIndexOf('.');
    return dot < 0 ? `${name}-${n}` : `${name.slice(0, dot)}-${n}${name.slice(dot)}`;
  });
}

/** One order as it reads in the body of the batch email. */
export type EzTransBatchLine = {
  orderRef: string;
  customerName: string;
  address: string;
  serial: string;
  masterCarton: string;
  carrier: string;
  tracking: string;
  /** Filenames this order contributed, in the order they are attached. */
  documents: string[];
};

/** The numbered list of shipments that fills {{orders_block}}.
 *
 *  Plain text and numbered, because it is read next to a stack of cartons: the
 *  count at the top of the message and the count in this list have to agree at
 *  a glance, and a picker ticks them off one at a time. */
export function batchOrdersBlock(lines: EzTransBatchLine[]): string {
  return lines.map((l, i) => [
    `${i + 1}. ${l.customerName} — ${l.orderRef}`,
    `   Ship to: ${l.address}`,
    `   Product: LILA Kitchen Composter · Serial ${l.serial} · Master carton ${l.masterCarton}`,
    `   Carrier: ${l.carrier} · Tracking: ${l.tracking}`,
    `   Documents: ${l.documents.join(', ')}`,
  ].join('\n')).join('\n\n');
}

/** The {{attachments_note}} sentence for a batch: how to read a pile of
 *  attachments that belong to several different boxes. */
export function batchAttachmentsNote(orderCount: number, worksheetCount: number): string {
  const base =
    `Each of the ${orderCount} order${orderCount === 1 ? '' : 's'} below has one attached PDF ` +
    `holding its shipping label and its packing list — the shipping label is the first page. ` +
    `Every file is named for the customer and the tracking number it belongs to.`;
  if (worksheetCount === 0) return base;
  return `${base} ${worksheetCount} of them ship UPS and carry a separate signed pesticide ` +
    `worksheet for the broker, named the same way.`;
}
