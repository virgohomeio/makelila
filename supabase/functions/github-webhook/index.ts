// Feature 3: inbound GitHub webhook.
// Verifies X-Hub-Signature-256 (HMAC-SHA256 with GITHUB_WEBHOOK_SECRET).
// On issues.closed event, finds the service_ticket by github_issue_url
// and stamps engineering_resolved_at.
// GITHUB_WEBHOOK_SECRET must be set in Supabase edge-function secrets.
// Register this URL as a GitHub repo webhook for "Issues" events.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-hub-signature-256, x-github-event',
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
  const supabaseUrl   = Deno.env.get('SUPABASE_URL');
  const serviceKey    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const webhookSecret = Deno.env.get('GITHUB_WEBHOOK_SECRET');
  if (!supabaseUrl || !serviceKey || !webhookSecret) return j({ error: 'Missing env vars' }, 500);

  const rawBody = await req.text();

  // Verify X-Hub-Signature-256: "sha256=<hex>"
  const sigHeader = req.headers.get('x-hub-signature-256') ?? '';
  const sigHex = sigHeader.replace(/^sha256=/, '');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (sigHex !== expected) return j({ error: 'Invalid signature' }, 401);

  const event = req.headers.get('x-github-event');
  if (event !== 'issues') return j({ ok: true }, 200);

  const payload = JSON.parse(rawBody) as {
    action?: string;
    issue?: { html_url?: string; state?: string };
  };
  if (payload.action !== 'closed') return j({ ok: true }, 200);

  const issueUrl = payload.issue?.html_url;
  if (!issueUrl) return j({ ok: true }, 200);

  const admin = createClient(supabaseUrl, serviceKey);

  const { data: ticket } = await admin
    .from('service_tickets')
    .select('id, closed_at')
    .eq('github_issue_url', issueUrl)
    .maybeSingle();
  if (!ticket || ticket.closed_at) return j({ ok: true }, 200);

  await admin
    .from('service_tickets')
    .update({ engineering_resolved_at: new Date().toISOString() })
    .eq('id', ticket.id);

  return j({ ok: true }, 200);
}

function j(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
