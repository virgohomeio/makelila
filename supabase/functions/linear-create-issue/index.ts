// Feature 3: create a Linear issue from a Service ticket.
// POST body: { ticket_id, team_key, title, description }
// Returns:   { url, identifier }
// LINEAR_API_KEY must be set in Supabase edge-function secrets.

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
  const linearKey   = Deno.env.get('LINEAR_API_KEY');
  if (!supabaseUrl || !serviceKey || !linearKey) return j({ error: 'Missing env vars' }, 500);

  const admin = createClient(supabaseUrl, serviceKey);

  let caller;
  try { caller = await authenticate(req, admin); }
  catch (e) { if (e instanceof Response) return e; throw e; }
  if (caller.kind !== 'user') return j({ error: 'Operator JWT required' }, 403);

  const { ticket_id, team_key, title, description } = await req.json() as {
    ticket_id: string; team_key: string; title: string; description?: string;
  };
  if (!ticket_id || !team_key || !title) return j({ error: 'ticket_id, team_key, title required' }, 400);

  const { data: ticket } = await admin
    .from('service_tickets')
    .select('id, ticket_number')
    .eq('id', ticket_id)
    .single();
  if (!ticket) return j({ error: 'Ticket not found' }, 404);

  // Resolve Linear team ID from key.
  const teamsRes = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: linearKey },
    body: JSON.stringify({ query: '{ teams { nodes { id key } } }' }),
  });
  const teamsJson = await teamsRes.json() as { data?: { teams?: { nodes?: { id: string; key: string }[] } } };
  const team = teamsJson?.data?.teams?.nodes?.find(t => t.key === team_key);
  if (!team) return j({ error: `Linear team '${team_key}' not found` }, 400);

  const body = description
    ? `${description}\n\n---\n*From makeLILA ticket ${ticket.ticket_number}*`
    : `*From makeLILA ticket ${ticket.ticket_number}*`;

  const createRes = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: linearKey },
    body: JSON.stringify({
      query: `mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id url identifier }
        }
      }`,
      variables: { input: { teamId: team.id, title, description: body } },
    }),
  });
  const createJson = await createRes.json() as {
    data?: { issueCreate?: { success: boolean; issue?: { id: string; url: string; identifier: string } } };
    errors?: unknown[];
  };
  const issue = createJson?.data?.issueCreate?.issue;
  if (!issue) return j({ error: 'Linear issue creation failed', detail: JSON.stringify(createJson) }, 500);

  await admin.from('service_tickets').update({ linear_issue_url: issue.url }).eq('id', ticket_id);

  return j({ url: issue.url, identifier: issue.identifier }, 200);
}

function j(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
