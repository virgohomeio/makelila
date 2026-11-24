// Auto-confirm: the exact checks, as a DRY RUN only.
//
// Huayi's build order, item 5 ("do this last; it is the riskiest change"):
// define the exact checks first, test them against past orders, and only then
// turn it on. This module is the definition. Nothing here confirms an order;
// Sales shows the verdict on each pending sale so the team can compare it with
// what they decide by hand. Switching it on is a separate, reviewed change.
//
// The five checks, verbatim from the brief:
//   address = house, phone present, paid, not refunded, unit in stock.
import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import type { Order } from './orders';
import type { RefundFlag } from './refundedOrders';

export type AutoConfirmCheckKey = 'address_house' | 'phone' | 'paid' | 'not_refunded' | 'unit_in_stock';

export type AutoConfirmCheck = {
  key: AutoConfirmCheckKey;
  label: string;
  pass: boolean;
  detail: string;
};

export type AutoConfirmVerdict = {
  /** True only when the order is a pending sale AND every check passes. */
  wouldConfirm: boolean;
  /** Why it is out of scope altogether (not a sale, not pending), else null. */
  notApplicable: string | null;
  checks: AutoConfirmCheck[];
};

/** Money states that count as paid. 'partially_paid', 'pending' and
 *  'authorized' are not: the money has not been captured in full. */
const PAID = new Set(['paid']);
/** Money states that mean some or all of the money went back. */
const REFUNDED = new Set(['refunded', 'partially_refunded', 'voided']);

/** How many machines the order needs. Every sale line synced since June is a
 *  LILA Pro (sku LILA-PRO-WHITE or blank); an order with no recognisable
 *  machine line still needs one, because a sale is always a machine. */
export function machinesNeeded(o: Pick<Order, 'line_items'>): number {
  const lines = (o.line_items ?? []) as Array<{ sku?: string | null; name?: string | null; qty?: number | null }>;
  const machine = lines.filter(li =>
    /lila[\s-]*pro/i.test(`${li.sku ?? ''} ${li.name ?? ''}`));
  const n = machine.reduce((sum, li) => sum + Math.max(1, Number(li.qty ?? 1) || 1), 0);
  return n > 0 ? n : 1;
}

export function evaluateAutoConfirm(
  o: Pick<Order, 'kind' | 'status' | 'address_verdict' | 'customer_phone' | 'financial_status' | 'line_items'>
    & Partial<Pick<Order, 'address_verdict_source'>>,
  ctx: {
    /** units with status 'ready', i.e. on the shelf and not reserved. */
    readyUnits: number | null;
    /** The refund badge Sales already computes (lib/refundedOrders). */
    refundFlag: RefundFlag | null;
  },
): AutoConfirmVerdict {
  const fs = (o.financial_status ?? '').trim().toLowerCase();
  const need = machinesNeeded(o);
  const orderRefund = ctx.refundFlag?.level === 'order';

  const checks: AutoConfirmCheck[] = [
    {
      key: 'address_house',
      label: 'Address is a house',
      pass: o.address_verdict === 'house',
      // A sync-guess "house" is a text match on what the customer typed. It
      // still passes (the brief says "address = house"), but the detail says
      // so, and the back-test reports how many orders pass only on a guess.
      detail: o.address_verdict !== 'house'
        ? `dwelling is "${o.address_verdict ?? 'unknown'}"`
        : (o.address_verdict_source ?? 'sync-guess') === 'sync-guess'
          ? 'house (unverified guess from the typed address)'
          : `house (${o.address_verdict_source})`,
    },
    {
      key: 'phone',
      label: 'Phone number present',
      pass: !!(o.customer_phone ?? '').trim(),
      detail: (o.customer_phone ?? '').trim() ? 'on file' : 'no phone number',
    },
    {
      key: 'paid',
      label: 'Paid in full',
      pass: PAID.has(fs),
      detail: fs ? `Shopify: ${fs}` : 'no payment status synced',
    },
    {
      key: 'not_refunded',
      label: 'Not refunded',
      pass: !REFUNDED.has(fs) && !orderRefund,
      detail: REFUNDED.has(fs)
        ? `Shopify: ${fs}`
        : orderRefund ? 'a refund is open against this order' : 'no refund',
    },
    {
      key: 'unit_in_stock',
      label: 'Unit in stock',
      pass: ctx.readyUnits != null && ctx.readyUnits >= need,
      detail: ctx.readyUnits == null
        ? 'stock count unavailable'
        : `${ctx.readyUnits} ready, needs ${need}`,
    },
  ];

  const notApplicable = o.kind === 'replacement'
    ? 'Replacements are never auto-confirmed'
    : o.status !== 'pending'
      ? `Only Pending orders are auto-confirmed (this one is ${o.status})`
      : null;

  return {
    wouldConfirm: notApplicable === null && checks.every(c => c.pass),
    notApplicable,
    checks,
  };
}

/** Count of units ready to ship. One small query; re-read when `epoch` moves. */
export function useReadyUnitCount(epoch: unknown = null): number | null {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    void supabase
      .from('units')
      .select('serial', { count: 'exact', head: true })
      .eq('status', 'ready')
      .then(({ count, error }) => {
        if (!cancelled) setN(error ? null : (count ?? 0));
      });
    return () => { cancelled = true; };
  }, [epoch]);
  return n;
}
