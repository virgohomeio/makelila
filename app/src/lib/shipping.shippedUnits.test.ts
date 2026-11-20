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

describe('shipping cost editing', () => {
  it('carries the order id so the cost can be corrected on the order', () => {
    const rows = mergeShippedUnits({
      units: [unit('S5'), unit('S6', { customer_order_ref: '#1002' })],
      queue: [{ id: 'q5', step: 6, carrier: 'UPS', tracking_num: '1ZQ', assigned_serial: 'S5',
                label_confirmed_at: null, fulfilled_at: null, created_at: '2026-11-01',
                fulfillment_queue_units: [{ unit_serial: 'S5' }], orders: { ...order, id: 'o1' } }],
      orders: [{ id: 'o2', order_ref: '#1002', customer_name: 'Bo', shipping_cost_usd: 10, shipping_cost_currency: 'CAD' }],
      legacy: [], log: [{ serial_number: 'S6', tracking_number: '1ZL', carrier: 'UPS', shipping_date: '2026-01-01' }],
    });
    const by = Object.fromEntries(rows.map(r => [r.serial, r]));
    expect(by.S5.order_id).toBe('o1');
    expect(by.S6.order_id).toBe('o2');
  });

  it('leaves order_id null when no order was found (row stays read-only)', () => {
    const rows = mergeShippedUnits({
      units: [unit('S7', { customer_order_ref: null })], queue: [], orders: [],
      legacy: [{ serial: 'S7', tracking_number: 'D9', carrier: 'Canpar', shipped_on: '2025-10-01', amount_cad: 50 }],
      log: [],
    });
    expect(rows[0]).toMatchObject({ order_id: null, shipping_cost: 50 });
  });

  it('rejects a negative or non-numeric cost before touching the database', async () => {
    const { updateOrderShippingCost } = await import('./shipping');
    await expect(updateOrderShippingCost('o1', -5, 'CAD')).rejects.toThrow(/non-negative/);
    await expect(updateOrderShippingCost('o1', Number.NaN, 'CAD')).rejects.toThrow(/non-negative/);
    await expect(updateOrderShippingCost('o1', 5, 'cad')).rejects.toThrow(/3-letter/);
  });
});
