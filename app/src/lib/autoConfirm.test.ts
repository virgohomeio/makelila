// Auto-confirm checks (dry run). The five rules from Huayi's brief: address =
// house, phone present, paid, not refunded, unit in stock.
import { describe, it, expect, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));

import { evaluateAutoConfirm, machinesNeeded } from './autoConfirm';
import type { Order } from './orders';

const base = {
  kind: 'sale' as const,
  status: 'pending' as const,
  address_verdict: 'house' as const,
  address_verdict_source: 'google' as const,
  customer_phone: '+15555550100',
  financial_status: 'paid',
  line_items: [{ sku: 'LILA-PRO-WHITE', name: 'LILA Pro', qty: 1, price_usd: 699 }] as Order['line_items'],
};
const ok = { readyUnits: 10, refundFlag: null };
const failed = (v: ReturnType<typeof evaluateAutoConfirm>) => v.checks.filter(c => !c.pass).map(c => c.key);

describe('evaluateAutoConfirm', () => {
  it('confirms a clean pending sale', () => {
    const v = evaluateAutoConfirm(base, ok);
    expect(v.wouldConfirm).toBe(true);
    expect(failed(v)).toEqual([]);
  });

  it.each([
    ['apartment', { address_verdict: 'apt' as const }, 'address_house'],
    ['no phone', { customer_phone: '  ' }, 'phone'],
    ['not paid', { financial_status: 'pending' }, 'paid'],
    ['partially paid', { financial_status: 'partially_paid' }, 'paid'],
    ['refunded in Shopify', { financial_status: 'partially_refunded' }, 'not_refunded'],
  ])('blocks %s', (_name, patch, key) => {
    const v = evaluateAutoConfirm({ ...base, ...patch }, ok);
    expect(v.wouldConfirm).toBe(false);
    expect(failed(v)).toContain(key);
  });

  it('blocks an order with a refund open against it in makeLILA', () => {
    const v = evaluateAutoConfirm(base, {
      readyUnits: 10,
      refundFlag: { level: 'order' } as never,
    });
    expect(failed(v)).toEqual(['not_refunded']);
  });

  it('does not block on a refund of a DIFFERENT order of the customer', () => {
    const v = evaluateAutoConfirm(base, { readyUnits: 10, refundFlag: { level: 'customer' } as never });
    expect(v.wouldConfirm).toBe(true);
  });

  it('blocks when there are not enough ready units, or the count is unknown', () => {
    const three = { ...base, line_items: [{ sku: '', name: 'LILA Pro', qty: 3, price_usd: 699 }] as Order['line_items'] };
    expect(failed(evaluateAutoConfirm(three, { readyUnits: 2, refundFlag: null }))).toEqual(['unit_in_stock']);
    expect(failed(evaluateAutoConfirm(base, { readyUnits: null, refundFlag: null }))).toEqual(['unit_in_stock']);
  });

  it('never applies to replacements or non-pending orders', () => {
    expect(evaluateAutoConfirm({ ...base, kind: 'replacement' }, ok).wouldConfirm).toBe(false);
    expect(evaluateAutoConfirm({ ...base, status: 'held' }, ok).notApplicable).toMatch(/Pending/);
  });

  it('passes a sync-guess house but says it is unverified', () => {
    const v = evaluateAutoConfirm({ ...base, address_verdict_source: 'sync-guess' }, ok);
    expect(v.wouldConfirm).toBe(true);
    expect(v.checks.find(c => c.key === 'address_house')!.detail).toMatch(/unverified/);
  });
});

describe('machinesNeeded', () => {
  it('counts LILA Pro lines by quantity, and at least one', () => {
    expect(machinesNeeded({ line_items: [{ sku: '', name: 'LILA Pro', qty: 3, price_usd: 0 }] as Order['line_items'] })).toBe(3);
    expect(machinesNeeded({ line_items: [] as Order['line_items'] })).toBe(1);
  });
});
