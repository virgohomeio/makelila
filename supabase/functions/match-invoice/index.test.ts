import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { invoiceNumberFromFilename, parseExtracted } from './index.ts';

// A QuickBooks invoice as the fallback providers see it: the same fields
// Claude returns from the document block, but arriving as text-mode JSON.
Deno.test('parseExtracted: reads every field off a clean reply', () => {
  assertEquals(parseExtracted(`{
    "invoice_number": "1364",
    "invoice_date": "2026-08-12",
    "total_cad": 1120.97,
    "payment_cad": 1120.97,
    "shopify_order_number": "1213",
    "bill_to_name": "Jane Doe"
  }`), {
    invoice_number: '1364',
    invoice_date: '2026-08-12',
    total_cad: 1120.97,
    payment_cad: 1120.97,
    shopify_order_number: '1213',
    bill_to_name: 'Jane Doe',
  });
});

Deno.test('parseExtracted: accepts amounts written as strings, with $ and separators', () => {
  const got = parseExtracted('{"total_cad": "$1,120.97", "payment_cad": "1 120.97"}');
  assertEquals(got.total_cad, 1120.97);
  assertEquals(got.payment_cad, 1120.97);
});

// A bad parse must read as "not found" so the review queue catches it — never
// as a value, and never as NaN, which would be written to the DB as a number.
Deno.test('parseExtracted: unreadable amounts become null, not NaN', () => {
  const got = parseExtracted('{"total_cad": "see attached", "payment_cad": ""}');
  assertEquals(got.total_cad, null);
  assertEquals(got.payment_cad, null);
});

Deno.test('parseExtracted: missing and empty fields come back null', () => {
  assertEquals(parseExtracted('{"invoice_number": "  ", "bill_to_name": null}'), {
    invoice_number: null,
    invoice_date: null,
    total_cad: null,
    payment_cad: null,
    shopify_order_number: null,
    bill_to_name: null,
  });
});

Deno.test('parseExtracted: tolerates a ```json fence around the reply', () => {
  assertEquals(parseExtracted('```json\n{"invoice_number": "1368"}\n```').invoice_number, '1368');
});

Deno.test('parseExtracted: a non-JSON reply throws, named by provider', () => {
  const err = assertThrows(() => parseExtracted('I cannot read this file.', 'OpenAI')) as Error;
  assertEquals(err.message.startsWith('OpenAI:'), true);
});

Deno.test('invoiceNumberFromFilename: reads a QuickBooks invoice name', () => {
  assertEquals(invoiceNumberFromFilename('Invoice_1356_from_VCycene_Inc.pdf'), '1356');
  assertEquals(invoiceNumberFromFilename('Invoice 1368 from VCycene Inc.pdf'), '1368');
});

// Refund receipts used to fall through to "(unknown)", leaving half of what
// this tab uploads unidentifiable in the review queue.
Deno.test('invoiceNumberFromFilename: reads a refund receipt reference', () => {
  assertEquals(invoiceNumberFromFilename('Refund_Receipt_Ref_0042_from_VCycene_Inc.pdf'), '0042');
});

Deno.test('invoiceNumberFromFilename: null when there is no number to take', () => {
  assertEquals(invoiceNumberFromFilename('scan.pdf'), null);
  assertEquals(invoiceNumberFromFilename('Invoice_from_VCycene_Inc.pdf'), null);
});
