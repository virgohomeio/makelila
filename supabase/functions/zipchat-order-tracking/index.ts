// ZipChat Order Tracking API endpoint.
// ZipChat calls GET /zipchat-order-tracking?order_id=XXX&customer_email=XXX
// with header x-api-key matching ZIPCHAT_API_KEY env secret.
// Returns {"context": "...", "tracking_url": "..."} per ZipChat spec.

const API_VERSION = '2024-10';

type LineItem = { quantity: number; title: string };
type Fulfillment = {
  tracking_number: string | null;
  tracking_company: string | null;
  tracking_url: string | null;
  shipment_status: string | null;
};
type ShopifyOrder = {
  name: string;
  email: string;
  fulfillment_status: string | null;
  financial_status: string;
  created_at: string;
  line_items: LineItem[];
  fulfillments: Fulfillment[];
  shipping_address: { first_name: string; city: string; province_code: string } | null;
};

Deno.serve(async (req: Request) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Validate ZipChat API key
  const zipchatKey = Deno.env.get('ZIPCHAT_API_KEY');
  const incomingKey = req.headers.get('x-api-key');
  if (!zipchatKey || incomingKey !== zipchatKey) {
    return new Response(null, { status: 401 });
  }

  const url = new URL(req.url);
  const orderId = url.searchParams.get('order_id')?.trim() ?? '';
  const customerEmail = url.searchParams.get('customer_email')?.trim().toLowerCase() ?? '';

  if (!orderId || !customerEmail) {
    return json({ context: 'Missing order_id or customer_email. Please provide both.' }, 400);
  }

  const shop = Deno.env.get('SHOPIFY_SHOP_DOMAIN');
  const token = Deno.env.get('SHOPIFY_ADMIN_TOKEN');
  if (!shop || !token) {
    return json({ context: 'Order lookup is temporarily unavailable. Please contact support.' }, 200);
  }

  // Normalize: customers may type "1234" or "#1234"
  const orderName = orderId.startsWith('#') ? orderId : `#${orderId}`;

  const lookupUrl =
    `https://${shop}/admin/api/${API_VERSION}/orders.json` +
    `?name=${encodeURIComponent(orderName)}&status=any` +
    `&fields=name,email,fulfillment_status,financial_status,created_at,line_items,fulfillments,shipping_address`;

  let order: ShopifyOrder | null = null;
  try {
    const res = await fetch(lookupUrl, {
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      return json({ context: 'Unable to look up your order right now. Please try again or contact support.' }, 200);
    }
    const data = await res.json() as { orders?: ShopifyOrder[] };
    order = data.orders?.[0] ?? null;
  } catch {
    return json({ context: 'Unable to look up your order right now. Please try again or contact support.' }, 200);
  }

  if (!order) {
    return json(
      { context: `We couldn't find order ${orderName}. Please double-check the order number and try again.` },
      404,
    );
  }

  // Security: verify email matches before revealing order details
  if (order.email.toLowerCase() !== customerEmail) {
    return json(
      { context: `We couldn't find order ${orderName} for that email address. Please check both and try again.` },
      404,
    );
  }

  return json(buildResponse(order), 200);
});

function buildResponse(order: ShopifyOrder): { context: string; tracking_url: string } {
  const { name, fulfillment_status, financial_status, line_items, fulfillments, shipping_address } = order;

  const itemSummary = line_items
    .map(li => `${li.quantity}x ${li.title}`)
    .join(', ');

  const shipTo = shipping_address
    ? ` shipping to ${shipping_address.first_name} in ${shipping_address.city}, ${shipping_address.province_code}`
    : '';

  const latestFulfillment = fulfillments?.[0] ?? null;
  const trackingNum = latestFulfillment?.tracking_number ?? null;
  const trackingCompany = latestFulfillment?.tracking_company ?? null;
  const trackingUrl = latestFulfillment?.tracking_url ?? '';

  let statusLine: string;

  if (fulfillment_status === 'fulfilled') {
    statusLine = `Order ${name} has been shipped and is on its way.`;
    if (trackingNum) {
      statusLine += ` Tracking number: ${trackingNum}`;
      if (trackingCompany) statusLine += ` via ${trackingCompany}`;
      statusLine += '.';
    }
  } else if (fulfillment_status === 'partial') {
    statusLine = `Order ${name} has been partially shipped.`;
    if (trackingNum) {
      statusLine += ` Tracking: ${trackingNum}`;
      if (trackingCompany) statusLine += ` (${trackingCompany})`;
      statusLine += '.';
    }
    statusLine += ' Remaining items will ship separately.';
  } else if (financial_status === 'pending' || financial_status === 'authorized') {
    statusLine = `Order ${name} is pending payment confirmation. Once payment clears it will be processed for shipment.`;
  } else {
    // unfulfilled + paid
    statusLine = `Order ${name} has been received and is being prepared for shipment. You will receive a shipping confirmation email once it ships.`;
  }

  const context = `${statusLine} Order contains: ${itemSummary}${shipTo}. For questions, contact support at support@lilacomposter.com.`;

  return { context, tracking_url: trackingUrl };
}

function json(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
