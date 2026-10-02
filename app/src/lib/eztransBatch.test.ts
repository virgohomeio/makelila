// The Goorooship day batch.
//
// Three things are worth pinning down here, because all three are invisible
// until the 3PL is looking at a pile of cartons and the wrong paperwork:
//   1. which orders are in "today" — a UTC day would file a 20:30 confirm in
//      Toronto under tomorrow and leave it out of the email being sent now;
//   2. what every attachment is called — with ten shipments in one message,
//      a filename is the only thing that says which carton a worksheet is for;
//   3. that the wording in the repo, in the edge function and in the migration
//      are the same words.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: { access_token: 't' } } }),
      getUser: () => Promise.resolve({ data: { user: { id: 'u-1' } } }),
    },
  },
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
}));

import {
  batchAttachmentFilenames,
  batchAttachmentSlug,
  batchAttachmentsNote,
  batchOrdersBlock,
  buildDailyBatch,
  dedupeFilenames,
  localDayKey,
  sendEzTransDailyBatch,
  DEFAULT_EZTRANS_BATCH_BODY,
  DEFAULT_EZTRANS_BATCH_SUBJECT,
  EZTRANS_BATCH_TEMPLATE_KEY,
  type EzTransBatchOrder,
  type EzTransBatchQueueRow,
} from './eztransBatch';
import {
  DEFAULT_EZTRANS_BATCH_BODY as SHARED_BODY,
  DEFAULT_EZTRANS_BATCH_SUBJECT as SHARED_SUBJECT,
  EZTRANS_BATCH_TEMPLATE_KEY as SHARED_KEY,
  EZTRANS_BATCH_TEMPLATE_VARIABLES,
} from '../../../supabase/functions/_shared/eztransBatch.ts';

const MIGRATION = Object.values(
  import.meta.glob('../../../supabase/migrations/*_eztrans_daily_batch.sql', {
    query: '?raw', import: 'default', eager: true,
  }) as Record<string, string>,
).join('\n');

/** A confirmed queue row, with only the fields buildDailyBatch reads. */
function row(over: Partial<EzTransBatchQueueRow> & { id: string }): EzTransBatchQueueRow {
  return {
    order_id: `o-${over.id}`,
    assigned_serial: 'LL01-P100X-00412',
    carrier: 'Purolator',
    tracking_num: `TRK-${over.id}`,
    eztrans_confirmed_at: null,
    eztrans_batch_sent_at: null,
    eztrans_packing_list: null,
    ...over,
  };
}

const ORDERS = new Map<string, EzTransBatchOrder>([
  // Destination, not carrier, is what decides whether a pesticide worksheet
  // rides along — o-a and o-c ship to the US, o-b is domestic.
  ['o-a', { id: 'o-a', order_ref: '#1184', customer_name: 'Juanita M Wells', country: 'US' }],
  ['o-b', { id: 'o-b', order_ref: '#1185', customer_name: 'Marc Bérubé', country: 'CA' }],
  ['o-c', { id: 'o-c', order_ref: '#1186', customer_name: 'Juanita M Wells', country: 'US' }],
]);

/** 14:05 local on the given local calendar day, as an ISO string. */
function localNoonIso(y: number, m: number, d: number): string {
  return new Date(y, m - 1, d, 14, 5, 0).toISOString();
}

describe('which day an order belongs to', () => {
  it('keys on the local calendar date, not UTC', () => {
    // 20:30 local on the 29th. In Toronto that is 00:30 UTC on the 30th, and a
    // UTC key would drop this order out of the batch being sent right now.
    const evening = new Date(2026, 8, 29, 20, 30);
    expect(localDayKey(evening)).toBe('2026-09-29');
  });

  it('is empty for an unparseable timestamp rather than throwing', () => {
    expect(localDayKey('not a date')).toBe('');
  });

  it('only includes orders confirmed today', () => {
    const today = localNoonIso(2026, 9, 29);
    const yesterday = localNoonIso(2026, 9, 28);
    const { pending } = buildDailyBatch(
      [
        row({ id: 'a', order_id: 'o-a', eztrans_confirmed_at: today }),
        row({ id: 'b', order_id: 'o-b', eztrans_confirmed_at: yesterday }),
        row({ id: 'c', order_id: 'o-c' }),
      ],
      ORDERS,
      '2026-09-29',
    );
    expect(pending.map(p => p.orderRef)).toEqual(['#1184']);
  });

  it('separates what already went from what still has to', () => {
    const today = localNoonIso(2026, 9, 29);
    const { pending, sent } = buildDailyBatch(
      [
        row({ id: 'a', order_id: 'o-a', eztrans_confirmed_at: today }),
        row({ id: 'b', order_id: 'o-b', eztrans_confirmed_at: today, eztrans_batch_sent_at: today }),
      ],
      ORDERS,
      '2026-09-29',
    );
    expect(pending.map(p => p.orderRef)).toEqual(['#1184']);
    expect(sent.map(p => p.orderRef)).toEqual(['#1185']);
  });

  it('leaves out a confirmed row that lost its carrier or tracking number', () => {
    const today = localNoonIso(2026, 9, 29);
    const { pending } = buildDailyBatch(
      [
        row({ id: 'a', order_id: 'o-a', eztrans_confirmed_at: today, tracking_num: null }),
        row({ id: 'b', order_id: 'o-b', eztrans_confirmed_at: today, carrier: null }),
      ],
      ORDERS,
      '2026-09-29',
    );
    expect(pending).toEqual([]);
  });
});

describe('what each attachment is called', () => {
  it('is the customer and the tracking number', () => {
    expect(batchAttachmentSlug('Juanita M Wells', '1Z999AA10123456784'))
      .toBe('Juanita-M-Wells-1Z999AA10123456784');
  });

  it('folds accents rather than turning them into hyphens', () => {
    expect(batchAttachmentSlug('Marc Bérubé', 'PUR1')).toBe('Marc-Berube-PUR1');
  });

  it('never produces a file called "-.pdf"', () => {
    expect(batchAttachmentSlug('!!!', '')).toBe('order');
  });

  it('gives a UPS booking a second, separately-named file', () => {
    const f = batchAttachmentFilenames({
      customerName: 'Juanita M Wells', tracking: 'TRK1', needsWorksheet: true,
    });
    expect(f.combined).toBe('label-and-packing-list-Juanita-M-Wells-TRK1.pdf');
    expect(f.worksheet).toBe('pesticide-worksheet-Juanita-M-Wells-TRK1.pdf');
  });

  it('gives everyone else one file', () => {
    expect(batchAttachmentFilenames({
      customerName: 'Juanita M Wells', tracking: 'TRK1', needsWorksheet: false,
    }).worksheet).toBeNull();
  });

  it('never repeats a name inside one email', () => {
    // Two attachments sharing a name can silently become one in some mail
    // clients, and the one lost would be a shipping label.
    expect(dedupeFilenames(['a.pdf', 'a.pdf', 'b.pdf', 'a.pdf']))
      .toEqual(['a.pdf', 'a-2.pdf', 'b.pdf', 'a-3.pdf']);
  });
});

describe('the documents an order contributes', () => {
  const today = localNoonIso(2026, 9, 29);

  it('is one merged PDF, plus the worksheet only on a US shipment', () => {
    const { pending } = buildDailyBatch(
      [
        row({ id: 'a', order_id: 'o-a', eztrans_confirmed_at: today, carrier: 'UPS', tracking_num: 'U1' }),
        row({ id: 'b', order_id: 'o-b', eztrans_confirmed_at: today, carrier: 'Purolator', tracking_num: 'P1' }),
      ],
      ORDERS,
      '2026-09-29',
    );
    expect(pending[0].worksheet).toBe(true);
    expect(pending[0].documents).toEqual([
      'label-and-packing-list-Juanita-M-Wells-U1.pdf',
      'pesticide-worksheet-Juanita-M-Wells-U1.pdf',
    ]);
    expect(pending[1].worksheet).toBe(false);
    expect(pending[1].documents).toEqual(['label-and-packing-list-Marc-Berube-P1.pdf']);
  });

  // A US shipment booked on a Canadian carrier still crosses the border and
  // still prompts the FIFRA question at the entry. Keying the worksheet off the
  // carrier would have sent this one with nothing.
  it('goes on a US shipment regardless of who carries it', () => {
    const { pending } = buildDailyBatch(
      [row({ id: 'a', order_id: 'o-a', eztrans_confirmed_at: today, carrier: 'GLS', tracking_num: 'G1' })],
      ORDERS,
      '2026-09-29',
    );
    expect(pending[0].worksheet).toBe(true);
    expect(pending[0].documents).toContain('pesticide-worksheet-Juanita-M-Wells-G1.pdf');
  });

  it('stays off a Canadian shipment booked on UPS', () => {
    const { pending } = buildDailyBatch(
      [row({ id: 'b', order_id: 'o-b', eztrans_confirmed_at: today, carrier: 'UPS', tracking_num: 'U9' })],
      ORDERS,
      '2026-09-29',
    );
    expect(pending[0].worksheet).toBe(false);
    expect(pending[0].documents).toEqual(['label-and-packing-list-Marc-Berube-U9.pdf']);
  });

  it('stays matched to the right order when an earlier one carried two files', () => {
    // The cursor walking the deduped name list is the whole risk here: get it
    // wrong by one and a customer's worksheet is filed under someone else's
    // label.
    const { pending } = buildDailyBatch(
      [
        row({ id: 'a', order_id: 'o-a', eztrans_confirmed_at: today, carrier: 'UPS', tracking_num: 'U1' }),
        row({ id: 'b', order_id: 'o-c', eztrans_confirmed_at: today, carrier: 'UPS', tracking_num: 'U2' }),
        row({ id: 'c', order_id: 'o-b', eztrans_confirmed_at: today, carrier: 'FedEx', tracking_num: 'F1' }),
      ],
      ORDERS,
      '2026-09-29',
    );
    expect(pending.map(p => p.documents)).toEqual([
      ['label-and-packing-list-Juanita-M-Wells-U1.pdf', 'pesticide-worksheet-Juanita-M-Wells-U1.pdf'],
      ['label-and-packing-list-Juanita-M-Wells-U2.pdf', 'pesticide-worksheet-Juanita-M-Wells-U2.pdf'],
      ['label-and-packing-list-Marc-Berube-F1.pdf'],
    ]);
  });

  it('says when a packing list was edited for one order', () => {
    const { pending } = buildDailyBatch(
      [row({ id: 'a', order_id: 'o-a', eztrans_confirmed_at: today, eztrans_packing_list: '# PICK' })],
      ORDERS,
      '2026-09-29',
    );
    expect(pending[0].packingListEdited).toBe(true);
  });
});

describe('the body of the batch email', () => {
  it('numbers the shipments and names their documents', () => {
    const block = batchOrdersBlock([{
      orderRef: '#1184',
      customerName: 'Juanita M Wells',
      address: '14 Grenfell Drive, Wabush, NL, A0R 1B0, CA',
      serial: 'LL01-P100X-00412',
      masterCarton: '1',
      carrier: 'UPS',
      tracking: 'U1',
      documents: ['a.pdf', 'b.pdf'],
    }]);
    expect(block).toContain('1. Juanita M Wells — #1184');
    expect(block).toContain('Tracking: U1');
    expect(block).toContain('Documents: a.pdf, b.pdf');
  });

  it('mentions the worksheets only when some are going', () => {
    expect(batchAttachmentsNote(3, 0)).not.toMatch(/pesticide/);
    expect(batchAttachmentsNote(3, 2)).toMatch(/2 of them ship to the US/);
  });

  // #1279 went out in a batch with its worksheet attached and UPS held the
  // entry anyway: the note read as a description of carton paperwork, so the
  // 3PL never uploaded the form for clearance.
  it('tells the 3PL to upload the worksheets rather than pack them', () => {
    const note = batchAttachmentsNote(4, 2);
    expect(note).toMatch(/upload/i);
    expect(note).toMatch(/customs document/i);
    expect(note).toMatch(/do not print/i);
    expect(note).toMatch(/brokerage/i);
  });
});

describe('the built-in default does not drift', () => {
  it('uses the same template key on both sides', () => {
    expect(EZTRANS_BATCH_TEMPLATE_KEY).toBe(SHARED_KEY);
  });

  it('has a byte-identical subject and body', () => {
    expect(DEFAULT_EZTRANS_BATCH_SUBJECT).toBe(SHARED_SUBJECT);
    expect(DEFAULT_EZTRANS_BATCH_BODY).toBe(SHARED_BODY);
  });

  it('is what the migration seeds the editable row with', () => {
    // The migration writes E'...' strings, so \n is an escape there and a real
    // newline here. Compare after undoing that.
    const unescape = (s: string) => s.replace(/\\n/g, '\n').replace(/''/g, "'");
    const literals = [...MIGRATION.matchAll(/E'((?:[^']|'')*)'/g)].map(m => unescape(m[1]));
    expect(MIGRATION).toContain(`'${EZTRANS_BATCH_TEMPLATE_KEY}'`);
    expect(literals).toContain(DEFAULT_EZTRANS_BATCH_SUBJECT);
    expect(literals).toContain(DEFAULT_EZTRANS_BATCH_BODY);
  });

  it('declares every variable the default actually uses', () => {
    const used = [
      ...DEFAULT_EZTRANS_BATCH_BODY.matchAll(/\{\{(\w+)\}\}/g),
      ...DEFAULT_EZTRANS_BATCH_SUBJECT.matchAll(/\{\{(\w+)\}\}/g),
    ].map(m => m[1]);
    const declared = new Set<string>(EZTRANS_BATCH_TEMPLATE_VARIABLES);
    for (const v of used) expect(declared.has(v)).toBe(true);
    for (const v of EZTRANS_BATCH_TEMPLATE_VARIABLES) expect(MIGRATION).toContain(`'${v}'`);
  });

  it('adds the four columns the send reads', () => {
    for (const col of [
      'eztrans_confirmed_at', 'eztrans_confirmed_by',
      'eztrans_packing_list', 'eztrans_batch_sent_at',
    ]) expect(MIGRATION).toContain(col);
  });
});

describe('sendEzTransDailyBatch request shape', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ email_id: 're_1', orders: [], skipped: [] })),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  const sentBody = () => JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);

  it('sends the ids the panel listed and no wording when nothing was edited', async () => {
    await sendEzTransDailyBatch(['q-1', 'q-2']);
    expect(sentBody()).toEqual({ queue_ids: ['q-1', 'q-2'] });
  });

  it('refuses to call the server with an empty batch', async () => {
    await expect(sendEzTransDailyBatch([])).rejects.toThrow(/nothing is confirmed/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the server error rather than a bare status', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 409,
      text: () => Promise.resolve(JSON.stringify({ error: 'none of these orders could be sent' })),
    });
    await expect(sendEzTransDailyBatch(['q-1'])).rejects.toThrow(/none of these orders/);
  });
});
