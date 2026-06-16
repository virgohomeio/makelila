// Feature 3: inbound Linear webhook.
// Verifies HMAC-SHA256 signature (Linear sends X-Linear-Signature).
// On issue state change to "Done" or "Cancelled", finds the service_ticket
// by linear_issue_url and stamps engineering_resolved_at.
// LINEAR_WEBHOOK_SECRET must be set in Supabase edge-function secrets.
// Register this URL as a Linear webhook for "Issue" events.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-linear-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  try { return await handle(req); }
  catch (err) {
    return new Response(
      JSON.stringify({ error: `Uncaught: ${(err as Error)?.message ?? String(err)}` }),
      { status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' } },
    );
  }
});

async function handle(req: Request): Promise<Response> {
  const supabaseUrl     = Deno.env.get('SUPABASE_URL');
  const serviceKey      = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const webhookSecret   = Deno.env.get('LINEAR_WEBHOOK_SECRET');
  if (!supabaseUrl || !serviceKey || !webhookSecret) return j({ error: 'Missing env vars' }, 500);

  const rawBody = await req.text();

  // Verify HMAC-SHA256 signature.
  const sig = req.headers.get('x-linear-signature') ?? '';
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (sig !== expected) return j({ error: 'Invalid signature' }, 401);

  const payload = JSON.parse(rawBody) as {
    type?: string;
    action?: string;
    data?: {
      id?: string;
      url?: string;
      state?: { type?: string; name?: string };
      updatedFrom?: { state?: unknown };
    };
  };

  if (payload.type !== 'Issue' || payload.action !== 'update') return j({ ok: true }, 200);

  const stateType = payload.data?.state?.type;
  // Linear state types: "completed" (Done), "cancelled" (Cancelled)
  if (stateType !== 'completed' && stateType !== 'cancelled') return j({ ok: true }, 200);

  const issueUrl = payload.data?.url;
  if (!issueUrl) return j({ ok: true }, 200);

  const admin = createClient(supabaseUrl, serviceKey);

  const { data: ticket } = await admin
    .from('service_tickets')
    .select('id, closed_at')
    .eq('linear_issue_url', issueUrl)
    .maybeSingle();
  if (!ticket || ticket.closed_at) return j({ ok: true }, 200);

  const resolvedAt = new Date().toISOString();
  await admin
    .from('service_tickets')
    .update({ engineering_resolved_at: resolvedAt })
    .eq('id', ticket.id);

  return j({ ok: true }, 200);
}

function j(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
