import { describe, it, expect } from 'vitest';
import { shipmentEmailVars, renderShipmentEmail, trackingUrlFor } from './fulfillment';
import type { FulfillmentQueueRow } from './fulfillment';

type RowBits = Pick<FulfillmentQueueRow, 'carrier' | 'tracking_num' | 'starter_tracking_num'>;
const row = (over: Partial<RowBits> = {}): RowBits => ({
  carrier: 'Purolator', tracking_num: '520763643704', starter_tracking_num: null, ...over,
});
const ca = { customer_name: 'Juanita M Wells', order_ref: '#1184', country: 'CA' as const };
const us = { customer_name: 'James Soto', order_ref: '#1185', country: 'US' as const };

// The body the migration seeds, trimmed to the parts these tests care about.
const TEMPLATE = [
  'Hi {{customer_first_name}},',
  '',
  'Tracking Link: {{tracking_url}}',
  '{{starter_block}}',
  'You can use the link above to check on your delivery progress at any time.',
].join('\n');

describe('shipmentEmailVars', () => {
  it('takes the first name only', () => {
    expect(shipmentEmailVars(row(), ca).customer_first_name).toBe('Juanita');
  });

  // Keyed on the number, not the destination. Step 3 asks for an Amazon
  // starter number on every machine sale now, CA included (lib/starterKit.ts) —
  // a country gate here would record a Canadian customer's starter tracking and
  // then never tell them it was coming.
  it('starter block is populated for a CA order with a starter number', () => {
    expect(shipmentEmailVars(row({ starter_tracking_num: 'TBA1' }), ca).starter_block)
      .toContain('Starter Tracking Number: TBA1');
  });

  it('starter block is populated for a US order with a starter number', () => {
    expect(shipmentEmailVars(row({ starter_tracking_num: 'TBA1' }), us).starter_block)
      .toContain('Starter Tracking Number: TBA1');
  });

  // An order that ships no starter — a replacement, or one an operator declared
  // exempt — has no number and must not grow a starter section promising one.
  it('starter block is empty with no number, whatever the destination', () => {
    expect(shipmentEmailVars(row(), us).starter_block).toBe('');
    expect(shipmentEmailVars(row(), ca).starter_block).toBe('');
  });
});

describe('trackingUrlFor', () => {
  // These must match the switch in the send-fulfillment-email edge function;
  // Canpar and GLS were missing there and silently sent a UPS link.
  it.each([
    ['UPS', 'https://www.ups.com/track?tracknum=X1'],
    ['FedEx', 'https://www.fedex.com/fedextrack/?trknbr=X1'],
    ['Purolator', 'https://www.purolator.com/en/shipping/tracker?pin=X1'],
    ['Canpar', 'https://www.canpar.com/en/track/TrackingAction.do?reference=X1'],
    ['GLS', 'https://gls-us.com/tracking?trackingNumber=X1'],
    // Not prefilled — Day & Ross has no deep link — but their page, not UPS'.
    ['Day & Ross', 'https://dayross.com/track-shipments'],
  ])('%s', (carrier, expected) => {
    expect(trackingUrlFor(carrier, 'X1')).toBe(expected);
  });

  it('falls back to the generic UPS page with no tracking number', () => {
    expect(trackingUrlFor('Purolator', null)).toBe('https://www.ups.com/track?loc=en_US');
  });
});

describe('renderShipmentEmail', () => {
  it('strips the starter_block placeholder and its newline when empty', () => {
    const out = renderShipmentEmail(TEMPLATE, shipmentEmailVars(row(), ca));
    expect(out).not.toContain('{{starter_block}}');
    expect(out).toBe(
      'Hi Juanita,\n\n' +
      'Tracking Link: https://www.purolator.com/en/shipping/tracker?pin=520763643704\n\n' +
      'You can use the link above to check on your delivery progress at any time.',
    );
  });

  it('splices the starter block in with blank lines around it', () => {
    const out = renderShipmentEmail(TEMPLATE, shipmentEmailVars(row({ starter_tracking_num: 'TBA1' }), us));
    expect(out).toBe(
      'Hi James,\n\n' +
      'Tracking Link: https://www.purolator.com/en/shipping/tracker?pin=520763643704\n\n' +
      'Compost Starter Kit (ships separately via Amazon)\n\n' +
      'Starter Tracking Number: TBA1\n\n' +
      'You can use the link above to check on your delivery progress at any time.',
    );
  });

  it('leaves a genuinely missing variable visible rather than blank', () => {
    // Only starter_block gets the strip treatment — a missing carrier must show
    // itself so the operator spots the gap before sending.
    const out = renderShipmentEmail('Carrier: {{carrier}}', shipmentEmailVars(row({ carrier: null }), ca));
    expect(out).toBe('Carrier: {{carrier}}');
  });
});
