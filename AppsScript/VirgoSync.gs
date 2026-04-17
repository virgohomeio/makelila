/**
 * VirgoHome Operations Hub — Google Apps Script sync layer
 * =========================================================
 *
 * Wires Google Sheets into Shopify and HubSpot so the sheet acts as a
 * near-real-time operational console, closing the biggest gap flagged
 * in architecture.md (no real-time sync).
 *
 *   Shopify webhook   ──► doPost()  ──► append row to "Sales Orders"
 *   Time trigger (15m)──► pullShopifyBackfill()
 *   Time trigger (15m)──► syncHubSpotTickets()
 *   onEdit trigger    ──► pushShopifyFulfillment()  (when Shipped Date filled)
 *
 * Setup — one time:
 *   1. Open the target Google Sheet → Extensions → Apps Script
 *   2. Paste this file into Code.gs
 *   3. Run setCredentials() once after filling in the constants at top of
 *      that function (never commit real tokens to source control).
 *   4. Run installTriggers() once to register the time-based + edit triggers.
 *   5. Run registerShopifyWebhook() once to point Shopify at this script.
 *   6. Authorize the OAuth scopes when prompted.
 *
 * Script-properties keys (set by setCredentials):
 *   SHOPIFY_DOMAIN            e.g. "lilacomposter.myshopify.com"
 *   SHOPIFY_ACCESS_TOKEN      Private app Admin API token (shpat_…)
 *   SHOPIFY_WEBHOOK_SECRET    From Shopify Admin → Settings → Notifications
 *   HUBSPOT_TOKEN             HubSpot private app token (pat-…)
 *   SALES_ORDERS_SHEET        default "Sales Orders"
 *   SERIAL_TRACKER_SHEET      default "Serial Tracker"
 */

// ════════════════════════════════════════════════════════════
// 0. CONSTANTS & COLUMN MAP
// ════════════════════════════════════════════════════════════

const SHEET_SO = 'Sales Orders';
const SHEET_ST = 'Serial Tracker';
const HEADER_ROW = 3;          // data starts at row 4
const FIRST_DATA_ROW = 4;

// 1-based column indices in the Sales Orders tab (matches MRP schema)
const SO = {
  NUMBER: 1, DATE: 2, CHANNEL: 3, CHANNEL_ORDER_ID: 4,
  CUSTOMER_NAME: 5, CUSTOMER_EMAIL: 6, PRODUCTS: 7, QTY: 8,
  TOTAL: 9, CURRENCY: 10, STATUS: 11, PAYMENT_STATUS: 12,
  FULFILLMENT_STATUS: 13, WAREHOUSE: 14, MO_REF: 15,
  SHIP_BY: 16, SHIPPED_DATE: 17, TRACKING: 18, NOTES: 19,
  RETURN_STATUS: 20, RMA: 21, RETURN_REASON: 22
};

// ════════════════════════════════════════════════════════════
// 1. ONE-TIME SETUP
// ════════════════════════════════════════════════════════════

/** Run once manually after pasting real values. */
function setCredentials() {
  const props = PropertiesService.getScriptProperties();
  props.setProperties({
    SHOPIFY_DOMAIN: 'lilacomposter.myshopify.com',
    SHOPIFY_ACCESS_TOKEN: 'shpat_REPLACE_ME',
    SHOPIFY_WEBHOOK_SECRET: 'REPLACE_ME',
    HUBSPOT_TOKEN: 'pat-REPLACE_ME'
  });
  SpreadsheetApp.getUi().alert('Credentials saved to script properties.');
}

/** Install all triggers. Run once. */
function installTriggers() {
  // Remove any prior triggers first
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // Scheduled backfill every 15 min (catches any missed webhooks)
  ScriptApp.newTrigger('pullShopifyBackfill')
    .timeBased().everyMinutes(15).create();

  // HubSpot ticket sync every 15 min
  ScriptApp.newTrigger('syncHubSpotTickets')
    .timeBased().everyMinutes(15).create();

  // onEdit for fulfillment push-back
  ScriptApp.newTrigger('onEditHandler')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onEdit().create();

  SpreadsheetApp.getUi().alert('Triggers installed.');
}

/** Register the Shopify webhook pointing at this script's /exec URL. */
function registerShopifyWebhook() {
  const scriptUrl = ScriptApp.getService().getUrl();
  if (!scriptUrl) {
    throw new Error('Deploy as Web App first: Deploy → New deployment → Web app, access "Anyone".');
  }
  const domain = props_('SHOPIFY_DOMAIN');
  const token = props_('SHOPIFY_ACCESS_TOKEN');

  const body = { webhook: { topic: 'orders/create', address: scriptUrl, format: 'json' } };
  const res = UrlFetchApp.fetch(`https://${domain}/admin/api/2024-01/webhooks.json`, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Shopify-Access-Token': token },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  Logger.log(res.getContentText());
  SpreadsheetApp.getUi().alert('Shopify webhook registered at ' + scriptUrl);
}

// ════════════════════════════════════════════════════════════
// 2. SHOPIFY → SHEET (webhook handler)
// ════════════════════════════════════════════════════════════

/** HTTP POST entrypoint. Shopify hits this when a new order is created. */
function doPost(e) {
  try {
    if (!verifyShopifyHmac_(e)) {
      return ContentService.createTextOutput('bad hmac').setMimeType(ContentService.MimeType.TEXT);
    }
    const order = JSON.parse(e.postData.contents);
    upsertShopifyOrder_(order);
    return ContentService.createTextOutput('ok');
  } catch (err) {
    Logger.log('doPost error: ' + err.stack);
    return ContentService.createTextOutput('err').setMimeType(ContentService.MimeType.TEXT);
  }
}

/** HMAC SHA-256 verification using the webhook secret. */
function verifyShopifyHmac_(e) {
  const secret = props_('SHOPIFY_WEBHOOK_SECRET');
  const headerHmac = e.parameter ? e.parameter['X-Shopify-Hmac-Sha256'] : null
                  || (e.headers && e.headers['X-Shopify-Hmac-Sha256']);
  if (!headerHmac || !e.postData) return false;
  const computed = Utilities.computeHmacSha256Signature(
    e.postData.contents, secret, Utilities.Charset.UTF_8);
  const base64 = Utilities.base64Encode(computed);
  return timingSafeEqual_(base64, headerHmac);
}

function timingSafeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Insert-or-update a row keyed on Shopify order number. */
function upsertShopifyOrder_(order) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_SO);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const orderNumber = '#' + order.order_number;
    const existingRow = findRowByValue_(sheet, SO.NUMBER, orderNumber);
    const row = rowFromShopifyOrder_(order);
    if (existingRow) {
      sheet.getRange(existingRow, 1, 1, row.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }
  } finally {
    lock.releaseLock();
  }
}

/** Shape a Shopify order JSON payload into a row matching the SO schema. */
function rowFromShopifyOrder_(o) {
  const customerName = [o.customer && o.customer.first_name, o.customer && o.customer.last_name]
    .filter(Boolean).join(' ').trim() || (o.shipping_address && o.shipping_address.name) || '';
  const skus = (o.line_items || []).map(li => li.sku || li.title).join(', ');
  const qty = (o.line_items || []).reduce((s, li) => s + (li.quantity || 0), 0);
  const paid = (o.financial_status || '').toLowerCase();
  const fulfilled = (o.fulfillment_status || 'unfulfilled').toLowerCase();

  const row = new Array(22).fill('');
  row[SO.NUMBER - 1]            = '#' + o.order_number;
  row[SO.DATE - 1]              = (o.created_at || '').slice(0, 10);
  row[SO.CHANNEL - 1]           = 'Shopify';
  row[SO.CHANNEL_ORDER_ID - 1]  = '#' + o.order_number;
  row[SO.CUSTOMER_NAME - 1]     = customerName;
  row[SO.CUSTOMER_EMAIL - 1]    = o.email || (o.customer && o.customer.email) || '';
  row[SO.PRODUCTS - 1]          = skus;
  row[SO.QTY - 1]               = qty;
  row[SO.TOTAL - 1]             = parseFloat(o.total_price || '0');
  row[SO.CURRENCY - 1]          = o.currency || 'USD';
  row[SO.STATUS - 1]            = fulfilled === 'fulfilled' ? 'Delivered' : 'Open';
  row[SO.PAYMENT_STATUS - 1]    = paid === 'paid' ? 'Paid' : (paid === 'refunded' ? 'Refunded' : 'Unpaid');
  row[SO.FULFILLMENT_STATUS - 1] = fulfilled === 'fulfilled' ? 'Fulfilled'
                                 : fulfilled === 'partial' ? 'Partial' : 'Unfulfilled';
  row[SO.NOTES - 1]             = (o.note || '') + (o.shipping_lines && o.shipping_lines[0]
                                   ? ' | ' + o.shipping_lines[0].title : '');
  return row;
}

// ════════════════════════════════════════════════════════════
// 3. SCHEDULED BACKFILL (safety net for missed webhooks)
// ════════════════════════════════════════════════════════════

function pullShopifyBackfill() {
  const domain = props_('SHOPIFY_DOMAIN');
  const token = props_('SHOPIFY_ACCESS_TOKEN');
  // Pull orders updated in the last 30 min — narrow window keeps API quota low
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const url = `https://${domain}/admin/api/2024-01/orders.json`
    + `?status=any&updated_at_min=${encodeURIComponent(since)}&limit=50`;
  const res = UrlFetchApp.fetch(url, {
    headers: { 'X-Shopify-Access-Token': token },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    Logger.log('Shopify backfill failed: ' + res.getContentText());
    return;
  }
  const { orders } = JSON.parse(res.getContentText());
  (orders || []).forEach(upsertShopifyOrder_);
  Logger.log('Backfilled ' + (orders || []).length + ' orders');
}

// ════════════════════════════════════════════════════════════
// 4. HUBSPOT → SERIAL TRACKER (ticket sync)
// ════════════════════════════════════════════════════════════

function syncHubSpotTickets() {
  const token = props_('HUBSPOT_TOKEN');
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_ST);
  if (!sheet) return;

  // Pull open tickets updated recently
  const body = {
    filterGroups: [{ filters: [
      { propertyName: 'hs_pipeline_stage', operator: 'NEQ', value: '4' }
    ]}],
    properties: ['subject', 'content', 'hs_pipeline_stage', 'hs_ticket_id',
                 'serial_number', 'customer_name', 'hs_lastmodifieddate'],
    limit: 100,
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }]
  };
  const res = UrlFetchApp.fetch('https://api.hubapi.com/crm/v3/objects/tickets/search', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    Logger.log('HubSpot ticket pull failed: ' + res.getContentText());
    return;
  }
  const tickets = (JSON.parse(res.getContentText()).results) || [];

  // Build a map: customer-name-normalized → HS-ID. Apply to Serial Tracker rows.
  const byName = {};
  tickets.forEach(t => {
    const id = 'HS-' + String(t.id).padStart(4, '0');
    const name = (t.properties.customer_name || '').toLowerCase().trim();
    const serial = (t.properties.serial_number || '').trim();
    if (serial) byName['serial:' + serial] = id;
    else if (name) byName['name:' + name] = id;
  });

  // Update the HubSpot Ticket column (M = col 13) where we find a match
  const range = sheet.getRange(FIRST_DATA_ROW, 1, Math.max(1, sheet.getLastRow() - HEADER_ROW), 13);
  const values = range.getValues();
  let updates = 0;
  for (let i = 0; i < values.length; i++) {
    const serial = String(values[i][0] || '').trim();
    const name = String(values[i][5] || '').toLowerCase().trim();
    const hit = byName['serial:' + serial] || byName['name:' + name];
    if (hit && values[i][12] !== hit) {
      values[i][12] = hit;
      updates++;
    }
  }
  if (updates) range.setValues(values);
  Logger.log(`HubSpot sync: ${tickets.length} tickets scanned, ${updates} rows updated`);
}

// ════════════════════════════════════════════════════════════
// 5. SHEET → SHOPIFY (fulfillment push-back on edit)
// ════════════════════════════════════════════════════════════

/**
 * Fires whenever the user edits the sheet. When they fill in both
 * Shipped Date (col Q = 17) and Tracking Number (col R = 18) on an SO row,
 * we push a fulfillment to Shopify so the customer gets their notification.
 */
function onEditHandler(e) {
  const sheet = e.range.getSheet();
  if (sheet.getName() !== SHEET_SO) return;
  const row = e.range.getRow();
  if (row < FIRST_DATA_ROW) return;

  const col = e.range.getColumn();
  if (col !== SO.SHIPPED_DATE && col !== SO.TRACKING) return;

  const values = sheet.getRange(row, 1, 1, 22).getValues()[0];
  const orderNumber = values[SO.CHANNEL_ORDER_ID - 1]; // "#1111"
  const shippedDate = values[SO.SHIPPED_DATE - 1];
  const tracking = values[SO.TRACKING - 1];
  if (!orderNumber || !shippedDate || !tracking) return;   // not ready yet
  if (values[SO.FULFILLMENT_STATUS - 1] === 'Fulfilled') return; // idempotent

  pushShopifyFulfillment_(orderNumber, tracking);
  sheet.getRange(row, SO.FULFILLMENT_STATUS).setValue('Fulfilled');
  sheet.getRange(row, SO.STATUS).setValue('Delivered');
}

function pushShopifyFulfillment_(orderNumber, trackingNumber) {
  const domain = props_('SHOPIFY_DOMAIN');
  const token = props_('SHOPIFY_ACCESS_TOKEN');
  // 1. Look up the Shopify order ID by name
  const search = UrlFetchApp.fetch(
    `https://${domain}/admin/api/2024-01/orders.json?name=${encodeURIComponent(orderNumber)}&status=any`,
    { headers: { 'X-Shopify-Access-Token': token }, muteHttpExceptions: true });
  const { orders } = JSON.parse(search.getContentText());
  if (!orders || !orders[0]) { Logger.log('Order not found: ' + orderNumber); return; }
  const order = orders[0];

  // 2. Get the fulfillment orders (required input for fulfillment_v2)
  const foRes = UrlFetchApp.fetch(
    `https://${domain}/admin/api/2024-01/orders/${order.id}/fulfillment_orders.json`,
    { headers: { 'X-Shopify-Access-Token': token }, muteHttpExceptions: true });
  const { fulfillment_orders } = JSON.parse(foRes.getContentText());
  if (!fulfillment_orders || !fulfillment_orders.length) return;

  // 3. Create fulfillment with tracking
  const payload = {
    fulfillment: {
      notify_customer: true,
      tracking_info: { number: trackingNumber, company: guessCarrier_(trackingNumber) },
      line_items_by_fulfillment_order: fulfillment_orders.map(fo => ({ fulfillment_order_id: fo.id }))
    }
  };
  UrlFetchApp.fetch(`https://${domain}/admin/api/2024-01/fulfillments.json`, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Shopify-Access-Token': token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}

function guessCarrier_(tracking) {
  if (/^1Z/.test(tracking)) return 'UPS';
  if (/^D\d{10,}/.test(tracking)) return 'Canpar';
  if (/^\d{12}$/.test(tracking)) return 'FedEx';
  if (/^52/.test(tracking)) return 'Purolator';
  return 'Other';
}

// ════════════════════════════════════════════════════════════
// 6. UTILITIES
// ════════════════════════════════════════════════════════════

function props_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('Missing script property: ' + key + ' — run setCredentials() first.');
  return v;
}

function findRowByValue_(sheet, col, value) {
  const last = sheet.getLastRow();
  if (last < FIRST_DATA_ROW) return null;
  const values = sheet.getRange(FIRST_DATA_ROW, col, last - HEADER_ROW, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === String(value).trim()) return FIRST_DATA_ROW + i;
  }
  return null;
}

/** Custom menu — appears in the sheet's top bar. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('VirgoSync')
    .addItem('1. Set credentials', 'setCredentials')
    .addItem('2. Install triggers', 'installTriggers')
    .addItem('3. Register Shopify webhook', 'registerShopifyWebhook')
    .addSeparator()
    .addItem('Run Shopify backfill now', 'pullShopifyBackfill')
    .addItem('Run HubSpot sync now', 'syncHubSpotTickets')
    .addToUi();
}
