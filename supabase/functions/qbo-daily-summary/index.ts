// Aggregate yesterday's sales/refund data and post a daily journal entry to QBO.
//
// Runs once per day via pg_cron. Gracefully no-ops when QBO credentials are
// not configured so the function deploys without blocking other pipelines.
//
// Required env vars:
//   SUPABASE_URL              — makeLILA project URL
//   SUPABASE_SERVICE_ROLE_KEY — service role for makeLILA reads/writes
//   CRON_SHARED_SECRET        — cron auth header secret
//   QBO_CLIENT_ID             — QuickBooks OAuth2 client ID
//   QBO_CLIENT_SECRET         — QuickBooks OAuth2 client secret
//   QBO_REALM_ID              — QuickBooks company realm ID
//
// Auth: cron-only (X-Cron-Secret header required, matching CRON_SHARED_SECRET).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { authenticate } from '../_shared/auth.ts';

// Inline corsHeaders — avoids module-resolution issues at deploy time.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// QBO API base URL (production).
const QBO_API_BASE = 'https://quickbooks.api.intuit.com/v3/company';
const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

// ============================================================ Entry point

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  try { return await handle(req); }
  catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    return jsonResponse({ error: `Uncaught: ${msg}` }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500);
  }

  const admin = createClient(supabaseUrl, serviceKey);

  let _caller;
  try { _caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }

  if (_caller.kind !== 'cron') {
    return new Response(
      JSON.stringify({ error: 'This function is cron-only — use the X-Cron-Secret header.' }),
      { status: 403, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } },
    );
  }

  // Graceful no-op when QBO credentials are not configured.
  const qboClientId     = Deno.env.get('QBO_CLIENT_ID');
  const qboClientSecret = Deno.env.get('QBO_CLIENT_SECRET');
  const qboRealmId      = Deno.env.get('QBO_REALM_ID');

  if (!qboClientId || !qboClientSecret || !qboRealmId) {
    return jsonResponse({
      skipped: true,
      reason: 'QBO credentials not configured',
    }, 200);
  }

  // ── Step 1: Read QBO OAuth tokens ─────────────────────────────────────────

  const { data: oauthRows, error: oauthErr } = await admin
    .from('qbo_oauth')
    .select('*')
    .limit(1);

  if (oauthErr) {
    return jsonResponse({ error: `Failed to read qbo_oauth: ${oauthErr.message}` }, 500);
  }

  const oauthRow = (oauthRows ?? [])[0] as {
    qbo_access_token: string;
    qbo_refresh_token: string;
    access_token_expires_at: string;
  } | undefined;

  if (!oauthRow) {
    return jsonResponse({
      skipped: true,
      reason: 'No QBO OAuth row — run initial authorization first',
    }, 200);
  }

  // ── Step 2: Refresh access token if within 5 minutes of expiry ────────────

  let accessToken = oauthRow.qbo_access_token;
  const expiresAt = new Date(oauthRow.access_token_expires_at).getTime();
  const fiveMinMs = 5 * 60 * 1000;

  if (Date.now() >= expiresAt - fiveMinMs) {
    const credentials = btoa(`${qboClientId}:${qboClientSecret}`);
    const tokenRes = await fetch(QBO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: oauthRow.qbo_refresh_token,
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      return jsonResponse({ error: `Token refresh failed: ${errText}` }, 500);
    }

    const tokenData = await tokenRes.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    accessToken = tokenData.access_token;
    const newExpiry = new Date(Date.now() + 3600 * 1000).toISOString();

    const updatePayload: Record<string, string> = {
      qbo_access_token: accessToken,
      access_token_expires_at: newExpiry,
    };
    // Refresh token may rotate — persist the new one if provided.
    if (tokenData.refresh_token) {
      updatePayload.qbo_refresh_token = tokenData.refresh_token;
    }

    const { error: updateErr } = await admin
      .from('qbo_oauth')
      .update(updatePayload)
      .not('qbo_access_token', 'is', null); // target the single row

    if (updateErr) {
      console.error('Failed to persist refreshed token:', updateErr.message);
      // Non-fatal — continue with the new in-memory token.
    }
  }

  // ── Step 3: Determine yesterday's date ────────────────────────────────────

  const today     = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const yyyyMMDD  = yesterday.toISOString().slice(0, 10); // YYYY-MM-DD
  const dayStart  = `${yyyyMMDD}T00:00:00Z`;
  const dayEnd    = `${yyyyMMDD}T23:59:59Z`;

  // ── Step 4: Aggregate orders for yesterday ────────────────────────────────

  const { data: orderRows, error: orderErr } = await admin
    .from('orders')
    .select('currency, payment_channel, total, discount_total, shipping_total, tax_total, kind, status')
    .gte('created_at', dayStart)
    .lte('created_at', dayEnd)
    .neq('kind', 'replacement')
    .not('status', 'in', '("cancelled")');

  if (orderErr) {
    return jsonResponse({ error: `Failed to query orders: ${orderErr.message}` }, 500);
  }

  // Group by (currency, payment_channel).
  const salesMap = new Map<string, {
    currency: string;
    payment_channel: string;
    gross_sales: number;
    discounts: number;
    shipping: number;
    tax_collected: number;
  }>();

  for (const row of (orderRows ?? []) as Array<Record<string, unknown>>) {
    const currency        = (row.currency as string | null) ?? 'CAD';
    const payment_channel = (row.payment_channel as string | null) ?? 'unknown';
    const key             = `${currency}||${payment_channel}`;

    const existing = salesMap.get(key) ?? {
      currency,
      payment_channel,
      gross_sales: 0,
      discounts: 0,
      shipping: 0,
      tax_collected: 0,
    };

    existing.gross_sales  += Number(row.total          ?? 0);
    existing.discounts    += Number(row.discount_total ?? 0);
    existing.shipping     += Number(row.shipping_total ?? 0);
    existing.tax_collected += Number(row.tax_total     ?? 0);

    salesMap.set(key, existing);
  }

  // ── Step 5: Aggregate refunds for yesterday ───────────────────────────────

  const { data: returnRows, error: returnErr } = await admin
    .from('returns')
    .select('currency, payment_channel, refund_amount')
    .gte('refunded_at', dayStart)
    .lte('refunded_at', dayEnd)
    .not('refund_amount', 'is', null);

  if (returnErr) {
    return jsonResponse({ error: `Failed to query returns: ${returnErr.message}` }, 500);
  }

  // Accumulate refunds into the same (currency, payment_channel) buckets.
  const refundMap = new Map<string, number>();

  for (const row of (returnRows ?? []) as Array<Record<string, unknown>>) {
    const currency        = (row.currency as string | null) ?? 'CAD';
    const payment_channel = (row.payment_channel as string | null) ?? 'unknown';
    const key             = `${currency}||${payment_channel}`;
    refundMap.set(key, (refundMap.get(key) ?? 0) + Number(row.refund_amount ?? 0));
  }

  // Merge any refund-only keys (no matching sales bucket).
  for (const [key, refundAmt] of refundMap) {
    if (!salesMap.has(key)) {
      const [currency, payment_channel] = key.split('||');
      salesMap.set(key, {
        currency,
        payment_channel,
        gross_sales: 0,
        discounts: 0,
        shipping: 0,
        tax_collected: 0,
      });
    }
    // Refunds are stored separately — do not add to the sales bucket totals.
    void refundAmt; // consumed below during upsert
  }

  // ── Step 6: Upsert into qbo_daily_journals ────────────────────────────────

  const journalRows = [...salesMap.entries()].map(([key, sales]) => {
    const refunds    = refundMap.get(key) ?? 0;
    const fees       = 0; // placeholder — not tracked yet
    const net_deposit = sales.gross_sales - sales.discounts - refunds - fees;

    return {
      date: yyyyMMDD,
      currency: sales.currency,
      payment_channel: sales.payment_channel,
      gross_sales: sales.gross_sales,
      discounts: sales.discounts,
      refunds,
      tax_collected: sales.tax_collected,
      shipping: sales.shipping,
      fees,
      net_deposit,
    };
  });

  if (journalRows.length > 0) {
    const { error: upsertErr } = await admin
      .from('qbo_daily_journals')
      .upsert(journalRows, { onConflict: 'date,currency,payment_channel', ignoreDuplicates: false });

    if (upsertErr) {
      return jsonResponse({ error: `Failed to upsert qbo_daily_journals: ${upsertErr.message}` }, 500);
    }
  }

  const rowsUpserted = journalRows.length;

  // ── Step 7: Post unposted rows to QBO ─────────────────────────────────────

  const { data: unpostedRows, error: unpostedErr } = await admin
    .from('qbo_daily_journals')
    .select('id, date, currency, payment_channel, net_deposit, gross_sales')
    .eq('date', yyyyMMDD)
    .is('qbo_journal_id', null);

  if (unpostedErr) {
    return jsonResponse({ error: `Failed to fetch unposted rows: ${unpostedErr.message}` }, 500);
  }

  let rowsPosted = 0;
  let rowsFailed = 0;

  for (const row of (unpostedRows ?? []) as Array<Record<string, unknown>>) {
    const rowId          = row.id as string;
    const date           = row.date as string;
    const currency       = (row.currency as string) ?? 'CAD';
    const paymentChannel = (row.payment_channel as string) ?? 'unknown';
    const netDeposit     = Number(row.net_deposit ?? 0);
    const grossSales     = Number(row.gross_sales ?? 0);

    const docNumber = `LILA-${date}-${currency}-${paymentChannel}`;

    // TODO(George): replace GL account refs with real QBO chart-of-accounts IDs.
    const journalPayload = {
      DocNumber: docNumber,
      TxnDate: date,
      CurrencyRef: { value: currency },
      Line: [
        {
          Amount: netDeposit,
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: {
            PostingType: 'Debit',
            AccountRef: { value: '1' }, // TODO(George): replace with real QBO account ID (e.g. bank/AR)
          },
        },
        {
          Amount: grossSales,
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: {
            PostingType: 'Credit',
            AccountRef: { value: '2' }, // TODO(George): replace with real QBO account ID (e.g. revenue)
          },
        },
      ],
    };

    const qboRes = await fetch(
      `${QBO_API_BASE}/${qboRealmId}/journalentry?minorversion=65`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(journalPayload),
      },
    );

    if (qboRes.ok) {
      const qboData = await qboRes.json() as { JournalEntry?: { Id?: string } };
      const journalId = qboData?.JournalEntry?.Id ?? null;

      await admin
        .from('qbo_daily_journals')
        .update({
          qbo_journal_id: journalId,
          posted_at: new Date().toISOString(),
          error: null,
        })
        .eq('id', rowId);

      rowsPosted++;
    } else {
      const errText = await qboRes.text();

      await admin
        .from('qbo_daily_journals')
        .update({ error: errText })
        .eq('id', rowId);

      rowsFailed++;
      console.error(`QBO journal post failed for ${docNumber}: ${errText}`);
    }
  }

  // ── Step 8: Return summary ─────────────────────────────────────────────────

  return jsonResponse({
    date: yyyyMMDD,
    rows_upserted: rowsUpserted,
    rows_posted: rowsPosted,
    rows_failed: rowsFailed,
  }, 200);
}

// ============================================================ Response helper

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
