/** Format a monetary amount with its ISO currency code, e.g. "$200.00 USD".
 *  Order amounts are stored in the order's own currency (orders.currency)
 *  despite the historical `_usd` column names — always pass that currency so
 *  CAD orders aren't silently shown as USD. */
export function formatMoney(amount: number | null | undefined, currency?: string | null): string {
  if (amount == null) return '—';
  return `$${amount.toFixed(2)} ${currency || 'USD'}`;
}
