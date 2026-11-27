import { describe, it, expect, vi } from 'vitest';
vi.mock('./supabase', () => ({ supabase: {} }));
vi.mock('./activityLog', () => ({ logAction: vi.fn() }));
import type { CustomerProfitability } from './customers';
import { applyCostAdjustments, type CustomerShippingInvoice, type CustomerProfitabilityAdjustment } from './shippingInvoices';
import { variableCosts, sumCosts } from './profitability';

/** A customer with nothing going on. Every test starts here and changes only
 *  the fields it is about, so a number appearing in an assertion always traces
 *  to something the test set. */
function row(over: Partial<CustomerProfitability> = {}): CustomerProfitability {
  return {
    id: 'c1', full_name: 'Test Customer', email: 't@example.com',
    country: 'CA', region: 'ON', region_code: 'CA-ON',
    onboard_date: '2026-01-15',
    acquisition_channel: 'paid_social', acquisition_campaign: null,
    first_order_at: '2026-01-10T00:00:00Z', last_order_at: '2026-01-10T00:00:00Z',
    acquired_on: '2026-01-10',
    revenue_cad: 0, gross_revenue_cad: 0, discount_cad: 0,
    initial_revenue_cad: 0, initial_discount_cad: 0, upsell_revenue_cad: 0,
    recurring_revenue_cad: 0,
    tax_collected_cad: 0,
    sale_cogs_cad: 0, sale_shipping_cad: 0,
    expected_warranty_cost_cad: 0, expected_refund_cad: 0, settled_refund_cad: 0,
    support_cost_cad: 0,
    return_handling_cad: 0, return_stocking_cad: 0,
    return_inspection_cad: 0, return_freight_cad: 0, returns_handled: 0,
    payment_fee_cad: 0, sales_commission_cad: 0, installation_cost_cad: 0,
    consumables_cost_cad: 0, consumable_item_count: 0, shipping_invoiced_count: 0,
    legacy_shipping_cad: 0, legacy_shipment_count: 0,
    fulfilment_cost_cad: 0, fulfilment_order_count: 0,
    net_margin_cad: 0,
    order_count: 0, units_shipped_count: 0,
    replacement_count: 0, open_replacement_count: 0,
    cogs_actual_count: 0, cogs_modelled_count: 0,
    shipping_costed_count: 0, shipping_uncosted_count: 0,
    refund_count: 0, in_flight_refund_count: 0,
    ticket_count: 0, open_warranty_ticket_count: 0,
    diagnosis_call_count: 0, diagnosis_minutes: 0, diagnosis_noshow_count: 0,
    is_team_member: false,
    ...over,
  };
}

function inv(over: Partial<CustomerShippingInvoice>): CustomerShippingInvoice {
  return {
    id: 'i', customer_id: 'c1', order_ref: null, carrier: 'UPS', invoice_number: null,
    invoice_date: null, currency: 'CAD', freight_amount: 0, counts_in_shipping: true, freight_customer_paid_amount: 0,
    customs_amount: 0, customs_covered_amount: 0, file_name: null, storage_path: null,
    notes: null, uploaded_by: null, created_at: '2026-10-16', ...over,
  };
}

function adj(over: Partial<CustomerProfitabilityAdjustment>): CustomerProfitabilityAdjustment {
  return {
    customer_id: 'c1', currency: 'CAD', customs_covered_amount: 0,
    shipping_override_amount: null, note: null, updated_by: null, updated_at: '2026-10-16', ...over,
  };
}

describe('applyCostAdjustments', () => {
  const base = row({ id: 'c1', revenue_cad: 1000, sale_shipping_cad: 100, net_margin_cad: 900 });

  it('leaves a customer with nothing on file untouched in margin', () => {
    const [r] = applyCostAdjustments([base], { invoices: [], adjustments: [], usdToCad: 1.4 });
    expect(r.net_margin_cad).toBe(900);
    expect(r.customs_covered_cad).toBe(0);
    expect(variableCosts(r).shipping).toBe(100);
  });

  it('adds uploaded freight and covered customs (USD converted) to costs and margin', () => {
    const [r] = applyCostAdjustments([base], {
      invoices: [
        inv({ freight_amount: 50 }),
        inv({ freight_amount: 80, counts_in_shipping: false }),
        inv({ currency: 'USD', customs_amount: 47.1, customs_covered_amount: 10 }),
      ],
      adjustments: [adj({ customs_covered_amount: 6 })],
      usdToCad: 1.5,
    });
    const costs = variableCosts(r);
    expect(costs.shipping).toBe(150);            // 100 view + 50 uploaded; the 80 is skipped
    expect(costs.customs).toBe(21);              // US$10 × 1.5 + $6
    expect(r.net_margin_cad).toBe(900 - 50 - 21);
    expect(sumCosts(costs)).toBe(171);
  });

  it('a shipping override replaces the computed freight', () => {
    const [r] = applyCostAdjustments([base], {
      invoices: [inv({ freight_amount: 50 })],
      adjustments: [adj({ shipping_override_amount: 40 })],
      usdToCad: 1.4,
    });
    expect(variableCosts(r).shipping).toBe(40);
    expect(r.net_margin_cad).toBe(960);
  });

  it('only touches the customer the rows belong to', () => {
    const other = row({ id: 'c2', net_margin_cad: 500 });
    const [, r2] = applyCostAdjustments([base, other], {
      invoices: [inv({ customs_covered_amount: 30 })], adjustments: [], usdToCad: 1.4,
    });
    expect(r2.net_margin_cad).toBe(500);
  });
});
