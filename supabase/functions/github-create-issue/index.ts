// Feature 3: create a GitHub issue from a Service ticket.
// POST body: { ticket_id, repo, title, body }
//   repo format: "owner/repo" e.g. "virgohomeio/lila-firmware"
// Returns:   { url }
// GITHUB_PAT must be set in Supabase edge-function secrets.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { corsHeaders } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

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
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const githubPat   = Deno.env.get('GITHUB_PAT');
  if (!supabaseUrl || !serviceKey || !githubPat) return j({ error: 'Missing env vars' }, 500);

  const admin = createClient(supabaseUrl, serviceKey);

  let caller;
  try { caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  if (caller.kind !== 'user') return j({ error: 'Operator JWT required' }, 403);

  const { ticket_id, repo, title, body } = await req.json() as {
    ticket_id: string; repo: string; title: string; body?: string;
  };
  if (!ticket_id || !repo || !title) return j({ error: 'ticket_id, repo, title required' }, 400);
  if (!repo.includes('/')) return j({ error: 'repo must be "owner/repo" format' }, 400);

  const { data: ticket } = await admin
    .from('service_tickets')
    .select('id, ticket_number')
    .eq('id', ticket_id)
    .single();
  if (!ticket) return j({ error: 'Ticket not found' }, 404);

  const issueBody = body
    ? `${body}\n\n---\n*From makeLILA ticket ${ticket.ticket_number}*`
    : `*From makeLILA ticket ${ticket.ticket_number}*`;

  const ghRes = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${githubPat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ title, body: issueBody }),
  });
  if (!ghRes.ok) {
    const detail = await ghRes.text();
    return j({ error: `GitHub API error: ${ghRes.status}`, detail }, ghRes.status >= 500 ? 500 : 400);
  }
  const ghJson = await ghRes.json() as { html_url: string };
  const url = ghJson.html_url;

  await admin.from('service_tickets').update({ github_issue_url: url }).eq('id', ticket_id);

  return j({ url }, 200);
}

function j(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
