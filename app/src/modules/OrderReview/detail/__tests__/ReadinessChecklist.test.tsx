import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evaluateReadiness, canConfirm, criteriaCount, ReadinessChecklist } from '../ReadinessChecklist';
import type { Order } from '../../../../lib/orders';

// The fourth confirm criterion: an order classified rural or remote does not
// confirm until somebody says they looked at it.
//
// Both signals are independent and either one alone is a reason to look —
// area_type comes from the postal-code rule / the verify model / an operator,
// address_verdict 'remote' comes from the USPS record type or the street line.

/** A sale that clears the first three criteria, so any blocker a test sees is
 *  the one that test introduced. */
const ready: Order = {
  id: 'order-1',
  kind: 'sale',
  order_ref: '#1001',
  status: 'pending',
  customer_name: 'Alice Ames',
  customer_email: 'alice@example.com',
  customer_phone: '+15551234567',
  quo_thread_url: null,
  address_line: '12 Main St',
  address_line2: null,
  city: 'Toronto',
  region_state: 'ON',
  country: 'CA',
  address_verdict: 'house',
  address_verdict_source: 'google',
  area_type: 'suburban',
  area_type_source: 'verified',
  address_area_type_error: null,
  address_verified_at: '2026-09-20T10:00:00Z',
  address_match: 'match',
  address_unit_status: 'not_required',
  address_google_formatted: '12 Main St, Toronto, ON, Canada',
  address_google_postal: 'M5V1A1',
  address_customer_postal: 'M5V1A1',
  address_validation_granularity: 'PREMISE',
  address_usps_dpv: null,
  address_usps_record_type: null,
  address_is_residential: true,
  address_is_business: false,
  address_claude_verdict: null,
  address_claude_notes: null,
  address_claude_postal: null,
  address_confirmed_at: null,
  address_confirmation_sent_at: null,
  freight_estimate_usd: 180,
  freight_threshold_usd: 300,
  customer_paid_shipping_usd: 0,
  freight_estimate_source: 'freightcom',
  currency: 'CAD',
  total_usd: 4999,
  subtotal_usd: 4999,
  tax_usd: null,
  tax_lines: null,
  discount_total_usd: null,
  discount_codes: null,
  payment_methods: null,
  financial_status: 'paid',
  attribution_source: null,
  attribution_medium: null,
  attribution_campaign: null,
  attribution_referrer: null,
  attribution_last_source: null,
  attribution_last_medium: null,
  attribution_last_referrer: null,
  shipping_line_title: null,
  line_items: [],
  sales_confirmed_fit: false,
  rural_check_confirmed_at: null,
  rural_check_confirmed_by: null,
  cancelled_at: null,
  cancelled_reason: null,
  cogs_usd: null,
  shipping_cost_usd: null,
  shipping_cost_currency: null,
  shipped_at: null,
  delivered_at: null,
  tracking_num: null,
  carrier: null,
  dispositioned_by: null,
  dispositioned_at: null,
  created_at: '2026-09-19T10:00:00Z',
  placed_at: '2026-09-19T10:00:00Z',
} as unknown as Order;

describe('the rural / remote manual check', () => {
  it('is not asked for on a suburban house — three criteria, ready to confirm', () => {
    expect(criteriaCount(ready)).toBe(3);
    expect(evaluateReadiness(ready).rural).toBe(true);
    expect(canConfirm(ready)).toBe(true);
  });

  it('blocks a rural order until an operator signs it off', () => {
    const rural = { ...ready, area_type: 'rural' as const };
    expect(criteriaCount(rural)).toBe(4);
    expect(evaluateReadiness(rural).rural).toBe(false);
    expect(evaluateReadiness(rural).reason4).toMatch(/nobody has checked/i);
    expect(canConfirm(rural)).toBe(false);
  });

  // The dwelling verdict is the second, independent signal: a USPS rural-route
  // record on an address whose area type nothing classified still needs looking
  // at. Reading only area_type would miss it.
  it('blocks on a remote dwelling even when the area type is unclassified', () => {
    const remote = {
      ...ready,
      area_type: null,
      address_verdict: 'remote' as const,
      // A remote dwelling also trips the older fit gate; clear it so this test
      // is only about the rural criterion.
      sales_confirmed_fit: true,
    };
    expect(criteriaCount(remote)).toBe(4);
    expect(evaluateReadiness(remote).rural).toBe(false);
    expect(canConfirm(remote)).toBe(false);
  });

  it('clears once the check is signed off', () => {
    const signed = {
      ...ready,
      area_type: 'rural' as const,
      rural_check_confirmed_at: '2026-09-23T15:00:00Z',
      rural_check_confirmed_by: 'u1',
    };
    const r = evaluateReadiness(signed);
    expect(r.rural).toBe(true);
    expect(r.reason4).toMatch(/checked/i);
    expect(canConfirm(signed)).toBe(true);
  });

  // The columns ship behind the gated migration workflow, so a frontend deploy
  // can land first. On that database select('*') returns rows without the keys,
  // and a pending migration must not make a rural order unconfirmable.
  it('warns but does not block while the migration is unapplied', () => {
    const unmigrated = { ...ready, area_type: 'rural' as const } as Order;
    delete (unmigrated as Partial<Order>).rural_check_confirmed_at;
    delete (unmigrated as Partial<Order>).rural_check_confirmed_by;

    const r = evaluateReadiness(unmigrated);
    expect(r.rural).toBe(true);
    expect(r.reason4).toMatch(/migration/i);
    expect(canConfirm(unmigrated)).toBe(true);
  });

  // Replacements are born approved in Fulfillment and never reach this screen,
  // but canConfirm() runs for every rail row, so it answers rather than blocks.
  it('is not asked for on a replacement', () => {
    const repl = { ...ready, kind: 'replacement' as const, area_type: 'rural' as const };
    expect(criteriaCount(repl)).toBe(3);
    expect(canConfirm(repl)).toBe(true);
  });
});

describe('the blocker strip', () => {
  it('names the rural check and offers the jump that fixes it', () => {
    render(<ReadinessChecklist order={{ ...ready, area_type: 'rural' }} />);
    expect(screen.getByText(/1 blocker before you can confirm/i)).toBeInTheDocument();
    expect(screen.getByText(/3 of 4 met/i)).toBeInTheDocument();
    expect(screen.getByText(/rural delivery/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /fix in address/i })).toHaveLength(1);
  });

  it('counts four met once the rural check is signed off', () => {
    render(
      <ReadinessChecklist
        order={{ ...ready, area_type: 'rural', rural_check_confirmed_at: '2026-09-23T15:00:00Z' }}
      />,
    );
    expect(screen.getByText(/4 of 4/i)).toBeInTheDocument();
    expect(screen.getByText(/criteria met — ready to confirm/i)).toBeInTheDocument();
  });

  it('leaves a suburban order at three criteria', () => {
    render(<ReadinessChecklist order={ready} />);
    expect(screen.getByText(/3 of 3/i)).toBeInTheDocument();
    expect(screen.queryByText(/rural delivery/i)).not.toBeInTheDocument();
  });
});
