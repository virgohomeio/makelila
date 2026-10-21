import { describe, it, expect, vi } from 'vitest';
vi.mock('./supabase', () => ({ supabase: {} }));
import { mergeShippedUnits, shipmentTrackingUrl } from './shipping';

const unit = (serial: string, over: Partial<Parameters<typeof mergeShippedUnits>[0]['units'][number]> = {}) => ({
  serial, status: 'shipped', customer_name: 'Ada', customer_order_ref: '#1001',
  carrier: 'UPS', shipped_at: '2026-09-01T00:00:00Z', tracking_num: null, ...over,
});
const order = { order_ref: '#1001', customer_name: 'Ada', status: 'approved', shipping_cost_usd: 42, shipping_cost_currency: 'CAD' };

describe('mergeShippedUnits', () => {
  it('takes the tracking number entered on the queue row when the unit has none', () => {
    const rows = mergeShippedUnits({
      units: [unit('S1')],
      queue: [{ id: 'q1', step: 6, carrier: 'UPS', tracking_num: '1Z999', assigned_serial: 'S1',
                label_confirmed_at: null, fulfilled_at: null, created_at: '2026-08-30',
                fulfillment_queue_units: [{ unit_serial: 'S1' }], orders: order }],
      orders: [], legacy: [], log: [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ serial: 'S1', tracking_num: '1Z999', scheduled: false, shipping_cost: 42 });
  });

  it('lists a booked shipment whose unit is not marked shipped yet as scheduled', () => {
    const rows = mergeShippedUnits({
      units: [unit('S2', { status: 'reserved', shipped_at: null })],
      queue: [{ id: 'q2', step: 4, carrier: 'Canpar', tracking_num: 'D123', assigned_serial: 'S2',
                label_confirmed_at: '2026-10-20T00:00:00Z', fulfilled_at: null, created_at: '2026-10-19',
                fulfillment_queue_units: [], orders: order }],
      orders: [], legacy: [], log: [],
    });
    expect(rows[0]).toMatchObject({ serial: 'S2', tracking_num: 'D123', scheduled: true, shipped_at: null });
  });

  it('falls back to legacy shipping records, then the fulfillment log', () => {
    const rows = mergeShippedUnits({
      units: [unit('S3', { carrier: null }), unit('S4')],
      queue: [], orders: [order],
      legacy: [{ serial: 'S3', tracking_number: 'D555', carrier: 'Canpar', shipped_on: '2025-11-01', amount_cad: 80 }],
      log: [{ serial_number: 'S4', tracking_number: '1ZLOG', carrier: 'UPS', shipping_date: '2025-12-01' }],
    });
    const by = Object.fromEntries(rows.map(r => [r.serial, r]));
    expect(by.S3).toMatchObject({ tracking_num: 'D555', carrier: 'Canpar', shipping_cost: 42 });
    expect(by.S4).toMatchObject({ tracking_num: '1ZLOG' });
  });

  it('skips cancelled orders', () => {
    const rows = mergeShippedUnits({
      units: [], orders: [], legacy: [], log: [],
      queue: [{ id: 'q3', step: 4, carrier: 'UPS', tracking_num: '1Z', assigned_serial: null,
                label_confirmed_at: null, fulfilled_at: null, created_at: '2026-10-01',
                fulfillment_queue_units: [], orders: { ...order, status: 'cancelled' } }],
    });
    expect(rows).toHaveLength(0);
  });
});

describe('shipmentTrackingUrl', () => {
  it('deep-links known carriers case-insensitively and returns null without a number', () => {
    expect(shipmentTrackingUrl('canpar', 'D1')).toContain('canpar.com');
    expect(shipmentTrackingUrl('UPS', ' ')).toBeNull();
    expect(shipmentTrackingUrl('Personal Delivery', 'X1')).toContain('google.com/search');
  });
});
