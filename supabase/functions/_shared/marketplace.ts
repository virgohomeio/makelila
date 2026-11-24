// Which orders count as marketplace orders (Walmart, Best Buy, Mirakl).
//
// Pure, with no Deno.* at module scope, so the app can import it by relative
// path and the vitest suite covers it (see makelila-build-gate notes:
// nothing under supabase/functions/ is collected by vitest on its own).
//
// Read off orders.sales_channel, the label sync-shopify-orders resolves from
// Shopify's source_name (salesChannelLabel). The marketplaces arrive as
// "Walmart", "Best Buy" or "Marketplace (Mirakl)". Matching is by keyword so a
// label variant still lands in the right bucket.
//
// Shopify Collective is deliberately NOT a marketplace here. It is a reseller,
// but it has no Seller Center Ship By deadline that cancels the order, which is
// what makes a marketplace order urgent.
//
// The SQL twin is public.is_marketplace_channel() in
// 20261124120000_marketplace_priority.sql. Keep the two in step.

export type MarketplaceName = 'Walmart' | 'Best Buy' | 'Mirakl';

export function marketplaceOf(salesChannel: string | null | undefined): MarketplaceName | null {
  const s = (salesChannel ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('walmart')) return 'Walmart';
  if (s.includes('best buy') || s.includes('bestbuy')) return 'Best Buy';
  if (s.includes('mirakl')) return 'Mirakl';
  return null;
}

export function isMarketplaceChannel(salesChannel: string | null | undefined): boolean {
  return marketplaceOf(salesChannel) !== null;
}

/** Who hears about a new marketplace order, as a comma-separated env value
 *  (MARKETPLACE_ALERT_TO) or these defaults. The first is the primary and the
 *  rest are backups. Every address gets the alert, so the backup sees it even
 *  when the primary is away. */
export const DEFAULT_MARKETPLACE_ALERT_TO = ['reina@virgohome.io', 'pedrum@virgohome.io'];

export function marketplaceAlertRecipients(envValue: string | null | undefined): string[] {
  const fromEnv = (envValue ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => s.includes('@'));
  return fromEnv.length > 0 ? [...new Set(fromEnv)] : DEFAULT_MARKETPLACE_ALERT_TO;
}

export type ArrivalOrder = {
  order_ref: string;
  sales_channel: string | null;
  customer_name: string;
  city: string | null;
  region_state: string | null;
  country: string | null;
  total_usd: number | null;
  currency: string | null;
  placed_at: string | null;
};

/** The variables the marketplace_order_arrived template is rendered with. */
export function arrivalVariables(o: ArrivalOrder, appBaseUrl = 'https://lila.vip'): Record<string, string> {
  const where = [o.city, o.region_state].filter(Boolean).join(', ');
  return {
    marketplace: marketplaceOf(o.sales_channel) ?? (o.sales_channel ?? 'Marketplace'),
    order_ref: o.order_ref,
    customer_name: o.customer_name || 'Unknown customer',
    destination: [where, o.country].filter(Boolean).join(' · ') || '—',
    // total_usd holds the order's own currency despite its name.
    amount: o.total_usd != null
      ? `${Number(o.total_usd).toFixed(2)} ${o.currency ?? ''}`.trim()
      : '—',
    placed_at: o.placed_at ? new Date(o.placed_at).toUTCString() : '—',
    sales_url: `${appBaseUrl}/order-review`,
  };
}

/** Built-in copy, used only when the email_templates row is missing, so an
 *  unapplied template migration still sends an alert rather than nothing. */
export const ARRIVAL_FALLBACK_SUBJECT = 'New {{marketplace}} order {{order_ref}}: check its Ship By date';
export const ARRIVAL_FALLBACK_BODY =
  'A new {{marketplace}} order just reached makeLILA.\n\n' +
  'Order: {{order_ref}}\nCustomer: {{customer_name}}\nShip to: {{destination}}\n' +
  'Total: {{amount}}\nPlaced: {{placed_at}}\n\n' +
  'Look up its Ship By date in Seller Center, then confirm it in Sales > Pending ' +
  '(filter: Marketplace) and enter that date. The marketplace cancels orders that ' +
  'are not marked shipped by then.\n\n' +
  'Open Sales: {{sales_url}}\n\n— makeLILA';

export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (m, k: string) => (k in vars ? vars[k] : m));
}
