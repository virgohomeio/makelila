import { describe, it, expect } from 'vitest';
import type { CustomerProfitability } from './customers';
import {
  DEFAULT_RATES, allocateCac, byChannel, byCohort, byRegion, byVolume,
  cacPayback, channelLabel, costCoverage, customerMetrics, isUnpriced,
  monthKey, portfolio, profitDistribution, projectedLtv, quarterKey,
  reliability, rollup, sumCosts, variableCosts, volumeSegment, waterfall,
  aggregateCosts, costsBasis, marginBasis,
  type AcquisitionSpendRow,
} from './profitability';

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

/** A plain single-unit sale: $1,000 in, $500 of cost, $500 of margin. */
function simpleSale(over: Partial<CustomerProfitability> = {}): CustomerProfitability {
  return row({
    revenue_cad: 1000, gross_revenue_cad: 1000,
    initial_revenue_cad: 1000,
    sale_cogs_cad: 400, sale_shipping_cad: 100,
    net_margin_cad: 500,
    order_count: 1, units_shipped_count: 1,
    ...over,
  });
}

const metricsOf = (r: CustomerProfitability, cac = 0) =>
  customerMetrics(r, { cac_cad: cac, basis: cac > 0 ? 'allocated' : 'no_spend' });

// ── Revenue ─────────────────────────────────────────────────────────────────

describe('revenue', () => {
  it('reports a single unit purchase at its net revenue', () => {
    const m = metricsOf(simpleSale());
    expect(m.revenue).toBe(1000);
    expect(m.initialRevenue).toBe(1000);
    expect(m.upsellRevenue).toBe(0);
  });

  it('takes the discount rate against gross, not net', () => {
    // $1,100 of list price, $100 discounted away, $1,000 collected.
    const m = metricsOf(simpleSale({ gross_revenue_cad: 1100, discount_cad: 100 }));
    expect(m.discountRate).toBeCloseTo(100 / 1100, 6);
  });

  it('returns a null discount rate rather than dividing by zero gross', () => {
    expect(metricsOf(row()).discountRate).toBeNull();
  });

  it('handles a fully comped order — 100% discount, no revenue', () => {
    const m = metricsOf(row({ gross_revenue_cad: 1350, discount_cad: 1350, revenue_cad: 0, order_count: 1 }));
    expect(m.discountRate).toBe(1);
    expect(m.revenue).toBe(0);
  });

  it('separates upsell revenue from the initial purchase', () => {
    const m = metricsOf(simpleSale({
      revenue_cad: 2200, initial_revenue_cad: 1000, upsell_revenue_cad: 1200,
      order_count: 2,
    }));
    expect(m.initialRevenue).toBe(1000);
    expect(m.upsellRevenue).toBe(1200);
    expect(m.initialRevenue + m.upsellRevenue).toBe(m.revenue);
  });

  it('reports recurring revenue as zero because no such product exists', () => {
    expect(metricsOf(simpleSale()).recurringRevenue).toBe(0);
  });

  it('averages revenue over units for ARPU, and nulls it with no units', () => {
    expect(metricsOf(simpleSale({ revenue_cad: 2000, order_count: 2 })).arpu).toBe(1000);
    expect(metricsOf(row({ revenue_cad: 500, order_count: 0 })).arpu).toBeNull();
  });
});

// ── Costs ───────────────────────────────────────────────────────────────────

describe('cost buckets', () => {
  it('sums exactly the eleven buckets and nothing else', () => {
    const costs = variableCosts(row({
      sale_cogs_cad: 1, sale_shipping_cad: 2, expected_warranty_cost_cad: 4,
      expected_refund_cad: 8, support_cost_cad: 16, return_handling_cad: 32,
      payment_fee_cad: 64, sales_commission_cad: 128, installation_cost_cad: 256,
      consumables_cost_cad: 512, fulfilment_cost_cad: 1024,
    }));
    // Powers of two: any bucket dropped or double-counted changes the total.
    expect(sumCosts(costs)).toBe(2047);
  });

  it('marks every bucket with how well it is known', () => {
    // The "never present an unmeasured number as measured" rule only holds if
    // the basis is visible, so it has to be derivable per bucket.
    const b = costsBasis(row({
      cogs_actual_count: 2, cogs_modelled_count: 1,   // some invoiced, some projected
      shipping_uncosted_count: 1,                     // freight partly missing
      support_cost_cad: 40, diagnosis_call_count: 2,  // rate x duration
      fulfilment_cost_cad: 6.45,                      // contracted rate card
      payment_fee_cad: 0,                             // nobody has set the rate
    }));
    expect(b.cogs).toBe('partial');
    expect(b.shipping).toBe('partial');
    expect(b.support).toBe('estimated');
    expect(b.returnHandling).toBe('estimated');
    expect(b.fulfilment).toBe('estimated');
    expect(b.paymentFees).toBe('unpriced');
    expect(b.refunds).toBe('actual');
    expect(b.consumables).toBe('actual');
  });

  it('calls COGS invoiced only when no order used the projection', () => {
    expect(costsBasis(row({ cogs_actual_count: 3, cogs_modelled_count: 0 })).cogs).toBe('actual');
    expect(costsBasis(row({ cogs_actual_count: 0, cogs_modelled_count: 3 })).cogs).toBe('estimated');
  });

  it('calls support unpriced, not free, when the rate is unset', () => {
    const b = costsBasis(row({ support_cost_cad: null, diagnosis_call_count: 3 }));
    expect(b.support).toBe('unpriced');
  });

  it('rolls the bucket bases up into a verdict on the margin', () => {
    // A margin resting on any estimate is not a settled figure, and the tab
    // has to be able to say which buckets are responsible.
    const mb = marginBasis(row({ cogs_modelled_count: 1, fulfilment_cost_cad: 6.45 }));
    expect(mb.fullyMeasured).toBe(false);
    expect(mb.estimated).toContain('3PL handling');
    expect(mb.unpriced).toContain('Payment fees');
  });

  it('keeps 3PL handling out of shipping', () => {
    // The 3PL passes carrier cost through and bucket 2 already holds it. If
    // handling ever lands in `shipping`, every shipment is billed twice.
    const costs = variableCosts(row({ sale_shipping_cad: 150, fulfilment_cost_cad: 6.45 }));
    expect(costs.shipping).toBe(150);
    expect(costs.fulfilment).toBeCloseTo(6.45, 2);
  });

  it('adds pre-Freightcom legacy freight into the shipping bucket', () => {
    // Legacy freight is attributed per customer rather than per order, but it
    // is still freight -- it belongs in bucket 2, not a bucket of its own.
    const costs = variableCosts(row({ sale_shipping_cad: 100, legacy_shipping_cad: 41.02 }));
    expect(costs.shipping).toBeCloseTo(141.02, 2);
  });

  it('keeps consumables out of shipping', () => {
    // Amazon worm castings are product the customer keeps, not freight. If they
    // ever land in `shipping`, every freight-per-unit figure on the tab is wrong.
    const costs = variableCosts(row({ sale_shipping_cad: 40, consumables_cost_cad: 20 }));
    expect(costs.shipping).toBe(40);
    expect(costs.consumables).toBe(20);
  });

  it('counts an unpriced support cost as zero without crashing', () => {
    const costs = variableCosts(row({ support_cost_cad: null, diagnosis_call_count: 3 }));
    expect(costs.support).toBe(0);
  });

  it('counts an unpriced return-handling cost as zero', () => {
    expect(variableCosts(row({ return_handling_cad: null })).returnHandling).toBe(0);
  });

  it('aggregates buckets across customers', () => {
    const c = aggregateCosts([
      metricsOf(row({ sale_cogs_cad: 100, sale_shipping_cad: 10 })),
      metricsOf(row({ sale_cogs_cad: 200, sale_shipping_cad: 20 })),
    ]);
    expect(c.cogs).toBe(300);
    expect(c.shipping).toBe(30);
  });
});

describe('cost coverage', () => {
  it('is complete when nothing is missing', () => {
    expect(costCoverage(simpleSale()).complete).toBe(true);
  });

  it('flags uncosted freight', () => {
    const cov = costCoverage(simpleSale({ shipping_uncosted_count: 2 }));
    expect(cov.complete).toBe(false);
    expect(cov.gaps.join(' ')).toMatch(/freight invoice/);
  });

  it('flags a modelled COGS basis', () => {
    expect(costCoverage(simpleSale({ cogs_modelled_count: 1 })).gaps.join(' '))
      .toMatch(/roadmap projection/);
  });

  it('flags unpriced diagnosis labour only when there were calls', () => {
    expect(costCoverage(simpleSale({ support_cost_cad: null, diagnosis_call_count: 2 })).complete).toBe(false);
    expect(costCoverage(simpleSale({ support_cost_cad: null, diagnosis_call_count: 0 })).complete).toBe(true);
  });

  it('flags a return with no freight on file', () => {
    expect(costCoverage(simpleSale({ returns_handled: 1, return_freight_cad: 0 })).gaps.join(' '))
      .toMatch(/return-leg freight/);
  });
});

// ── Contribution margin ─────────────────────────────────────────────────────

describe('contribution margin', () => {
  it('is revenue less variable costs', () => {
    const m = metricsOf(simpleSale());
    expect(m.contributionMargin).toBe(500);
    expect(m.contributionMarginPct).toBeCloseTo(0.5, 6);
  });

  it('goes negative when costs exceed revenue', () => {
    const m = metricsOf(simpleSale({ expected_warranty_cost_cad: 900, net_margin_cad: -400 }));
    expect(m.contributionMargin).toBe(-400);
    expect(m.contributionMarginPct).toBeCloseTo(-0.4, 6);
  });

  it('returns a null margin percentage rather than dividing by zero revenue', () => {
    const m = metricsOf(row({ revenue_cad: 0, support_cost_cad: 75, net_margin_cad: -75 }));
    expect(m.contributionMargin).toBe(-75);
    expect(m.contributionMarginPct).toBeNull();
  });

  it('lets a refund pull revenue back out through the refund bucket', () => {
    // A refunded sale nets to zero: the refund bucket cancels the revenue,
    // and the COGS and freight already spent stay as a loss.
    const m = metricsOf(simpleSale({ expected_refund_cad: 1000, net_margin_cad: -500 }));
    expect(m.costs.refunds).toBe(1000);
    expect(m.contributionMargin).toBe(-500);
  });
});

// ── CAC allocation ──────────────────────────────────────────────────────────

const spend = (over: Partial<AcquisitionSpendRow> = {}): AcquisitionSpendRow => ({
  channel: 'paid_social', month: '2026-01-01', spend_cad: 1000, source: 'fb_campaigns', ...over,
});

describe('CAC allocation', () => {
  it('splits a channel-month evenly across the customers it won', () => {
    const rows = [
      simpleSale({ id: 'a', acquired_on: '2026-01-05' }),
      simpleSale({ id: 'b', acquired_on: '2026-01-20' }),
    ];
    const { byCustomer } = allocateCac(rows, [spend({ spend_cad: 1000 })]);
    expect(byCustomer.get('a')).toEqual({ cac_cad: 500, basis: 'allocated' });
    expect(byCustomer.get('b')).toEqual({ cac_cad: 500, basis: 'allocated' });
  });

  it('does not let one channel-month subsidise another', () => {
    const rows = [
      simpleSale({ id: 'jan', acquired_on: '2026-01-05' }),
      simpleSale({ id: 'feb', acquired_on: '2026-02-05' }),
    ];
    const { byCustomer } = allocateCac(rows, [
      spend({ month: '2026-01-01', spend_cad: 800 }),
      spend({ month: '2026-02-01', spend_cad: 200 }),
    ]);
    expect(byCustomer.get('jan')?.cac_cad).toBe(800);
    expect(byCustomer.get('feb')?.cac_cad).toBe(200);
  });

  it('books $0 with a "no spend" basis when a channel has no spend feed', () => {
    const rows = [simpleSale({ id: 'a', acquisition_channel: 'referral' })];
    const { byCustomer, unpricedChannelMonths } = allocateCac(rows, [spend()]);
    expect(byCustomer.get('a')).toEqual({ cac_cad: 0, basis: 'no_spend' });
    expect(unpricedChannelMonths).toContain('referral|2026-01');
  });

  it('returns a null CAC when the customer has no acquisition date', () => {
    const rows = [simpleSale({ id: 'a', acquired_on: null })];
    const { byCustomer } = allocateCac(rows, [spend()]);
    expect(byCustomer.get('a')).toEqual({ cac_cad: null, basis: 'unknown' });
  });

  it('keeps team accounts out of the split so real CAC is not deflated', () => {
    const rows = [
      simpleSale({ id: 'real', acquired_on: '2026-01-05' }),
      simpleSale({ id: 'staff', acquired_on: '2026-01-06', is_team_member: true }),
    ];
    const { byCustomer } = allocateCac(rows, [spend({ spend_cad: 1000 })]);
    expect(byCustomer.get('real')?.cac_cad).toBe(1000);
    expect(byCustomer.has('staff')).toBe(false);
  });

  it('reports spend from months that won nobody instead of dropping it', () => {
    const rows = [simpleSale({ id: 'a', acquired_on: '2026-01-05' })];
    const { unallocatedSpendCad } = allocateCac(rows, [
      spend({ month: '2026-01-01', spend_cad: 500 }),
      spend({ month: '2026-07-01', spend_cad: 3000 }),
    ]);
    expect(unallocatedSpendCad).toBe(3000);
  });

  it('sums several spend rows landing in the same channel-month', () => {
    const rows = [simpleSale({ id: 'a', acquired_on: '2026-01-05' })];
    const { byCustomer } = allocateCac(rows, [
      spend({ spend_cad: 300 }), spend({ spend_cad: 700 }),
    ]);
    expect(byCustomer.get('a')?.cac_cad).toBe(1000);
  });

  it('ignores spend rows with an unparseable month', () => {
    const rows = [simpleSale({ id: 'a', acquired_on: '2026-01-05' })];
    const { byCustomer } = allocateCac(rows, [spend({ month: '' })]);
    expect(byCustomer.get('a')?.basis).toBe('no_spend');
  });
});

// ── LTV, LTV:CAC and payback ────────────────────────────────────────────────

describe('lifetime value', () => {
  it('takes realized LTV as contribution margin banked to date', () => {
    expect(metricsOf(simpleSale()).realizedLtv).toBe(500);
  });

  it('equals realized LTV while there is no recurring revenue', () => {
    const m = metricsOf(simpleSale());
    expect(m.projectedLtv).toBe(m.realizedLtv);
  });

  it('adds the remaining recurring months once a rate exists', () => {
    // $10/mo, 5-year assumed life, 12 months elapsed → 48 months left.
    const p = projectedLtv(500, 365, {
      ...DEFAULT_RATES,
      recurring_revenue_per_customer_month_cad: 10,
      projected_lifetime_years: 5,
    });
    expect(p).toBeGreaterThan(500);
    expect(p).toBeCloseTo(500 + 10 * (60 - 365 / 30.44), 4);
  });

  it('never projects negative remaining months past the assumed lifetime', () => {
    const p = projectedLtv(500, 365 * 20, {
      ...DEFAULT_RATES, recurring_revenue_per_customer_month_cad: 10,
    });
    expect(p).toBe(500);
  });

  it('divides LTV by CAC', () => {
    expect(metricsOf(simpleSale(), 250).ltvCac).toBeCloseTo(2, 6);
  });

  it('returns a null ratio against zero CAC rather than Infinity', () => {
    const m = metricsOf(simpleSale(), 0);
    expect(m.ltvCac).toBeNull();
    expect(Number.isFinite(m.lifetimeProfit)).toBe(true);
  });

  it('subtracts CAC to get lifetime contribution profit', () => {
    expect(metricsOf(simpleSale(), 200).lifetimeProfit).toBe(300);
  });

  it('treats an unknown CAC as zero for profit, not as a crash', () => {
    const m = customerMetrics(simpleSale(), { cac_cad: null, basis: 'unknown' });
    expect(m.lifetimeProfit).toBe(500);
    expect(m.cac).toBeNull();
  });
});

describe('CAC payback', () => {
  it('is recovered at the sale when margin covers CAC', () => {
    expect(cacPayback(500, 200)).toEqual({
      status: 'immediate', months: 0, recoveredCad: 200, remainingCad: 0,
    });
  });

  it('reports the shortfall when margin does not cover CAC', () => {
    const p = cacPayback(120, 500);
    expect(p.status).toBe('not_recovered');
    expect(p.recoveredCad).toBe(120);
    expect(p.remainingCad).toBe(380);
    // No recurring revenue means no run rate to project a recovery date from.
    expect(p.months).toBeNull();
  });

  it('does not credit a negative margin as partial recovery', () => {
    const p = cacPayback(-300, 500);
    expect(p.recoveredCad).toBe(0);
    expect(p.remainingCad).toBe(500);
  });

  it('has nothing to pay back when nothing was spent', () => {
    expect(cacPayback(500, 0).status).toBe('no_cac');
  });

  it('is unknown when CAC could not be established', () => {
    expect(cacPayback(500, null).status).toBe('unknown');
  });

  it('counts break-even exactly as recovered', () => {
    expect(cacPayback(500, 500).status).toBe('immediate');
  });
});

// ── Rollups ─────────────────────────────────────────────────────────────────

describe('rollups', () => {
  const set = () => [
    metricsOf(simpleSale({ id: 'a', region_code: 'CA-ON', acquisition_channel: 'paid_social' }), 100),
    metricsOf(simpleSale({ id: 'b', region_code: 'CA-ON', acquisition_channel: 'paid_social',
                           revenue_cad: 2000, net_margin_cad: 1000, order_count: 2 }), 100),
    metricsOf(simpleSale({ id: 'c', region_code: 'US-CA', acquisition_channel: 'referral',
                           net_margin_cad: -300 })),
  ];

  it('adds revenue, costs and margin across a segment', () => {
    const s = rollup(set(), 'all', 'All');
    expect(s.customers).toBe(3);
    expect(s.revenue).toBe(4000);
    expect(s.contributionMargin).toBe(1200);
  });

  it('takes segment CAC as total spend over customers, not a mean of means', () => {
    // Only two of the three carry spend; the third has none on file.
    const s = rollup(set(), 'all', 'All');
    expect(s.cacTotal).toBe(200);
    expect(s.cac).toBeCloseTo(200 / 3, 6);
    expect(s.lifetimeProfit).toBe(1000);
  });

  it('splits by region', () => {
    const regions = byRegion(set());
    expect(regions.map(r => r.key).sort()).toEqual(['CA-ON', 'US-CA']);
    expect(regions.find(r => r.key === 'CA-ON')!.customers).toBe(2);
  });

  it('splits by channel and labels it for humans', () => {
    const channels = byChannel(set());
    expect(channels.find(c => c.key === 'paid_social')!.label).toBe('Paid social');
  });

  it('sorts segments by lifetime profit, best first', () => {
    const regions = byRegion(set());
    expect(regions[0].key).toBe('CA-ON');
    expect(regions[regions.length - 1].key).toBe('US-CA');
  });

  it('flags a segment whose customers carry no traceable spend', () => {
    expect(byRegion(set()).find(r => r.key === 'US-CA')!.cacUnpriced).toBe(true);
  });

  it('reports the share of a segment that is loss-making', () => {
    expect(rollup(set(), 'all', 'All').unprofitableRate).toBeCloseTo(1 / 3, 6);
  });

  it('rolls an empty segment up without dividing by zero', () => {
    const s = rollup([], 'none', 'None');
    expect(s.customers).toBe(0);
    expect(s.contributionMarginPct).toBeNull();
    expect(s.cac).toBeNull();
    expect(s.ltv).toBeNull();
    expect(s.arpu).toBeNull();
    expect(s.profitPerCustomer).toBeNull();
  });

  it('groups unmapped keys under "unknown" rather than dropping the customer', () => {
    const regions = byRegion([metricsOf(simpleSale({ region_code: null }))]);
    expect(regions).toHaveLength(1);
    expect(regions[0].key).toBe('unknown');
  });

  it('orders cohorts by date, not by profit', () => {
    const cohorts = byCohort([
      metricsOf(simpleSale({ id: 'later', acquired_on: '2026-06-01', net_margin_cad: 5000 })),
      metricsOf(simpleSale({ id: 'earlier', acquired_on: '2026-01-01' })),
    ]);
    expect(cohorts.map(c => c.key)).toEqual(['2026-01', '2026-06']);
  });

  it('buckets quarterly cohorts', () => {
    const cohorts = byCohort([
      metricsOf(simpleSale({ id: 'a', acquired_on: '2026-01-15' })),
      metricsOf(simpleSale({ id: 'b', acquired_on: '2026-03-20' })),
    ], 'quarter');
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0].key).toBe('2026-Q1');
  });
});

describe('volume segmentation', () => {
  it('names each band', () => {
    expect(volumeSegment(metricsOf(row({ order_count: 0 })))).toBe('no_purchase');
    expect(volumeSegment(metricsOf(row({ order_count: 1 })))).toBe('single_unit');
    expect(volumeSegment(metricsOf(row({ order_count: 3 })))).toBe('multi_unit');
    expect(volumeSegment(metricsOf(row({ order_count: 9 })))).toBe('fleet');
  });

  it('rolls up by band', () => {
    const segs = byVolume([
      metricsOf(simpleSale({ id: 'a', order_count: 1 })),
      metricsOf(simpleSale({ id: 'b', order_count: 5 })),
    ]);
    expect(segs.map(s => s.key).sort()).toEqual(['fleet', 'single_unit']);
  });
});

// ── Portfolio and distribution ──────────────────────────────────────────────

describe('portfolio', () => {
  it('counts customers on each side of break-even', () => {
    const p = portfolio([
      metricsOf(simpleSale({ id: 'win' })),
      metricsOf(simpleSale({ id: 'flat', net_margin_cad: 0 })),
      metricsOf(simpleSale({ id: 'loss', net_margin_cad: -100 })),
    ]);
    expect(p.profitableCustomers).toBe(1);
    expect(p.breakEvenCustomers).toBe(1);
    expect(p.unprofitableCustomers).toBe(1);
  });

  it('divides warranty and service by units sold', () => {
    const p = portfolio([
      metricsOf(simpleSale({ expected_warranty_cost_cad: 200, support_cost_cad: 100, order_count: 2 })),
    ]);
    expect(p.warrantyServiceCostPerUnit).toBe(150);
  });

  it('nulls per-unit costs when nothing has been sold', () => {
    expect(portfolio([metricsOf(row())]).warrantyServiceCostPerUnit).toBeNull();
  });

  it('handles an empty portfolio', () => {
    const p = portfolio([]);
    expect(p.customers).toBe(0);
    expect(p.warrantyServiceCostPerUnit).toBeNull();
    expect(p.lifetimeProfit).toBe(0);
  });
});

describe('profit distribution', () => {
  it('puts each customer in exactly one band', () => {
    const metrics = [-3000, -1000, -100, 0, 300, 700, 5000]
      .map((v, i) => metricsOf(simpleSale({ id: `c${i}`, net_margin_cad: v })));
    const buckets = profitDistribution(metrics);
    expect(buckets.reduce((s, b) => s + b.count, 0)).toBe(metrics.length);
  });

  it('counts exactly zero as the first profitable band, not a loss', () => {
    const buckets = profitDistribution([metricsOf(simpleSale({ net_margin_cad: 0 }))]);
    expect(buckets.find(b => b.label === '-$500 to $0')!.count).toBe(0);
    expect(buckets.find(b => b.label === '$0 to $250')!.count).toBe(1);
  });
});

// ── Waterfall ───────────────────────────────────────────────────────────────

describe('waterfall', () => {
  it('runs revenue down through the costs to profit', () => {
    const steps = waterfall([metricsOf(simpleSale())], 200);
    expect(steps[0]).toMatchObject({ label: 'Revenue', value: 1000, isTotal: true });
    expect(steps.find(s => s.label === 'COGS')!.value).toBe(-400);
    expect(steps.find(s => s.label === 'Contribution')!.value).toBe(500);
    expect(steps.find(s => s.label === 'Lifetime profit')!.value).toBe(300);
  });

  it('drops cost steps that are zero but keeps every total', () => {
    const steps = waterfall([metricsOf(simpleSale())], 0);
    expect(steps.find(s => s.label === 'Installation')).toBeUndefined();
    expect(steps.filter(s => s.isTotal)).toHaveLength(3);
  });
});

// ── Reliability ─────────────────────────────────────────────────────────────

describe('reliability', () => {
  it('takes the warranty claim rate over customers and the replacement rate over units', () => {
    const r = reliability([
      simpleSale({ id: 'a', replacement_count: 2, order_count: 1 }),
      simpleSale({ id: 'b', order_count: 3 }),
    ]);
    expect(r.unitsSold).toBe(4);
    expect(r.warrantyClaimRate).toBe(0.5);
    expect(r.replacementRate).toBe(0.5);
  });

  it('nulls every per-unit rate when no unit has sold', () => {
    const r = reliability([row()]);
    expect(r.warrantyCostPerUnit).toBeNull();
    expect(r.serviceCostPerUnit).toBeNull();
    expect(r.warrantyPlusServicePerUnit).toBeNull();
  });

  it('handles an empty customer set', () => {
    const r = reliability([]);
    expect(r.warrantyClaimRate).toBeNull();
    expect(r.unitsSold).toBe(0);
  });
});

// ── Small helpers ───────────────────────────────────────────────────────────

describe('helpers', () => {
  it('reads a month and a quarter off a date', () => {
    expect(monthKey('2026-08-21')).toBe('2026-08');
    expect(quarterKey('2026-08-21')).toBe('2026-Q3');
    expect(monthKey(null)).toBeNull();
    expect(monthKey('not a date')).toBeNull();
  });

  it('treats a zero or missing rate as unpriced', () => {
    expect(isUnpriced(0)).toBe(true);
    expect(isUnpriced(null)).toBe(true);
    expect(isUnpriced(2.9)).toBe(false);
  });

  it('labels a known channel and passes an unknown one through', () => {
    expect(channelLabel('paid_social')).toBe('Paid social');
    expect(channelLabel('tiktok')).toBe('tiktok');
    expect(channelLabel(null)).toBe('Unattributed');
  });
});
